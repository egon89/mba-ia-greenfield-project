import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { videoThumbnailKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './helpers/auth.helper';

const MiB = 1_048_576;

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

describe('GET /videos/:publicId (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let publicId: string;

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
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    ({ access_token: ownerToken } = await registerConfirmAndLogin(
      app,
      'owner@example.com',
    ));
    ({ access_token: otherToken } = await registerConfirmAndLogin(
      app,
      'other@example.com',
    ));

    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'clip.mp4',
        size_bytes: 6 * MiB,
        content_type: 'video/mp4',
      })
      .expect(201);
    publicId = (res.body as { public_id: string }).public_id;
  });

  function getVideo(id: string, token?: string) {
    const req = request(app.getHttpServer()).get(`/videos/${id}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  async function updateRow(fields: Partial<Video>): Promise<void> {
    await dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, fields);
  }

  // 1. Ler o vídeo como dono

  it('dono-le-video-ready-ou-failed', async () => {
    const { id } = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    await updateRow({
      status: VideoStatus.READY,
      upload_id: null,
      size_bytes: 6291456,
      duration_seconds: 2,
      width: 320,
      height: 240,
      mime_type: 'mov,mp4,m4a,3gp,3g2,mj2',
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 250000,
      frame_rate: 25,
      thumbnail_key: videoThumbnailKey(id),
    });

    const ready = await getVideo(publicId, ownerToken).expect(200);

    expect(ready.body).toMatchObject({
      public_id: publicId,
      status: 'ready',
      failure_reason: null,
      size_bytes: 6291456,
      duration_seconds: 2,
      width: 320,
      height: 240,
      mime_type: 'mov,mp4,m4a,3gp,3g2,mj2',
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 250000,
      frame_rate: 25,
    });
    for (const key of [
      'id',
      'channel_id',
      'upload_id',
      'declared_size_bytes',
      'thumbnail_key',
    ]) {
      expect(ready.body).not.toHaveProperty(key);
    }

    await updateRow({
      status: VideoStatus.FAILED,
      failure_reason: 'invalid_media',
    });

    const failed = await getVideo(publicId, ownerToken).expect(200);

    expect(failed.body).toMatchObject({
      status: 'failed',
      failure_reason: 'invalid_media',
    });
  });

  it('outro-usuario-ou-inexistente-retorna-404', async () => {
    const other = await getVideo(publicId, otherToken).expect(404);
    const otherBody = other.body as ErrorBody;
    expect(otherBody.error).toBe('VIDEO_NOT_FOUND');

    for (const id of ['AAAAAAAAAAA', 'abc']) {
      const res = await getVideo(id, ownerToken).expect(404);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('VIDEO_NOT_FOUND');
      expect(body.message).toBe(otherBody.message);
    }
  });

  it('sem-autenticacao-retorna-401', async () => {
    await getVideo(publicId).expect(401);
  });
});
