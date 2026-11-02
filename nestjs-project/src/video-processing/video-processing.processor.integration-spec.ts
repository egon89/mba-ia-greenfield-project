import { readFile } from 'node:fs/promises';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { PROCESS_VIDEO_JOB_OPTIONS } from '../queue/queue.constants';
import { S3_CLIENT } from '../storage/storage.constants';
import {
  videoOriginalKey,
  videoPrefix,
  videoThumbnailKey,
} from '../storage/storage-keys';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import {
  createVideoFixtures,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
  type VideoFixtures,
} from '../test/video-fixtures';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import type { ProcessVideoJobData } from '../videos/video-processing.producer';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailExtractorService } from './thumbnail-extractor.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

// The processor is a plain provider here (no BullModule), so no real worker
// starts; process()/onFailed() are called directly, as BullMQ would.
describe('VideoProcessingProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let storage: StorageService;
  let s3: S3Client;
  let probe: MediaProbeService;
  let processor: VideoProcessingProcessor;
  let fixtures: VideoFixtures;
  let channel: Channel;
  const createdIds: string[] = [];

  const jobFor = (
    videoId: string,
    attemptsMade = 0,
  ): Job<ProcessVideoJobData> =>
    ({
      data: { videoId },
      attemptsMade,
      opts: { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
    }) as Job<ProcessVideoJobData>;

  // A video in `processing` whose original object is the given fixture.
  async function processingVideo(fixturePath: string): Promise<Video> {
    const video = await videoRepository.save({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'Clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: 1024,
      status: VideoStatus.PROCESSING,
    });
    createdIds.push(video.id);
    await storage.putObject(
      videoOriginalKey(video.id),
      await readFile(fixturePath),
      'video/mp4',
    );
    return video;
  }

  async function readThumbnail(id: string): Promise<Buffer> {
    const object = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: videoThumbnailKey(id),
      }),
    );
    return Buffer.from(await object.Body!.transformToByteArray());
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [
        VideoProcessingProcessor,
        MediaProbeService,
        ThumbnailExtractorService,
      ],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    storage = module.get(StorageService);
    s3 = module.get<S3Client>(S3_CLIENT);
    probe = module.get(MediaProbeService);
    processor = module.get(VideoProcessingProcessor);
    fixtures = await createVideoFixtures();
  }, 60000);

  afterAll(async () => {
    for (const id of createdIds) await storage.deletePrefix(videoPrefix(id));
    await cleanAllTables(dataSource);
    await fixtures.cleanup();
    await module.close();
  });

  beforeEach(async () => {
    jest.restoreAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'worker_owner@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'worker_owner',
      user_id: user.id,
    });
  });

  it('should mark the 2 s MP4 with audio as ready with its metadata', async () => {
    const video = await processingVideo(fixtures.withAudio);

    await processor.process(jobFor(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.failure_reason).toBeNull();
    expect(row.duration_seconds).toBeCloseTo(2, 0);
    expect(row.width).toBe(FIXTURE_WIDTH);
    expect(row.height).toBe(FIXTURE_HEIGHT);
    expect(row.video_codec).toBe('h264');
    expect(row.audio_codec).not.toBeNull();
    expect(row.bitrate).toBeGreaterThan(0);
    expect(row.frame_rate).toBeGreaterThan(0);
    expect(row.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
  }, 30000);

  it('should store a JPEG thumbnail with ContentType image/jpeg', async () => {
    const video = await processingVideo(fixtures.withAudio);

    await processor.process(jobFor(video.id));

    const head = await storage.headObject(videoThumbnailKey(video.id));
    const body = await readThumbnail(video.id);
    expect(head.contentType).toBe('image/jpeg');
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 30000);

  it('should mark the 0.2 s clip without audio as ready with a thumbnail', async () => {
    const video = await processingVideo(fixtures.shortNoAudio);

    await processor.process(jobFor(video.id));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.audio_codec).toBeNull();
    const body = await readThumbnail(video.id);
    expect(body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  }, 30000);

  it('should throw UnrecoverableError for invalid media, store no thumbnail, and end as invalid_media', async () => {
    const video = await processingVideo(fixtures.invalid);
    const job = jobFor(video.id);

    const error = await processor.process(job).catch((e: unknown) => e);
    await processor.onFailed(
      { ...job, attemptsMade: 1 } as Job<ProcessVideoJobData>,
      error as Error,
    );

    expect(error).toBeInstanceOf(UnrecoverableError);
    await expect(
      storage.headObject(videoThumbnailKey(video.id)),
    ).rejects.toThrow();
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBe('invalid_media');
    expect(row.thumbnail_key).toBeNull();
  }, 30000);

  it('should end as ready when only the first attempt hits a temporary error', async () => {
    const video = await processingVideo(fixtures.shortNoAudio);
    jest
      .spyOn(probe, 'probe')
      .mockRejectedValueOnce(new Error('connection reset'));

    const error = await processor
      .process(jobFor(video.id, 0))
      .catch((e: unknown) => e);
    await processor.onFailed(jobFor(video.id, 1), error as Error);
    await processor.process(jobFor(video.id, 1));

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.failure_reason).toBeNull();
  }, 30000);

  it('should end as processing_failed when all 3 attempts hit a temporary error', async () => {
    const video = await processingVideo(fixtures.shortNoAudio);
    jest.spyOn(probe, 'probe').mockRejectedValue(new Error('connection reset'));

    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await processor
        .process(jobFor(video.id, attempt))
        .catch((e: unknown) => e);
      await processor.onFailed(jobFor(video.id, attempt + 1), error as Error);
    }

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBe('processing_failed');
  }, 30000);

  it('should not change the row or the thumbnail on re-delivery of a ready video', async () => {
    const video = await processingVideo(fixtures.withAudio);
    await processor.process(jobFor(video.id));
    const before = await videoRepository.findOneByOrFail({ id: video.id });
    const thumbnailBefore = await readThumbnail(video.id);
    const putObject = jest.spyOn(storage, 'putObject');

    await processor.process(jobFor(video.id));

    const after = await videoRepository.findOneByOrFail({ id: video.id });
    expect(after).toEqual(before);
    expect(putObject).not.toHaveBeenCalled();
    expect(await readThumbnail(video.id)).toEqual(thumbnailBefore);
  }, 30000);
});
