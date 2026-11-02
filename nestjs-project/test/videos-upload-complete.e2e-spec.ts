import { ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { getQueueToken } from '@nestjs/bullmq';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import type { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { S3_CLIENT } from '../src/storage/storage.constants';
import { videoOriginalKey, videoPrefix } from '../src/storage/storage-keys';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { registerConfirmAndLogin } from './helpers/auth.helper';

const MiB = 1_048_576;
const PART_SIZE = 5 * MiB;
const VIDEO_SIZE = 6 * MiB; // part_count 2
// The signature binds the host, and `localhost:9000` is not reachable from
// inside the container — sign for the Compose service instead.
const TEST_ENV = {
  S3_PUBLIC_ENDPOINT: 'http://storage:9000',
  UPLOAD_PART_SIZE_BYTES: String(PART_SIZE),
};

interface PartUrlsBody {
  parts: { part_number: number; url: string; content_length: number }[];
}

describe('POST /videos/:publicId/upload/complete (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let storage: StorageService;
  let s3: S3Client;
  let queue: Queue;
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
    s3 = moduleFixture.get<S3Client>(S3_CLIENT);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    try {
      await queue.obliterate({ force: true });
    } finally {
      await app.close();
      for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await storage.deletePrefix('videos/');
    await queue.obliterate({ force: true });
    throttlerStorage.storage.clear();
    ({ access_token: ownerToken } = await registerConfirmAndLogin(
      app,
      'owner@example.com',
    ));
    ({ access_token: otherToken } = await registerConfirmAndLogin(
      app,
      'other@example.com',
    ));
    publicId = await createDraft();
  });

  async function createDraft(): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        filename: 'clip.mp4',
        size_bytes: VIDEO_SIZE,
        content_type: 'video/mp4',
      })
      .expect(201);
    return (res.body as { public_id: string }).public_id;
  }

  async function uploadParts(id: string, partNumbers: number[]) {
    const res = await request(app.getHttpServer())
      .post(`/videos/${id}/upload/part-urls`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ part_numbers: partNumbers })
      .expect(200);
    for (const part of (res.body as PartUrlsBody).parts) {
      const put = await fetch(part.url, {
        method: 'PUT',
        body: Buffer.alloc(part.content_length, part.part_number),
      });
      expect(put.status).toBe(200);
    }
  }

  function complete(id: string, token = ownerToken) {
    return request(app.getHttpServer())
      .post(`/videos/${id}/upload/complete`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function findVideo(id: string): Promise<Video> {
    return dataSource.getRepository(Video).findOneByOrFail({ public_id: id });
  }

  async function jobCount(): Promise<number> {
    return queue.getJobCountByTypes(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'completed',
      'failed',
    );
  }

  it('concluir-upload-move-para-processing-e-enfileira', async () => {
    await uploadParts(publicId, [1, 2]);

    const res = await complete(publicId).expect(200);

    expect(res.body).toMatchObject({
      public_id: publicId,
      status: 'processing',
      size_bytes: VIDEO_SIZE,
      failure_reason: null,
    });
    const video = await findVideo(publicId);
    expect(video.upload_id).toBeNull();
    expect(await jobCount()).toBe(1);
    const job = await queue.getJob(video.id);
    expect(job?.name).toBe('process-video');
    expect(job?.data).toEqual({ videoId: video.id });
    await expect(
      storage.headObject(videoOriginalKey(video.id)),
    ).resolves.toMatchObject({ contentLength: VIDEO_SIZE });
  });

  it('repetir-complete-e-idempotente', async () => {
    await uploadParts(publicId, [1, 2]);
    await complete(publicId).expect(200);

    const res = await complete(publicId).expect(200);

    expect(res.body).toMatchObject({
      status: 'processing',
      size_bytes: VIDEO_SIZE,
    });
    expect(await jobCount()).toBe(1);
  });

  it('parte-faltando-retorna-upload-incomplete', async () => {
    await uploadParts(publicId, [1]);
    const before = await findVideo(publicId);

    const res = await complete(publicId).expect(409);

    expect(res.body).toMatchObject({ error: 'UPLOAD_INCOMPLETE' });
    const after = await findVideo(publicId);
    expect(after.status).toBe(VideoStatus.DRAFT);
    expect(after.upload_id).toBe(before.upload_id);
    expect(await jobCount()).toBe(0);
  });

  it('tamanho-divergente-marca-failed-e-apaga-objetos', async () => {
    await uploadParts(publicId, [1, 2]);
    await dataSource
      .getRepository(Video)
      .update({ public_id: publicId }, { declared_size_bytes: VIDEO_SIZE + 1 });

    const res = await complete(publicId).expect(422);

    expect(res.body).toMatchObject({ error: 'UPLOAD_SIZE_MISMATCH' });
    const video = await findVideo(publicId);
    expect(video).toMatchObject({
      status: VideoStatus.FAILED,
      failure_reason: 'upload_size_mismatch',
      upload_id: null,
    });
    const listing = await s3.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET,
        Prefix: videoPrefix(video.id),
      }),
    );
    expect(listing.Contents ?? []).toEqual([]);
    expect(await jobCount()).toBe(0);
  });

  it('estado-final-ou-outro-dono-e-rejeitado', async () => {
    const videos = dataSource.getRepository(Video);

    await videos.update(
      { public_id: publicId },
      { status: VideoStatus.READY, upload_id: null },
    );
    const ready = await complete(publicId).expect(409);
    expect(ready.body).toMatchObject({ error: 'VIDEO_UPLOAD_NOT_ACTIVE' });

    await videos.update(
      { public_id: publicId },
      { status: VideoStatus.FAILED, failure_reason: 'processing_failed' },
    );
    const failed = await complete(publicId).expect(409);
    expect(failed.body).toMatchObject({ error: 'VIDEO_UPLOAD_NOT_ACTIVE' });

    const otherDraft = await createDraft();
    await uploadParts(otherDraft, [1, 2]);
    const notOwner = await complete(otherDraft, otherToken).expect(404);
    expect(notOwner.body).toMatchObject({ error: 'VIDEO_NOT_FOUND' });
    expect((await findVideo(otherDraft)).status).toBe(VideoStatus.DRAFT);
    expect(await jobCount()).toBe(0);
  });
});
