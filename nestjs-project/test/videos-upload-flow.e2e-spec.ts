import { readFile } from 'node:fs/promises';
import {
  type INestApplication,
  type INestApplicationContext,
  ValidationPipe,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import {
  videoOriginalKey,
  videoThumbnailKey,
} from '../src/storage/storage-keys';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createVideoFixtures,
  type GeneratedMp4,
  generateMp4OfAtLeast,
  type VideoFixtures,
} from '../src/test/video-fixtures';
import { Video } from '../src/videos/entities/video.entity';
import { WorkerModule } from '../src/worker/worker.module';
import { registerConfirmAndLogin } from './helpers/auth.helper';

const MiB = 1_048_576;
const KiB = 1024;
const PART_SIZE = 5 * MiB;
const STORAGE_HOST = 'storage:9000';
// The SigV4 signature binds the host, and `localhost:9000` is not reachable
// from inside the container — sign for the Compose service instead.
const TEST_ENV = {
  S3_PUBLIC_ENDPOINT: `http://${STORAGE_HOST}`,
  UPLOAD_PART_SIZE_BYTES: String(PART_SIZE),
};
const READY_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 500;

interface VideoBody {
  public_id: string;
  status: string;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
}

interface InitiateBody extends VideoBody {
  upload: { part_size: number; part_count: number };
}

interface PartUrlsBody {
  parts: { part_number: number; url: string; content_length: number }[];
}

describe('Video upload flow: multipart direct to storage → worker → stream (e2e)', () => {
  let app: INestApplication<App>;
  let worker: INestApplicationContext;
  let dataSource: DataSource;
  let storage: StorageService;
  let large: GeneratedMp4;
  let fixtures: VideoFixtures;
  let apiBodyBytes = 0;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const [name, value] of Object.entries(TEST_ENV)) {
      originalEnv[name] = process.env[name];
      process.env[name] = value;
    }

    // > 10 MiB → 3 parts of 5 MiB.
    large = await generateMp4OfAtLeast(10 * MiB + 1);
    fixtures = await createVideoFixtures();

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Registered before init, so it runs ahead of the body parsers and sees
    // every byte of every request body the API receives.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      req.on('data', (chunk: Buffer) => {
        apiBodyBytes += chunk.length;
      });
      next();
    });
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
    moduleFixture
      .get<ThrottlerStorageService>(ThrottlerStorage)
      .storage.clear();
    await cleanAllTables(dataSource);
    await storage.deletePrefix('videos/');

    // Same Redis / Postgres / RustFS, queue prefix 'test' (jest-env.setup):
    // the running video-worker ('bull') never sees these jobs.
    worker = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error', 'warn'],
    });
  });

  afterAll(async () => {
    try {
      await worker?.close();
      await storage?.deletePrefix('videos/');
      await app?.close();
      await large?.cleanup();
      await fixtures?.cleanup();
    } finally {
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  function api(method: 'get' | 'post', path: string, token: string) {
    return request(app.getHttpServer())
      [method](path)
      .set('Authorization', `Bearer ${token}`);
  }

  // POST /videos → part-urls → PUT each slice straight to storage → complete.
  async function upload(
    token: string,
    filename: string,
    file: Buffer,
  ): Promise<{ publicId: string; partUrls: string[] }> {
    const initiated = await api('post', '/videos', token)
      .send({
        filename,
        size_bytes: file.length,
        content_type: 'video/mp4',
      })
      .expect(201);
    const { public_id: publicId, upload: layout } =
      initiated.body as InitiateBody;
    const partNumbers = Array.from(
      { length: layout.part_count },
      (_, i) => i + 1,
    );

    const urls = await api(
      'post',
      `/videos/${publicId}/upload/part-urls`,
      token,
    )
      .send({ part_numbers: partNumbers })
      .expect(200);
    const { parts } = urls.body as PartUrlsBody;

    for (const part of parts) {
      const start = (part.part_number - 1) * layout.part_size;
      // Copy into a plain Uint8Array: fetch's BodyInit does not accept a
      // Buffer backed by ArrayBufferLike.
      const slice = new Uint8Array(
        file.subarray(start, start + part.content_length),
      );
      const put = await fetch(part.url, { method: 'PUT', body: slice });
      expect(put.status).toBe(200);
    }

    await api('post', `/videos/${publicId}/upload/complete`, token).expect(200);
    return { publicId, partUrls: parts.map((part) => part.url) };
  }

  async function waitUntilReady(
    token: string,
    publicId: string,
  ): Promise<VideoBody> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      const res = await api('get', `/videos/${publicId}`, token).expect(200);
      const body = res.body as VideoBody;
      if (body.status === 'ready') return body;
      if (body.status === 'failed' || Date.now() > deadline) {
        throw new Error(
          `Video ${publicId} did not become ready: ${JSON.stringify(body)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  it('uploads parts straight to storage, processes the video to ready and streams it', async () => {
    const file = await readFile(large.path);
    expect(file.length).toBeGreaterThan(10 * MiB);
    apiBodyBytes = 0;

    const { access_token: token } = await registerConfirmAndLogin(
      app,
      'uploader@example.com',
    );
    const { publicId, partUrls } = await upload(token, 'large.mp4', file);

    // Upload: parts went to storage, not to the API.
    expect(partUrls).toHaveLength(3);
    for (const url of partUrls) {
      expect(new URL(url).host).toBe(STORAGE_HOST);
    }
    expect(apiBodyBytes).toBeLessThan(10 * KiB);
    const { id } = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
    await expect(storage.headObject(videoOriginalKey(id))).resolves.toEqual(
      expect.objectContaining({ contentLength: file.length }),
    );

    // Processing: the in-process worker takes the video to ready.
    const ready = await waitUntilReady(token, publicId);
    expect(ready.duration_seconds).toBeCloseTo(large.durationSeconds, 1);
    expect(ready.width).toBe(large.width);
    expect(ready.height).toBe(large.height);

    const row = await dataSource.getRepository(Video).findOneByOrFail({ id });
    expect(row.thumbnail_key).toBe(videoThumbnailKey(id));
    await expect(storage.headObject(videoThumbnailKey(id))).resolves.toEqual(
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );

    // Streaming: 302 to a presigned URL that serves Range → 206.
    const stream = await api('get', `/videos/${publicId}/stream`, token).expect(
      302,
    );
    const ranged = await fetch(stream.headers.location, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect((await ranged.arrayBuffer()).byteLength).toBe(1024);

    // Unique URL: a second upload gets a different public_id.
    const second = await upload(
      token,
      'second.mp4',
      await readFile(fixtures.withAudio),
    );
    expect(second.publicId).not.toBe(publicId);
    await waitUntilReady(token, second.publicId);
  });
});
