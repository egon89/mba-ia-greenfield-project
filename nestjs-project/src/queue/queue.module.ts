import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';

// Shared BullMQ connection for the API and the worker. The prefix applies to
// every queue and worker registered afterwards, so test runs stay isolated.
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [redisConfig.KEY, queueConfig.KEY],
      useFactory: (
        redis: ConfigType<typeof redisConfig>,
        queue: ConfigType<typeof queueConfig>,
      ) => ({
        connection: { host: redis.host, port: redis.port },
        prefix: queue.prefix,
      }),
    }),
  ],
})
export class QueueModule {}
