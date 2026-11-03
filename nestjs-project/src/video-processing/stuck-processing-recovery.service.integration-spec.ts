import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { type Queue, UnrecoverableError, Worker } from 'bullmq';
import { DataSource, type Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import videosConfig from '../config/videos.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { StuckProcessingRecoveryService } from './stuck-processing-recovery.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('StuckProcessingRecoveryService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let queue: Queue;
  let service: StuckProcessingRecoveryService;
  let stuckAfterMinutes: number;
  let channel: Channel;

  async function processingVideo(minutesSinceUpdate: number): Promise<Video> {
    const video = await videoRepository.save({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'Clip',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: 1024,
      status: VideoStatus.PROCESSING,
    });
    // @UpdateDateColumn always stamps "now"; backdate it directly.
    await dataSource.query(
      `UPDATE "videos" SET "updated_at" = now() - make_interval(mins => $1) WHERE "id" = $2`,
      [minutesSinceUpdate, video.id],
    );
    return video;
  }

  // Runs a throwaway worker until the job lands in the failed set.
  async function failJob(videoId: string): Promise<void> {
    const redis = module.get<ConfigType<typeof redisConfig>>(redisConfig.KEY);
    const prefix = module.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
    ).prefix;
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
    );
    const worker = new Worker(
      VIDEO_PROCESSING_QUEUE,
      () => Promise.reject(new UnrecoverableError('boom')),
      { connection: { host: redis.host, port: redis.port }, prefix },
    );
    try {
      await new Promise<void>((resolve) =>
        worker.once('failed', () => resolve()),
      );
    } finally {
      await worker.close();
    }
  }

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [redisConfig, queueConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [StuckProcessingRecoveryService],
    }).compile();

    dataSource = module.get(DataSource);
    videoRepository = dataSource.getRepository(Video);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    service = module.get(StuckProcessingRecoveryService);
    stuckAfterMinutes = module.get<ConfigType<typeof videosConfig>>(
      videosConfig.KEY,
    ).processingStuckAfterMinutes;
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
      await cleanAllTables(dataSource);
    } finally {
      await module.close();
    }
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'stuck_owner@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'stuck_owner',
      user_id: user.id,
    });
  });

  it('should enqueue a process-video job with id = video id for a stuck video without a job', async () => {
    const video = await processingVideo(stuckAfterMinutes + 10);

    await service.recoverStuckProcessing(new Date());

    const job = await queue.getJob(video.id);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: video.id });
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });

  it('should mark a stuck video as processing_failed when its job failed', async () => {
    const video = await processingVideo(stuckAfterMinutes + 10);
    await failJob(video.id);

    await service.recoverStuckProcessing(new Date());

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.failure_reason).toBe('processing_failed');
  }, 20000);

  it('should leave a stuck video with a waiting job untouched and add no new job', async () => {
    const video = await processingVideo(stuckAfterMinutes + 10);
    await queue.add(
      PROCESS_VIDEO_JOB,
      { videoId: video.id },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
    );

    await service.recoverStuckProcessing(new Date());

    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(await queue.getJobCounts('waiting')).toEqual({ waiting: 1 });
  });

  it('should ignore a processing video updated more recently than the threshold', async () => {
    const video = await processingVideo(stuckAfterMinutes - 10);

    await service.recoverStuckProcessing(new Date());

    expect(await queue.getJob(video.id)).toBeUndefined();
    const row = await videoRepository.findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });
});
