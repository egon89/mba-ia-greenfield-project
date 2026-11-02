import { randomBytes } from 'node:crypto';
import {
  ListObjectsV2Command,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { S3_CLIENT } from '../storage/storage.constants';
import { videoOriginalKey, videoPrefix } from '../storage/storage-keys';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { AbandonedUploadsCleanupService } from './abandoned-uploads-cleanup.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const PART_SIZE = 5 * 1_048_576;

describe('AbandonedUploadsCleanupService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let s3: S3Client;
  let bucket: string;
  let abandonAfterHours: number;
  let service: AbandonedUploadsCleanupService;
  let channel: Channel;
  const usedIds: string[] = [];
  const openUploads: { key: string; uploadId: string }[] = [];

  async function video(
    status: VideoStatus,
    hoursSinceCreation: number,
  ): Promise<Video> {
    const saved = await videoRepository.save({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'Clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: PART_SIZE * 2,
      status,
    });
    usedIds.push(saved.id);
    await dataSource.query(
      `UPDATE "videos" SET "created_at" = now() - make_interval(hours => $1) WHERE "id" = $2`,
      [hoursSinceCreation, saved.id],
    );
    return saved;
  }

  // A draft with an open multipart upload holding one uploaded part.
  async function draftWithOnePart(hoursSinceCreation: number): Promise<Video> {
    const draft = await video(VideoStatus.DRAFT, hoursSinceCreation);
    const key = videoOriginalKey(draft.id);
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    openUploads.push({ key, uploadId });
    const body = randomBytes(PART_SIZE);
    await s3.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: body,
        ContentLength: body.length,
      }),
    );
    await videoRepository.update(draft.id, { upload_id: uploadId });
    return { ...draft, upload_id: uploadId };
  }

  async function objectsUnder(prefix: string): Promise<number> {
    const listing = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
    );
    return listing.KeyCount ?? 0;
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [AbandonedUploadsCleanupService],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    s3 = module.get<S3Client>(S3_CLIENT);
    bucket = module.get<ConfigType<typeof storageConfig>>(
      storageConfig.KEY,
    ).bucket;
    abandonAfterHours = module.get<ConfigType<typeof videosConfig>>(
      videosConfig.KEY,
    ).uploadAbandonAfterHours;
    service = module.get(AbandonedUploadsCleanupService);
  });

  afterAll(async () => {
    try {
      for (const { key, uploadId } of openUploads) {
        await storage.abortMultipartUpload(key, uploadId);
      }
      for (const id of usedIds) await storage.deletePrefix(videoPrefix(id));
      await cleanAllTables(dataSource);
    } finally {
      await module.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'draft_owner@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'draft_owner',
      user_id: user.id,
    });
  });

  it('should mark an old draft as upload_abandoned, abort its upload and empty its prefix, keeping the row', async () => {
    const draft = await draftWithOnePart(abandonAfterHours + 1);

    const cleaned = await service.cleanupAbandonedDrafts(new Date());

    expect(cleaned).toBe(1);
    const row = await videoRepository.findOneBy({ id: draft.id });
    expect(row).not.toBeNull();
    expect(row!.status).toBe(VideoStatus.FAILED);
    expect(row!.failure_reason).toBe('upload_abandoned');
    expect(row!.upload_id).toBeNull();
    await expect(
      storage.listParts(videoOriginalKey(draft.id), draft.upload_id!),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    expect(await objectsUnder(videoPrefix(draft.id))).toBe(0);
  }, 30000);

  it('should leave a recent draft and an old processing video untouched', async () => {
    const recent = await draftWithOnePart(abandonAfterHours - 1);
    const processing = await video(
      VideoStatus.PROCESSING,
      abandonAfterHours + 1,
    );

    const cleaned = await service.cleanupAbandonedDrafts(new Date());

    expect(cleaned).toBe(0);
    const recentRow = await videoRepository.findOneByOrFail({ id: recent.id });
    expect(recentRow.status).toBe(VideoStatus.DRAFT);
    expect(recentRow.upload_id).toBe(recent.upload_id);
    const parts = await storage.listParts(
      videoOriginalKey(recent.id),
      recent.upload_id!,
    );
    expect(parts).toHaveLength(1);
    const processingRow = await videoRepository.findOneByOrFail({
      id: processing.id,
    });
    expect(processingRow.status).toBe(VideoStatus.PROCESSING);
  }, 30000);
});
