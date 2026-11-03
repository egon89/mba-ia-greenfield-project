import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageService } from './storage.service';

const buildClient = (
  config: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client =>
  new S3Client({
    endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Avoid default CRC32 checksum headers on PutObject/UploadPart (library-refs).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.endpoint),
    },
    {
      provide: S3_PUBLIC_CLIENT,
      inject: [storageConfig.KEY],
      useFactory: (config: ConfigType<typeof storageConfig>) =>
        buildClient(config, config.publicEndpoint),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
