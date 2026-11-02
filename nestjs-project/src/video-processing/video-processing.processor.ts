import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { type Job, UnrecoverableError } from 'bullmq';
import type { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { videoOriginalKey, videoThumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import {
  Video,
  type VideoFailureReason,
  VideoStatus,
} from '../videos/entities/video.entity';
import type { ProcessVideoJobData } from '../videos/video-processing.producer';
import {
  InvalidMediaError,
  type MediaMetadata,
  MediaProbeService,
} from './media-probe.service';
import { ThumbnailExtractorService } from './thumbnail-extractor.service';
import {
  INTERNAL_READ_URL_EXPIRES_IN_SECONDS,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_POSITION_RATIO,
} from './video-processing.constants';

// Consumes process-video: metadata + thumbnail, then processing → ready.
// Every step is idempotent, so at-least-once delivery is safe (TD-13).
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    private readonly mediaProbe: MediaProbeService,
    private readonly thumbnailExtractor: ThumbnailExtractorService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOneBy({ id: videoId });
    // Re-delivery after success, or a row that no longer exists.
    if (!video || video.status !== VideoStatus.PROCESSING) return;

    const url = await this.storage.presignInternalGetObject(
      videoOriginalKey(videoId),
      INTERNAL_READ_URL_EXPIRES_IN_SECONDS,
    );

    let metadata: MediaMetadata;
    try {
      metadata = await this.mediaProbe.probe(url);
    } catch (error) {
      if (error instanceof InvalidMediaError) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }

    const thumbnail = await this.extractThumbnail(
      url,
      metadata.duration_seconds,
    );
    const thumbnailKey = videoThumbnailKey(videoId);
    await this.storage.putObject(
      thumbnailKey,
      thumbnail,
      THUMBNAIL_CONTENT_TYPE,
    );

    await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        ...metadata,
        thumbnail_key: thumbnailKey,
        status: VideoStatus.READY,
        failure_reason: null,
      },
    );
  }

  // Runs after every failed attempt; only a permanent error or the last
  // attempt marks the video as failed. attemptsMade already counts this one.
  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const reason = this.failureReason(job, error);
    if (!reason) return;

    this.logger.error(
      `Video ${job.data.videoId} failed (${reason}): ${error.message}`,
    );
    await this.videoRepository.update(
      { id: job.data.videoId, status: VideoStatus.PROCESSING },
      { status: VideoStatus.FAILED, failure_reason: reason },
    );
  }

  private failureReason(
    job: Job<ProcessVideoJobData>,
    error: Error,
  ): VideoFailureReason | null {
    if (error instanceof UnrecoverableError) return 'invalid_media';
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      return 'processing_failed';
    }
    return null;
  }

  // Frame at 10 % of the duration; very short clips fall back to frame 0.
  private async extractThumbnail(
    url: string,
    durationSeconds: number | null,
  ): Promise<Buffer> {
    const at = (durationSeconds ?? 0) * THUMBNAIL_POSITION_RATIO;
    let frame = await this.thumbnailExtractor.extractFrame(url, at);
    if (frame.length === 0 && at > 0) {
      frame = await this.thumbnailExtractor.extractFrame(url, 0);
    }
    if (frame.length === 0) throw new Error('ffmpeg produced no frame');
    return frame;
  }
}
