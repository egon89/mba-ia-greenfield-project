import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { QueueModule } from '../queue/queue.module';
import { StorageService } from '../storage/storage.service';
import { createTestDataSource } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video } from '../videos/entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingModule', () => {
  it('should compile with the Video repository, both video queues and storage', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, redisConfig, queueConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        QueueModule,
        VideoProcessingModule,
      ],
    }).compile();

    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE)).name).toBe(
      VIDEO_PROCESSING_QUEUE,
    );
    expect(module.get<Queue>(getQueueToken(VIDEO_MAINTENANCE_QUEUE)).name).toBe(
      VIDEO_MAINTENANCE_QUEUE,
    );
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    await module.close();
  }, 30000);
});
