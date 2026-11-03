import { S3Client } from '@aws-sdk/client-s3';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

describe('StorageModule', () => {
  it('should compile and resolve both S3 clients and StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    expect(module.get(S3_CLIENT)).toBeInstanceOf(S3Client);
    expect(module.get(S3_PUBLIC_CLIENT)).toBeInstanceOf(S3Client);
    expect(module.get(S3_CLIENT)).not.toBe(module.get(S3_PUBLIC_CLIENT));
    expect(module.get(StorageService)).toBeInstanceOf(StorageService);
    await module.close();
  });
});
