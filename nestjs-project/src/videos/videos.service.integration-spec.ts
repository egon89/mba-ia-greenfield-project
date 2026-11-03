import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { S3_CLIENT } from '../storage/storage.constants';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { videoOriginalKey, videoPrefix } from '../storage/storage-keys';
import { VideoProcessingProducer } from './video-processing.producer';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const MiB = 1_048_576;
// Presigned URLs carry the signed public host; `localhost:9000` is not
// reachable from inside the container, so sign for the Compose service.
const TEST_ENV = {
  S3_PUBLIC_ENDPOINT: 'http://storage:9000',
  UPLOAD_PART_SIZE_BYTES: String(5 * MiB),
};

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  let queue: Queue;
  let s3: S3Client;
  const openUploads: { key: string; uploadId: string }[] = [];
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [name, value] of Object.entries(TEST_ENV)) {
      originalEnv[name] = process.env[name];
      process.env[name] = value;
    }
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig, redisConfig, queueConfig],
        }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        ChannelsModule,
      ],
      providers: [VideosService, VideoProcessingProducer],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    s3 = module.get<S3Client>(S3_CLIENT);
  });

  afterAll(async () => {
    try {
      for (const { key, uploadId } of openUploads) {
        await storage.abortMultipartUpload(key, uploadId);
      }
      await queue.obliterate({ force: true });
      await storage.deletePrefix('videos/');
    } finally {
      await module.close();
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Uploader',
      nickname: 'uploader',
      user_id: user.id,
    });
    return { user, channel };
  }

  it("persists a draft on the user's channel tied to an open multipart upload", async () => {
    const { user, channel } = await createUserWithChannel();

    const { video } = await service.initiateUpload(user.id, {
      filename: 'Minha viagem.mp4',
      size_bytes: 150_000_000,
      content_type: 'video/mp4',
    });
    const key = videoOriginalKey(video.id);
    openUploads.push({ key, uploadId: video.upload_id! });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      title: 'Minha viagem',
      declared_size_bytes: 150_000_000,
      size_bytes: null,
    });
    expect(row.upload_id).toEqual(expect.any(String));

    // ListParts only succeeds for a multipart upload that exists in storage.
    await expect(storage.listParts(key, row.upload_id!)).resolves.toEqual([]);
  });

  it('lists only the part uploaded through the issued URL, with its size', async () => {
    const { user } = await createUserWithChannel();
    const { video } = await service.initiateUpload(user.id, {
      filename: 'clip.mp4',
      size_bytes: 6 * MiB,
      content_type: 'video/mp4',
    });
    openUploads.push({
      key: videoOriginalKey(video.id),
      uploadId: video.upload_id!,
    });

    const {
      parts: [part],
    } = await service.issuePartUrls(user.id, video.public_id, [1]);
    const put = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.alloc(part.contentLength, 1),
    });
    expect(put.status).toBe(200);

    await expect(
      service.listUploadedParts(user.id, video.public_id),
    ).resolves.toEqual({
      partSize: 5 * MiB,
      partCount: 2,
      uploadedParts: [{ partNumber: 1, size: 5 * MiB }],
    });
  });

  describe('completeUpload', () => {
    // 5 MiB + 1 MiB → 2 parts, both uploaded through the issued URLs.
    async function uploadedDraft(): Promise<{ user: User; video: Video }> {
      const { user } = await createUserWithChannel();
      const { video } = await service.initiateUpload(user.id, {
        filename: 'clip.mp4',
        size_bytes: 6 * MiB,
        content_type: 'video/mp4',
      });
      openUploads.push({
        key: videoOriginalKey(video.id),
        uploadId: video.upload_id!,
      });
      const { parts } = await service.issuePartUrls(
        user.id,
        video.public_id,
        [1, 2],
      );
      for (const part of parts) {
        const put = await fetch(part.url, {
          method: 'PUT',
          body: Buffer.alloc(part.contentLength, part.partNumber),
        });
        expect(put.status).toBe(200);
      }
      return { user, video };
    }

    async function keysUnder(prefix: string): Promise<string[]> {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: process.env.S3_BUCKET,
          Prefix: prefix,
        }),
      );
      return (page.Contents ?? []).map((object) => object.Key!);
    }

    it('assembles the object, moves the row to processing and enqueues process-video', async () => {
      const { user, video } = await uploadedDraft();

      const result = await service.completeUpload(user.id, video.public_id);

      expect(result).toMatchObject({
        status: VideoStatus.PROCESSING,
        size_bytes: 6 * MiB,
        upload_id: null,
      });
      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(row).toMatchObject({
        status: VideoStatus.PROCESSING,
        size_bytes: 6 * MiB,
        upload_id: null,
      });
      await expect(
        storage.headObject(videoOriginalKey(video.id)),
      ).resolves.toMatchObject({ contentLength: 6 * MiB });
      const job = await queue.getJob(video.id);
      expect(job?.data).toEqual({ videoId: video.id });
    });

    it('keeps the row as failed / upload_size_mismatch and empties the prefix when the size differs', async () => {
      const { user, video } = await uploadedDraft();
      await dataSource
        .getRepository(Video)
        .update({ id: video.id }, { declared_size_bytes: 6 * MiB + 1 });

      await expect(
        service.completeUpload(user.id, video.public_id),
      ).rejects.toMatchObject({ errorCode: 'UPLOAD_SIZE_MISMATCH' });

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(row).toMatchObject({
        status: VideoStatus.FAILED,
        failure_reason: 'upload_size_mismatch',
        upload_id: null,
      });
      await expect(keysUnder(videoPrefix(video.id))).resolves.toEqual([]);
      await expect(queue.getJob(video.id)).resolves.toBeUndefined();
    });
  });

  describe('getOwnedVideo', () => {
    async function ownedVideo(): Promise<{ user: User; video: Video }> {
      const { user } = await createUserWithChannel();
      const { video } = await service.initiateUpload(user.id, {
        filename: 'clip.mp4',
        size_bytes: 6 * MiB,
        content_type: 'video/mp4',
      });
      openUploads.push({
        key: videoOriginalKey(video.id),
        uploadId: video.upload_id!,
      });
      return { user, video };
    }

    it("returns the owner's video with its current row state", async () => {
      const { user, video } = await ownedVideo();
      await dataSource.getRepository(Video).update(
        { id: video.id },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'invalid_media',
          upload_id: null,
        },
      );

      const found = await service.getOwnedVideo(user.id, video.public_id);

      expect(found).toMatchObject({
        id: video.id,
        public_id: video.public_id,
        status: VideoStatus.FAILED,
        failure_reason: 'invalid_media',
      });
    });

    it("rejects another user's video with VIDEO_NOT_FOUND", async () => {
      const { video } = await ownedVideo();
      const other = await dataSource
        .getRepository(User)
        .save({ email: 'other@example.com', password: 'hashed' });
      await dataSource.getRepository(Channel).save({
        name: 'Other',
        nickname: 'other',
        user_id: other.id,
      });

      await expect(
        service.getOwnedVideo(other.id, video.public_id),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });

    it('rejects an unknown publicId with VIDEO_NOT_FOUND', async () => {
      const { user } = await createUserWithChannel();

      await expect(
        service.getOwnedVideo(user.id, 'AAAAAAAAAAA'),
      ).rejects.toMatchObject({ errorCode: 'VIDEO_NOT_FOUND' });
    });
  });

  describe('getPlaybackUrl', () => {
    const ORIGINAL_FILENAME = 'Férias em família "2024".mp4';
    const CONTENT = Buffer.from(
      Array.from({ length: 4096 }, (_, i) => i % 251),
    );

    // A ready video whose original object holds CONTENT.
    async function readyVideo(): Promise<{ user: User; video: Video }> {
      const { user } = await createUserWithChannel();
      const { video } = await service.initiateUpload(user.id, {
        filename: ORIGINAL_FILENAME,
        size_bytes: CONTENT.length,
        content_type: 'video/mp4',
      });
      await storage.abortMultipartUpload(
        videoOriginalKey(video.id),
        video.upload_id!,
      );
      await storage.putObject(videoOriginalKey(video.id), CONTENT, 'video/mp4');
      await dataSource.getRepository(Video).update(
        { id: video.id },
        {
          status: VideoStatus.READY,
          upload_id: null,
          size_bytes: CONTENT.length,
        },
      );
      return { user, video };
    }

    it('signs a stream URL the storage answers with 206 for a Range request', async () => {
      const { user, video } = await readyVideo();

      const url = await service.getPlaybackUrl(
        user.id,
        video.public_id,
        'stream',
      );
      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });

      expect(res.status).toBe(206);
      expect(res.headers.get('content-range')).toBe(
        `bytes 0-1023/${CONTENT.length}`,
      );
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(CONTENT.subarray(0, 1024))).toBe(true);
    });

    it('signs a download URL the storage answers with an attachment carrying the original name', async () => {
      const { user, video } = await readyVideo();

      const url = await service.getPlaybackUrl(
        user.id,
        video.public_id,
        'download',
      );
      const res = await fetch(url);

      expect(res.status).toBe(200);
      const disposition = res.headers.get('content-disposition') ?? '';
      expect(disposition).toMatch(/^attachment; filename="/);
      expect(disposition).toContain(
        "filename*=UTF-8''F%C3%A9rias%20em%20fam%C3%ADlia%20%222024%22.mp4",
      );
      const encoded = /filename\*=UTF-8''(\S+)$/.exec(disposition)?.[1] ?? '';
      expect(decodeURIComponent(encoded)).toBe(ORIGINAL_FILENAME);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.equals(CONTENT)).toBe(true);
    });
  });
});
