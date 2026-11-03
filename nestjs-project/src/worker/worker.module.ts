import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { configModuleOptions } from '../config/config-module.options';
import { typeOrmModuleOptions } from '../database/typeorm-options.factory';
import { QueueModule } from '../queue/queue.module';
import { User } from '../users/entities/user.entity';
import { VideoProcessingModule } from '../video-processing/video-processing.module';

// Root of the worker entrypoint (src/worker.ts): no HTTP, only queue consumers.
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmModuleOptions),
    // Relation targets of Video (Video → Channel → User): autoLoadEntities
    // needs their metadata even though the worker never queries them.
    TypeOrmModule.forFeature([Channel, User]),
    QueueModule,
    VideoProcessingModule,
  ],
})
export class WorkerModule {}
