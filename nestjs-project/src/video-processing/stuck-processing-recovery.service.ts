import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { Queue } from 'bullmq';
import { LessThan, type Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-processing.producer';

const MINUTE_MS = 60_000;

export interface StuckProcessingResult {
  requeued: number;
  failed: number;
}

// Videos left in `processing` for too long (TD-13): re-enqueue the ones whose
// job is gone, fail the ones whose job already failed, leave the rest alone.
@Injectable()
export class StuckProcessingRecoveryService {
  private readonly logger = new Logger(StuckProcessingRecoveryService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async recoverStuckProcessing(now: Date): Promise<StuckProcessingResult> {
    const cutoff = new Date(
      now.getTime() - this.config.processingStuckAfterMinutes * MINUTE_MS,
    );
    const stuck = await this.videoRepository.find({
      where: { status: VideoStatus.PROCESSING, updated_at: LessThan(cutoff) },
    });

    const result: StuckProcessingResult = { requeued: 0, failed: 0 };
    for (const video of stuck) {
      try {
        const outcome = await this.recover(video.id);
        if (outcome) result[outcome]++;
      } catch (error) {
        // Background job: log and move on to the next video.
        this.logger.error(
          `Failed to recover stuck video ${video.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return result;
  }

  private async recover(
    videoId: string,
  ): Promise<keyof StuckProcessingResult | null> {
    const job = await this.processingQueue.getJob(videoId);
    if (!job) {
      // The commit succeeded but the enqueue was lost.
      await this.processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId },
        { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId },
      );
      return 'requeued';
    }
    if ((await job.getState()) !== 'failed') {
      // waiting / active / delayed: the job is still on its way.
      return null;
    }
    // removeOnFail keeps the failed job under the same id for 7 days, so a
    // new add would be ignored: close the video instead.
    const update = await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: 'processing_failed' },
    );
    return update.affected ? 'failed' : null;
  }
}
