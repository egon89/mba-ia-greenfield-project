import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import type { JwtPayload } from '../src/auth/auth.types';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './helpers/auth.helper';

const VALID_BODY = {
  filename: 'Minha viagem.mp4',
  size_bytes: 150000000,
  content_type: 'video/mp4',
};

function decodeSub(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  return (
    JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtPayload
  ).sub;
}

describe('POST /videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let accessToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    storage = moduleFixture.get(StorageService);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storage.deletePrefix('videos/');
    throttlerStorage.storage.clear();
    ({ access_token: accessToken } = await registerConfirmAndLogin(
      app,
      'uploader@example.com',
    ));
  });

  async function countVideos(): Promise<number> {
    return dataSource.getRepository(Video).count();
  }

  it('iniciar-upload-cria-rascunho-no-canal-do-usuario', async () => {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(VALID_BODY)
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'draft',
      title: 'Minha viagem',
      description: null,
      failure_reason: null,
      original_filename: 'Minha viagem.mp4',
      content_type: 'video/mp4',
      size_bytes: null,
      duration_seconds: null,
      width: null,
      height: null,
      mime_type: null,
      video_codec: null,
      audio_codec: null,
      bitrate: null,
      frame_rate: null,
      upload: { part_size: 67108864, part_count: 3 },
    });
    expect(res.body.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
    for (const internal of [
      'id',
      'channel_id',
      'upload_id',
      'declared_size_bytes',
      'thumbnail_key',
    ]) {
      expect(res.body).not.toHaveProperty(internal);
    }

    const video = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: res.body.public_id as string });
    const channel = await dataSource
      .getRepository(Channel)
      .findOneByOrFail({ user_id: decodeSub(accessToken) });
    expect(video.channel_id).toBe(channel.id);
    expect(video.upload_id).toEqual(expect.any(String));
    expect(video.declared_size_bytes).toBe(150000000);
  });

  it('corpo-invalido-retorna-validation-error', async () => {
    const tooBig = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'big.mp4',
        size_bytes: 10737418241,
        content_type: 'video/mp4',
      })
      .expect(400);
    expect(tooBig.body.error).toBe('VALIDATION_ERROR');
    expect(tooBig.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('size_bytes')]),
    );

    const notVideo = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        filename: 'foto.png',
        size_bytes: 1000,
        content_type: 'image/png',
      })
      .expect(400);
    expect(notVideo.body.error).toBe('VALIDATION_ERROR');
    expect(notVideo.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('content_type')]),
    );

    expect(await countVideos()).toBe(0);
  });

  it('sem-autenticacao-retorna-401', async () => {
    await request(app.getHttpServer())
      .post('/videos')
      .send(VALID_BODY)
      .expect(401);

    expect(await countVideos()).toBe(0);
  });

  it('endpoint-fora-do-throttler-de-auth', async () => {
    const statuses: number[] = [];
    const publicIds: string[] = [];

    for (let i = 0; i < 11; i++) {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(VALID_BODY);
      statuses.push(res.status);
      publicIds.push(res.body.public_id as string);
    }

    expect(statuses).toEqual(Array(11).fill(201));
    expect(new Set(publicIds).size).toBe(11);
  });
});
