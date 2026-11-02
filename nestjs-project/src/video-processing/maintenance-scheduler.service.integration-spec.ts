import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import {
  CLEANUP_ABANDONED_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { MaintenanceSchedulerService } from './maintenance-scheduler.service';

// Each module stands for one worker boot: init() runs onApplicationBootstrap.
async function bootScheduler(): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        load: [redisConfig, queueConfig],
      }),
      QueueModule,
      BullModule.registerQueue({ name: VIDEO_MAINTENANCE_QUEUE }),
    ],
    providers: [MaintenanceSchedulerService],
  }).compile();
  await module.init();
  return module;
}

describe('MaintenanceSchedulerService (integration)', () => {
  const modules: TestingModule[] = [];
  let queue: Queue;

  beforeAll(async () => {
    modules.push(await bootScheduler());
    queue = modules[0].get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
    } finally {
      for (const module of modules) await module.close();
    }
  });

  it('should leave exactly one cleanup-abandoned-uploads scheduler, every hour, after two boots', async () => {
    modules.push(await bootScheduler());
    modules.push(await bootScheduler());

    const schedulers = await queue.getJobSchedulers();

    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: CLEANUP_ABANDONED_UPLOADS_JOB,
      name: CLEANUP_ABANDONED_UPLOADS_JOB,
      every: 3_600_000,
    });
  });
});
