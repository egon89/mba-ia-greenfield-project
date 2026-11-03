import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { type Job, type Queue, Worker } from 'bullmq';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './queue.constants';
import { QueueModule } from './queue.module';

const WORKER_LISTEN_MS = 1500;

describe('QueueModule prefix isolation (integration)', () => {
  let module: TestingModule;
  let queue: Queue;
  let bullWorker: Worker | undefined;

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
    }).compile();

    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    try {
      await bullWorker?.close();
      await queue.obliterate({ force: true });
    } finally {
      await module.close();
    }
  });

  it('should store test jobs under test:video-processing:* and never under bull:', async () => {
    const jobId = randomUUID();

    await queue.add(PROCESS_VIDEO_JOB, { videoId: jobId }, { jobId });

    const redis = await queue.getBackend().client;
    const testKeyJob = await redis.hgetall(
      `test:${VIDEO_PROCESSING_QUEUE}:${jobId}`,
    );
    const bullKeyJob = await redis.hgetall(
      `bull:${VIDEO_PROCESSING_QUEUE}:${jobId}`,
    );
    expect(testKeyJob.name).toBe(PROCESS_VIDEO_JOB);
    expect(bullKeyJob).toEqual({});
  });

  it('should not deliver a test-prefixed job to a worker listening with the bull prefix', async () => {
    const jobId = randomUUID();
    await queue.add(PROCESS_VIDEO_JOB, { videoId: jobId }, { jobId });

    const received: (string | undefined)[] = [];
    const redis = module.get<ReturnType<typeof redisConfig>>(redisConfig.KEY);
    bullWorker = new Worker(
      VIDEO_PROCESSING_QUEUE,
      async (job: Job) => {
        received.push(job.id);
        await Promise.resolve();
      },
      {
        prefix: 'bull',
        connection: { host: redis.host, port: redis.port },
      },
    );
    await bullWorker.waitUntilReady();

    await new Promise((resolve) => setTimeout(resolve, WORKER_LISTEN_MS));

    expect(received).not.toContain(jobId);
    const job = await queue.getJob(jobId);
    expect(await job!.getState()).toBe('waiting');
  });
});
