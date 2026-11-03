import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import videosConfig from '../config/videos.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { StuckProcessingRecoveryService } from './stuck-processing-recovery.service';

const STUCK_AFTER_MINUTES = 120;
const NOW = new Date('2026-11-02T12:00:00.000Z');
const VIDEO_ID = '7f1c2d3e-0000-4000-8000-000000000002';

describe('StuckProcessingRecoveryService', () => {
  let service: StuckProcessingRecoveryService;
  const videoRepository = { find: jest.fn(), update: jest.fn() };
  const processingQueue = { getJob: jest.fn(), add: jest.fn() };

  const jobInState = (state: string) => ({
    getState: jest.fn().mockResolvedValue(state),
  });

  beforeEach(async () => {
    jest.resetAllMocks();
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID } as Video]);
    videoRepository.update.mockResolvedValue({ affected: 1 });

    const module = await Test.createTestingModule({
      providers: [
        StuckProcessingRecoveryService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: processingQueue,
        },
        {
          provide: videosConfig.KEY,
          useValue: { processingStuckAfterMinutes: STUCK_AFTER_MINUTES },
        },
      ],
    }).compile();

    service = module.get(StuckProcessingRecoveryService);
  });

  it('should select processing videos last updated before now minus the threshold', async () => {
    videoRepository.find.mockResolvedValue([]);

    await service.recoverStuckProcessing(NOW);

    const { where } = videoRepository.find.mock.calls[0][0];
    expect(where.status).toBe(VideoStatus.PROCESSING);
    expect(where.updated_at.value).toEqual(
      new Date(NOW.getTime() - STUCK_AFTER_MINUTES * 60_000),
    );
  });

  it('should re-enqueue process-video with jobId = video id when there is no job', async () => {
    processingQueue.getJob.mockResolvedValue(undefined);

    const result = await service.recoverStuckProcessing(NOW);

    expect(processingQueue.add).toHaveBeenCalledWith(
      PROCESS_VIDEO_JOB,
      { videoId: VIDEO_ID },
      { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: VIDEO_ID },
    );
    expect(videoRepository.update).not.toHaveBeenCalled();
    expect(result).toEqual({ requeued: 1, failed: 0 });
  });

  it('should mark the video as processing_failed when its job failed', async () => {
    processingQueue.getJob.mockResolvedValue(jobInState('failed'));

    const result = await service.recoverStuckProcessing(NOW);

    expect(videoRepository.update).toHaveBeenCalledWith(
      { id: VIDEO_ID, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'processing_failed' },
    );
    expect(processingQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ requeued: 0, failed: 1 });
  });

  it('should not count a failed job whose video already left processing', async () => {
    processingQueue.getJob.mockResolvedValue(jobInState('failed'));
    videoRepository.update.mockResolvedValue({ affected: 0 });

    const result = await service.recoverStuckProcessing(NOW);

    expect(result).toEqual({ requeued: 0, failed: 0 });
  });

  it.each(['waiting', 'active', 'delayed'])(
    'should leave the video alone when its job is %s',
    async (state) => {
      processingQueue.getJob.mockResolvedValue(jobInState(state));

      const result = await service.recoverStuckProcessing(NOW);

      expect(processingQueue.add).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(result).toEqual({ requeued: 0, failed: 0 });
    },
  );

  it('should log and continue with the next video when one recovery throws', async () => {
    const otherId = '7f1c2d3e-0000-4000-8000-000000000003';
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    videoRepository.find.mockResolvedValue([{ id: VIDEO_ID }, { id: otherId }]);
    processingQueue.getJob
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(undefined);

    const result = await service.recoverStuckProcessing(NOW);

    expect(processingQueue.add).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ requeued: 1, failed: 0 });
  });
});
