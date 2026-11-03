import { randomBytes, randomUUID } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';

// Compatibility regression for the local S3 server (RustFS, TD-02): the
// behaviors the upload/playback flows depend on, checked against the real
// storage service provisioned by `storage-init`.

const ALLOWED_ORIGIN = 'http://localhost:3001'; // docker/storage/cors.json
const PART_1_SIZE = 5 * 1024 * 1024; // S3 minimum for a non-final part
const PART_2_SIZE = 1024;
const TOTAL_SIZE = PART_1_SIZE + PART_2_SIZE;

describe('RustFS S3 compatibility (spike)', () => {
  const config = storageConfig();
  const bucket = config.bucket;
  const prefix = `test/spike/${randomUUID()}`;
  let client: S3Client;
  const uploadsToAbort: { key: string; uploadId: string }[] = [];
  const keysToDelete: string[] = [];

  const createUpload = async (key: string): Promise<string> => {
    const { UploadId } = await client.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    uploadsToAbort.push({ key, uploadId: UploadId! });
    return UploadId!;
  };

  const signPart = (
    key: string,
    uploadId: string,
    partNumber: number,
    contentLength: number,
  ): Promise<string> =>
    getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        ContentLength: contentLength,
      }),
      { expiresIn: 3600 },
    );

  beforeAll(() => {
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  });

  afterAll(async () => {
    for (const { key, uploadId } of uploadsToAbort) {
      try {
        await client.send(
          new AbortMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
          }),
        );
      } catch {
        // Already completed → NoSuchUpload; nothing to abort.
      }
    }
    for (const key of keysToDelete) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    client.destroy();
  });

  describe('presigned multipart upload', () => {
    const key = `${prefix}/multipart/original`;

    it('should accept presigned part PUTs, complete from ListParts and report the full size', async () => {
      const uploadId = await createUpload(key);
      const parts = [randomBytes(PART_1_SIZE), randomBytes(PART_2_SIZE)];

      for (const [index, body] of parts.entries()) {
        const url = await signPart(key, uploadId, index + 1, body.length);
        const response = await fetch(url, { method: 'PUT', body });

        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).toBeTruthy();
      }

      const listed = await client.send(
        new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
      );
      expect(listed.Parts?.map((p) => p.PartNumber)).toEqual([1, 2]);

      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: listed.Parts!.map((p) => ({
              PartNumber: p.PartNumber,
              ETag: p.ETag,
            })),
          },
        }),
      );
      keysToDelete.push(key);

      const head = await client.send(
        new HeadObjectCommand({ Bucket: bucket, Key: key }),
      );
      expect(head.ContentLength).toBe(TOTAL_SIZE);
    });

    it('should reject a part whose body size differs from the signed ContentLength', async () => {
      const mismatchKey = `${prefix}/mismatch/original`;
      const uploadId = await createUpload(mismatchKey);
      const url = await signPart(mismatchKey, uploadId, 1, PART_2_SIZE);

      const response = await fetch(url, {
        method: 'PUT',
        body: randomBytes(PART_2_SIZE + 1),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    });
  });

  describe('bucket CORS', () => {
    const key = `${prefix}/cors/original`;

    it('should expose ETag to an allowed origin on a part PUT', async () => {
      const uploadId = await createUpload(key);
      const url = await signPart(key, uploadId, 1, PART_2_SIZE);

      const response = await fetch(url, {
        method: 'PUT',
        body: randomBytes(PART_2_SIZE),
        headers: { Origin: ALLOWED_ORIGIN },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        ALLOWED_ORIGIN,
      );
      expect(
        response.headers.get('access-control-expose-headers')?.toLowerCase(),
      ).toContain('etag');
    });

    it('should answer the PUT preflight for an allowed origin with 2xx', async () => {
      const uploadId = await createUpload(`${key}-preflight`);
      const url = await signPart(`${key}-preflight`, uploadId, 1, PART_2_SIZE);

      const response = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'PUT',
        },
      });

      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      expect(response.headers.get('access-control-allow-origin')).toBe(
        ALLOWED_ORIGIN,
      );
    });
  });

  describe('ranged GET', () => {
    const key = `${prefix}/range/original`;

    it('should return 206 with Content-Range and exactly the requested bytes', async () => {
      const uploadId = await createUpload(key);
      const body = randomBytes(PART_2_SIZE);
      const partUrl = await signPart(key, uploadId, 1, body.length);
      const put = await fetch(partUrl, { method: 'PUT', body });
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [{ PartNumber: 1, ETag: put.headers.get('etag')! }],
          },
        }),
      );
      keysToDelete.push(key);

      const getUrl = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: 300 },
      );
      const response = await fetch(getUrl, {
        headers: { Range: 'bytes=0-99' },
      });
      const received = Buffer.from(await response.arrayBuffer());

      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(
        `bytes 0-99/${body.length}`,
      );
      expect(received.length).toBe(100);
      expect(received.equals(body.subarray(0, 100))).toBe(true);
    });
  });
});
