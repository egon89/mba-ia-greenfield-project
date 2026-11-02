import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { videoOriginalKey } from '../storage/storage-keys';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let service: VideosService;
  let storage: StorageService;
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videosConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
        ChannelsModule,
      ],
      providers: [VideosService],
    }).compile();

    dataSource = module.get(DataSource);
    service = module.get(VideosService);
    storage = module.get(StorageService);
  });

  afterAll(async () => {
    try {
      for (const { key, uploadId } of openUploads) {
        await storage.abortMultipartUpload(key, uploadId);
      }
    } finally {
      await module.close();
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createUserWithChannel(): Promise<{
    user: User;
    channel: Channel;
  }> {
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    const channel = await dataSource.getRepository(Channel).save({
      name: 'Uploader',
      nickname: 'uploader',
      user_id: user.id,
    });
    return { user, channel };
  }

  it("persists a draft on the user's channel tied to an open multipart upload", async () => {
    const { user, channel } = await createUserWithChannel();

    const { video } = await service.initiateUpload(user.id, {
      filename: 'Minha viagem.mp4',
      size_bytes: 150_000_000,
      content_type: 'video/mp4',
    });
    const key = videoOriginalKey(video.id);
    openUploads.push({ key, uploadId: video.upload_id! });

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row).toMatchObject({
      status: VideoStatus.DRAFT,
      channel_id: channel.id,
      title: 'Minha viagem',
      declared_size_bytes: 150_000_000,
      size_bytes: null,
    });
    expect(row.upload_id).toEqual(expect.any(String));

    // ListParts only succeeds for a multipart upload that exists in storage.
    await expect(storage.listParts(key, row.upload_id!)).resolves.toEqual([]);
  });
});
