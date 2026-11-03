import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';

// Shared by both entrypoints (API and worker). Entities come from each
// module's TypeOrmModule.forFeature (autoLoadEntities).
export const typeOrmModuleOptions: TypeOrmModuleAsyncOptions = {
  inject: [databaseConfig.KEY],
  useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
    type: 'postgres',
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  }),
};
