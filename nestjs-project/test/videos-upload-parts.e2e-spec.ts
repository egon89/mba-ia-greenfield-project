import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './helpers/auth.helper';

const MiB = 1_048_576;
const PART_SIZE = 5 * MiB;
// The signature binds the host, and `localhost:9000` is not reachable from
// inside the container — sign for the Compose service instead.
const TEST_ENV = {
  S3_PUBLIC_ENDPOINT: 'http://storage:9000',
  UPLOAD_PART_SIZE_BYTES: String(PART_SIZE),
};

interface PartUrlsBody {
  parts: { part_number: number; url: string; content_length: number }[];
  expires_in: number;
}

describe('POST /videos/:publicId/upload/part-urls + GET /videos/:publicId/upload/parts (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let throttlerStorage: ThrottlerStorageService;
  let ownerToken: string;
  let otherToken: string;
  let publicId: string;
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

    // 5 MiB + 1 MiB → part_count 2.
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

  function postPartUrls(id: string, token: string, partNumbers: unknown) {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: partNumbers });
  }

  function getParts(id: string, token: string) {
    return request(app.getHttpServer())
      .get(`/videos/${id}/upload/parts`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('emitir-urls-de-parte-para-o-dono', async () => {
    const res = await postPartUrls(publicId, ownerToken, [1, 2]).expect(200);
    const body = res.body as PartUrlsBody;

    expect(body.expires_in).toBe(3600);
    expect(body.parts.map((p) => p.part_number)).toEqual([1, 2]);
    expect(body.parts.map((p) => p.content_length)).toEqual([PART_SIZE, MiB]);
    for (const part of body.parts) {
      const url = new URL(part.url);
      expect(url.host).toBe(new URL(TEST_ENV.S3_PUBLIC_ENDPOINT).host);
      expect(url.searchParams.get('partNumber')).toBe(String(part.part_number));
      expect(url.searchParams.get('uploadId')).toEqual(expect.any(String));
    }
  });

  it('enviar-parte-direto-ao-storage-e-retomar', async () => {
    const before = await getParts(publicId, ownerToken).expect(200);
    expect(before.body).toEqual({
      part_size: PART_SIZE,
      part_count: 2,
      uploaded_parts: [],
    });

    const urls = await postPartUrls(publicId, ownerToken, [1]).expect(200);
    const [part] = (urls.body as PartUrlsBody).parts;
    const put = await fetch(part.url, {
      method: 'PUT',
      body: Buffer.alloc(PART_SIZE, 1),
    });
    expect(put.status).toBe(200);
    expect(put.headers.get('etag')).toBeTruthy();

    const after = await getParts(publicId, ownerToken).expect(200);
    expect((after.body as { uploaded_parts: unknown }).uploaded_parts).toEqual([
      { part_number: 1, size: PART_SIZE },
    ]);
  });

  it('numeros-de-parte-invalidos', async () => {
    const outOfRange = await postPartUrls(publicId, ownerToken, [3]).expect(
      400,
    );
    expect(outOfRange.body).toMatchObject({ error: 'INVALID_PART_NUMBER' });

    const tooMany = await postPartUrls(
      publicId,
      ownerToken,
      Array.from({ length: 101 }, (_, i) => i + 1),
    ).expect(400);
    expect(tooMany.body).toMatchObject({ error: 'VALIDATION_ERROR' });

    const repeated = await postPartUrls(publicId, ownerToken, [1, 1]).expect(
      400,
    );
    expect(repeated.body).toMatchObject({ error: 'VALIDATION_ERROR' });
  });

  it('outro-usuario-ou-inexistente-retorna-404', async () => {
    const responses = [
      await postPartUrls(publicId, otherToken, [1]),
      await getParts(publicId, otherToken),
    ];
    for (const id of ['AAAAAAAAAAA', 'abc']) {
      responses.push(await postPartUrls(id, ownerToken, [1]));
      responses.push(await getParts(id, ownerToken));
    }

    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        error: 'VIDEO_NOT_FOUND',
        message: 'Video not found',
      });
    }
  });

  it('upload-nao-ativo-retorna-409', async () => {
    await dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, { status: VideoStatus.PROCESSING });

    const responses = [
      await postPartUrls(publicId, ownerToken, [1]),
      await getParts(publicId, ownerToken),
    ];
    for (const res of responses) {
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'VIDEO_UPLOAD_NOT_ACTIVE' });
    }
  });
});
