import { getSharedConfigToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from '../config/queue.config';
import redisConfig from '../config/redis.config';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  it('should compile and build the shared BullMQ config from redisConfig and queueConfig', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [redisConfig, queueConfig],
        }),
        QueueModule,
      ],
    }).compile();

    const redis = module.get<ReturnType<typeof redisConfig>>(redisConfig.KEY);
    expect(module.get(getSharedConfigToken())).toEqual({
      connection: { host: redis.host, port: redis.port },
      prefix: 'test',
    });
    await module.close();
  });
});
