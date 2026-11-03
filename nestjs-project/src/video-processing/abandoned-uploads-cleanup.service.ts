import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, type Repository } from 'typeorm';
import videosConfig from '../config/videos.config';
import { videoOriginalKey, videoPrefix } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

const HOUR_MS = 3_600_000;

// Drafts whose upload never completed: mark them failed and free their
// storage. The row is kept (TD-07, TD-12).
@Injectable()
export class AbandonedUploadsCleanupService {
  private readonly logger = new Logger(AbandonedUploadsCleanupService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storage: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  // Returns how many drafts were marked as abandoned.
  async cleanupAbandonedDrafts(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.uploadAbandonAfterHours * HOUR_MS,
    );
    const drafts = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
    });

    let cleaned = 0;
    for (const draft of drafts) {
      try {
        if (await this.cleanup(draft)) cleaned++;
      } catch (error) {
        // Background job: log and move on to the next draft.
        this.logger.error(
          `Failed to clean up abandoned draft ${draft.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return cleaned;
  }

  private async cleanup(draft: Video): Promise<boolean> {
    // The conditional update runs first so a concurrent `complete` wins.
    const result = await this.videoRepository.update(
      { id: draft.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.FAILED,
        failure_reason: 'upload_abandoned',
        upload_id: null,
      },
    );
    if (!result.affected) return false;

    if (draft.upload_id) {
      await this.storage.abortMultipartUpload(
        videoOriginalKey(draft.id),
        draft.upload_id,
      );
    }
    await this.storage.deletePrefix(videoPrefix(draft.id));
    return true;
  }
}
