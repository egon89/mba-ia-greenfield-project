import { randomBytes, randomUUID } from 'node:crypto';
import { S3Client, UploadPartCommand } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import {
  videoOriginalKey,
  videoPrefix,
  videoThumbnailKey,
} from './storage-keys';
import { S3_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIN_PART_SIZE = 5 * 1024 * 1024; // S3 minimum for a non-final part
const PRESIGN_TTL_SECONDS = 300;

describe('StorageService (integration)', () => {
  const config = storageConfig();
  let module: TestingModule;
  let storage: StorageService;
  let internalClient: S3Client;
  // Every test uses its own video id under a run-scoped namespace.
  const runId = randomUUID();
  const newVideoId = (): string => `test-${runId}-${randomUUID()}`;
  const usedIds: string[] = [];

  // Setup helper: part URLs are signed for the public host (localhost on the
  // developer's machine), which this container cannot reach, so parts are
  // uploaded through the internal client instead.
  const uploadPart = async (
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<void> => {
    await internalClient.send(
      new UploadPartCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.length,
      }),
    );
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();
    storage = module.get(StorageService);
    internalClient = module.get(S3_CLIENT);
  });

  afterAll(async () => {
    for (const id of usedIds) {
      await storage.deletePrefix(videoPrefix(id));
    }
    await module.close();
  });

  describe('multipart upload', () => {
    it('should create, list, complete and head a multipart object', async () => {
      const id = newVideoId();
      usedIds.push(id);
      const key = videoOriginalKey(id);
      const bodies = [randomBytes(MIN_PART_SIZE), randomBytes(1024)];

      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      for (const [index, body] of bodies.entries()) {
        await uploadPart(key, uploadId, index + 1, body);
      }
      const parts = await storage.listParts(key, uploadId);
      await storage.completeMultipartUpload(key, uploadId, parts);
      const head = await storage.headObject(key);

      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(head.contentLength).toBe(MIN_PART_SIZE + 1024);
      expect(head.contentType).toBe('video/mp4');
    });

    it('should list all parts with number and size across pages limited to 2', async () => {
      const id = newVideoId();
      usedIds.push(id);
      const key = videoOriginalKey(id);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
      const sizes = [MIN_PART_SIZE, MIN_PART_SIZE, 2048];
      for (const [index, size] of sizes.entries()) {
        await uploadPart(key, uploadId, index + 1, randomBytes(size));
      }

      const parts = await storage.listParts(key, uploadId, 2);

      expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
        [1, MIN_PART_SIZE],
        [2, MIN_PART_SIZE],
        [3, 2048],
      ]);
      expect(parts.every((p) => p.etag.length > 0)).toBe(true);
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should abort an upload and accept a second abort of the same uploadId', async () => {
      const id = newVideoId();
      const key = videoOriginalKey(id);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      await storage.abortMultipartUpload(key, uploadId);

      await expect(
        storage.abortMultipartUpload(key, uploadId),
      ).resolves.toBeUndefined();
    });
  });

  describe('putObject / headObject', () => {
    it('should store an object with its content type', async () => {
      const id = newVideoId();
      usedIds.push(id);
      const key = videoThumbnailKey(id);
      const body = randomBytes(512);

      await storage.putObject(key, body, 'image/jpeg');
      const head = await storage.headObject(key);

      expect(head).toEqual({ contentLength: 512, contentType: 'image/jpeg' });
    });
  });

  describe('deletePrefix', () => {
    it('should remove every object under the prefix and keep other prefixes', async () => {
      const target = newVideoId();
      const other = newVideoId();
      usedIds.push(other);
      await storage.putObject(
        videoOriginalKey(target),
        randomBytes(16),
        'video/mp4',
      );
      await storage.putObject(
        videoThumbnailKey(target),
        randomBytes(16),
        'image/jpeg',
      );
      await storage.putObject(
        videoOriginalKey(other),
        randomBytes(16),
        'video/mp4',
      );

      await storage.deletePrefix(videoPrefix(target));

      await expect(
        storage.headObject(videoOriginalKey(target)),
      ).rejects.toThrow();
      await expect(
        storage.headObject(videoThumbnailKey(target)),
      ).rejects.toThrow();
      await expect(
        storage.headObject(videoOriginalKey(other)),
      ).resolves.toEqual(expect.objectContaining({ contentLength: 16 }));
    });
  });

  describe('presigned URLs', () => {
    it('should sign part URLs for the public endpoint with partNumber and uploadId', async () => {
      const id = newVideoId();
      const key = videoOriginalKey(id);
      const uploadId = await storage.createMultipartUpload(key, 'video/mp4');

      const url = new URL(
        await storage.presignUploadPart(
          key,
          uploadId,
          3,
          1024,
          PRESIGN_TTL_SECONDS,
        ),
      );

      expect(url.host).toBe(new URL(config.publicEndpoint).host);
      expect(url.searchParams.get('partNumber')).toBe('3');
      expect(url.searchParams.get('uploadId')).toBe(uploadId);
      expect(url.searchParams.get('X-Amz-Expires')).toBe(
        String(PRESIGN_TTL_SECONDS),
      );
      await storage.abortMultipartUpload(key, uploadId);
    });

    it('should sign download URLs for the public endpoint as an attachment', async () => {
      const url = new URL(
        await storage.presignGetObject(videoOriginalKey(newVideoId()), {
          expiresIn: PRESIGN_TTL_SECONDS,
          downloadFilename: 'my-video.mp4',
        }),
      );

      expect(url.host).toBe(new URL(config.publicEndpoint).host);
      expect(url.searchParams.get('response-content-disposition')).toBe(
        `attachment; filename="my-video.mp4"; filename*=UTF-8''my-video.mp4`,
      );
    });

    it('should sign stream URLs without a content-disposition override', async () => {
      const url = new URL(
        await storage.presignGetObject(videoOriginalKey(newVideoId()), {
          expiresIn: PRESIGN_TTL_SECONDS,
        }),
      );

      expect(url.searchParams.has('response-content-disposition')).toBe(false);
    });

    it('should sign internal GET URLs for the internal endpoint that the server accepts', async () => {
      const id = newVideoId();
      usedIds.push(id);
      const key = videoOriginalKey(id);
      const body = randomBytes(64);
      await storage.putObject(key, body, 'video/mp4');

      const signed = await storage.presignInternalGetObject(
        key,
        PRESIGN_TTL_SECONDS,
      );
      const response = await fetch(signed);

      expect(new URL(signed).host).toBe(new URL(config.endpoint).host);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    });
  });
});
