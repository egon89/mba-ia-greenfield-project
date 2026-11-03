import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { configModuleOptions } from './config/config-module.options';
import { typeOrmModuleOptions } from './database/typeorm-options.factory';
import { QueueModule } from './queue/queue.module';
import { VideosModule } from './videos/videos.module';

// The API only produces jobs; VideoProcessingModule (consumers) is loaded by
// WorkerModule alone (TD-08).
@Module({
  imports: [
    ConfigModule.forRoot(configModuleOptions),
    TypeOrmModule.forRootAsync(typeOrmModuleOptions),
    AuthModule,
    QueueModule,
    VideosModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
