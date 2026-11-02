import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';

// Queue consumers; loaded only by WorkerModule, never by AppModule (TD-08).
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
    StorageModule,
  ],
})
export class VideoProcessingModule {}
