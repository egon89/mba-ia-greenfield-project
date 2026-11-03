import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  createVideoFixtures,
  FIXTURE_HEIGHT,
  FIXTURE_WIDTH,
  type VideoFixtures,
} from '../test/video-fixtures';
import { InvalidMediaError, MediaProbeService } from './media-probe.service';
import { ThumbnailExtractorService } from './thumbnail-extractor.service';

const JPEG_MAGIC = Buffer.from([0xff, 0xd8]);

describe('MediaProbeService / ThumbnailExtractorService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  let probe: MediaProbeService;
  let extractor: ThumbnailExtractorService;
  let fixtures: VideoFixtures;
  const prefix = `test/media-tools/${randomUUID()}/`;
  const urls: Record<'withAudio' | 'shortNoAudio' | 'invalid', string> = {
    withAudio: '',
    shortNoAudio: '',
    invalid: '',
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
      providers: [MediaProbeService, ThumbnailExtractorService],
    }).compile();
    storage = module.get(StorageService);
    probe = module.get(MediaProbeService);
    extractor = module.get(ThumbnailExtractorService);

    fixtures = await createVideoFixtures();
    for (const name of Object.keys(urls) as (keyof typeof urls)[]) {
      const key = `${prefix}${name}`;
      await storage.putObject(key, await readFile(fixtures[name]), 'video/mp4');
      urls[name] = await storage.presignInternalGetObject(key, 600);
    }
  }, 60000);

  afterAll(async () => {
    await storage.deletePrefix(prefix);
    await fixtures.cleanup();
    await module.close();
  });

  describe('MediaProbeService.probe', () => {
    it('should read the metadata of the 2 s MP4 with audio over a presigned URL', async () => {
      const metadata = await probe.probe(urls.withAudio);

      expect(metadata.duration_seconds).toBeCloseTo(2, 0);
      expect(metadata.width).toBe(FIXTURE_WIDTH);
      expect(metadata.height).toBe(FIXTURE_HEIGHT);
      expect(metadata.video_codec).toBe('h264');
      expect(metadata.audio_codec).toBe('aac');
      expect(metadata.mime_type).toContain('mp4');
      expect(metadata.bitrate).toBeGreaterThan(0);
      expect(metadata.frame_rate).toBe(25);
    });

    it('should report a null audio codec for the clip without audio', async () => {
      const metadata = await probe.probe(urls.shortNoAudio);

      expect(metadata.audio_codec).toBeNull();
      expect(metadata.video_codec).toBe('h264');
    });

    it('should throw InvalidMediaError for a text file named .mp4', async () => {
      await expect(probe.probe(urls.invalid)).rejects.toBeInstanceOf(
        InvalidMediaError,
      );
    });

    it('should throw a plain (retryable) error when the object does not exist', async () => {
      const missing = await storage.presignInternalGetObject(
        `${prefix}missing`,
        600,
      );

      const error = await probe.probe(missing).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(InvalidMediaError);
    });
  });

  describe('ThumbnailExtractorService.extractFrame', () => {
    it('should return a non-empty JPEG frame at 10 % of the 2 s clip', async () => {
      const frame = await extractor.extractFrame(urls.withAudio, 0.2);

      expect(frame.length).toBeGreaterThan(0);
      expect(frame.subarray(0, 2)).toEqual(JPEG_MAGIC);
    });

    it('should return an empty buffer past the end and a frame at 0 for the 0.2 s clip', async () => {
      const pastEnd = await extractor.extractFrame(urls.shortNoAudio, 5);
      const first = await extractor.extractFrame(urls.shortNoAudio, 0);

      expect(pastEnd.length).toBe(0);
      expect(first.subarray(0, 2)).toEqual(JPEG_MAGIC);
    });
  });
});
