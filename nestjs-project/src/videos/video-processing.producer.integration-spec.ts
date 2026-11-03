import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingProducer } from './video-processing.producer';

describe('VideoProcessingProducer (integration)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [redisConfig, queueConfig],
        }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();

    producer = module.get(VideoProcessingProducer);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
    } finally {
      await module.close();
    }
  });

  it('should add a waiting process-video job keyed by the video id with the retry options', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.id).toBe(videoId);
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 10000 },
      removeOnComplete: true,
      removeOnFail: { age: 604800 },
    });
    expect(await job!.getState()).toBe('waiting');
  });

  it('should keep a single job when the same video id is enqueued twice', async () => {
    const videoId = randomUUID();

    await producer.enqueue(videoId);
    await producer.enqueue(videoId);

    const waiting = await queue.getWaiting();
    expect(waiting.map((job) => job.id)).toEqual([videoId]);
  });
});
