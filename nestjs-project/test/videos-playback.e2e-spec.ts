import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { videoOriginalKey } from '../src/storage/storage-keys';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './helpers/auth.helper';

// The Location URL must be reachable from inside the container, and the
// signature binds the host — sign for the Compose service.
const TEST_ENV = { S3_PUBLIC_ENDPOINT: 'http://storage:9000' };

const ORIGINAL_FILENAME = 'Férias "2026".mp4';
const CONTENT = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251));

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
}

describe('GET /videos/:publicId/stream + GET /videos/:publicId/download (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let publicId: string;
  let videoId: string;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [name, value] of Object.entries(TEST_ENV)) {
      originalEnv[name] = process.env[name];
      process.env[name] = value;
    }

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
    await storage.deletePrefix('videos/');
    await app.close();
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storage.deletePrefix('videos/');
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
        filename: ORIGINAL_FILENAME,
        size_bytes: CONTENT.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    publicId = (res.body as { public_id: string }).public_id;

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    videoId = row.id;
    await storage.abortMultipartUpload(
      videoOriginalKey(videoId),
      row.upload_id!,
    );
    await storage.putObject(videoOriginalKey(videoId), CONTENT, 'video/mp4');
    await updateRow({
      status: VideoStatus.READY,
      upload_id: null,
      size_bytes: CONTENT.length,
    });
  });

  async function updateRow(fields: Partial<Video>): Promise<void> {
    await dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, fields);
  }

  // supertest does not follow redirects unless asked to.
  function get(path: string, token?: string) {
    const req = request(app.getHttpServer()).get(path);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  }

  const MODES = ['stream', 'download'] as const;

  // 1. Redirecionar para o storage

  it('stream-redireciona-para-url-pre-assinada', async () => {
    const res = await get(`/videos/${publicId}/stream`, ownerToken).expect(302);

    expect(res.headers['cache-control']).toBe('no-store');
    const location = new URL(res.headers.location);
    expect(location.host).toBe(new URL(TEST_ENV.S3_PUBLIC_ENDPOINT).host);
    expect(location.pathname).toMatch(
      new RegExp(`${videoOriginalKey(videoId)}$`),
    );
    expect(location.searchParams.get('X-Amz-Expires')).toBe('21600');

    const ranged = await fetch(location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${CONTENT.length}`,
    );
    const body = Buffer.from(await ranged.arrayBuffer());
    expect(body.equals(CONTENT.subarray(0, 1024))).toBe(true);
  });

  it('download-redireciona-com-attachment', async () => {
    const res = await get(`/videos/${publicId}/download`, ownerToken).expect(
      302,
    );

    expect(res.headers['cache-control']).toBe('no-store');
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(location.searchParams.get('response-content-disposition')).toContain(
      'attachment',
    );

    const file = await fetch(location);
    expect(file.status).toBe(200);
    const body = Buffer.from(await file.arrayBuffer());
    expect(body.equals(CONTENT)).toBe(true);
    const disposition = file.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment')).toBe(true);
    const encoded = /filename\*=UTF-8''(\S+)$/.exec(disposition)?.[1] ?? '';
    expect(decodeURIComponent(encoded)).toBe(ORIGINAL_FILENAME);
  });

  it('video-nao-pronto-retorna-409', async () => {
    await updateRow({ status: VideoStatus.PROCESSING });

    for (const mode of MODES) {
      const res = await get(`/videos/${publicId}/${mode}`, ownerToken).expect(
        409,
      );
      expect((res.body as ErrorBody).error).toBe('VIDEO_NOT_READY');
      expect(res.headers.location).toBeUndefined();
    }
  });

  it('outro-usuario-ou-inexistente-retorna-404', async () => {
    for (const mode of MODES) {
      const other = await get(`/videos/${publicId}/${mode}`, otherToken).expect(
        404,
      );
      expect((other.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
      expect(other.headers.location).toBeUndefined();

      const unknown = await get(
        `/videos/AAAAAAAAAAA/${mode}`,
        ownerToken,
      ).expect(404);
      expect((unknown.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    }
  });

  it('sem-autenticacao-retorna-401', async () => {
    for (const mode of MODES) {
      const res = await get(`/videos/${publicId}/${mode}`).expect(401);
      expect(res.headers.location).toBeUndefined();
    }
  });
});
