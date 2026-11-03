import type { ConfigModuleOptions } from '@nestjs/config';
import appConfig from './app.config';
import authConfig from './auth.config';
import databaseConfig from './database.config';
import { envValidationSchema } from './env.validation';
import mailConfig from './mail.config';
import queueConfig from './queue.config';
import redisConfig from './redis.config';
import storageConfig from './storage.config';
import swaggerConfig from './swagger.config';
import videosConfig from './videos.config';

// Shared by both entrypoints (API and worker): same namespaces, same validation.
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  load: [
    appConfig,
    authConfig,
    databaseConfig,
    mailConfig,
    swaggerConfig,
    redisConfig,
    queueConfig,
    storageConfig,
    videosConfig,
  ],
  validationSchema: envValidationSchema,
  validationOptions: { allowUnknown: true, abortEarly: false },
};
