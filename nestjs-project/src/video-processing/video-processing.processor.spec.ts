import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-processing.producer';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailExtractorService } from './thumbnail-extractor.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const VIDEO_ID = '7f1c2d3e-0000-4000-8000-000000000001';

function jobAfterAttempt(attemptsMade: number): Job<ProcessVideoJobData> {
  return {
    data: { videoId: VIDEO_ID },
    attemptsMade,
    opts: { attempts: 3 },
  } as Job<ProcessVideoJobData>;
}

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  const videoRepository = { update: jest.fn(), findOneBy: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.update.mockResolvedValue({ affected: 1 });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const module = await Test.createTestingModule({
      providers: [
        VideoProcessingProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: {} },
        { provide: MediaProbeService, useValue: {} },
        { provide: ThumbnailExtractorService, useValue: {} },
      ],
    }).compile();

    processor = module.get(VideoProcessingProcessor);
  });

  describe('onFailed', () => {
    it('should mark the video as invalid_media on an UnrecoverableError', async () => {
      await processor.onFailed(
        jobAfterAttempt(1),
        new UnrecoverableError('Unrecognized media format'),
      );

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: 'invalid_media' },
      );
    });

    it('should mark the video as processing_failed after the last attempt', async () => {
      await processor.onFailed(jobAfterAttempt(3), new Error('ECONNRESET'));

      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.PROCESSING },
        { status: VideoStatus.FAILED, failure_reason: 'processing_failed' },
      );
    });

    it('should leave the row untouched after an intermediate attempt', async () => {
      await processor.onFailed(jobAfterAttempt(1), new Error('ECONNRESET'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('should do nothing when the job is undefined', async () => {
      await processor.onFailed(undefined, new Error('stalled'));

      expect(videoRepository.update).not.toHaveBeenCalled();
    });
  });
});
