import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { Video } from '../videos/entities/video.entity';
import { WorkerModule } from './worker.module';

describe('WorkerModule', () => {
  it('should compile with config, TypeORM, the shared queue config and VideoProcessingModule', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    await module.init();

    // Video's relations (Channel, User) resolve without the API modules.
    const dataSource = module.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);
    expect(dataSource.getMetadata(Video).relations).toHaveLength(1);

    const processing = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(processing.opts.prefix).toBe('test');
    expect(module.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE)).name).toBe(
      VIDEO_MAINTENANCE_QUEUE,
    );
    await module.close();
  }, 30000);
});
