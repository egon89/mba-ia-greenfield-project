import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VIDEO_MAINTENANCE_QUEUE } from '../queue/queue.constants';
import { AbandonedUploadsCleanupService } from './abandoned-uploads-cleanup.service';
import { StuckProcessingRecoveryService } from './stuck-processing-recovery.service';

// Consumes the hourly cleanup-abandoned-uploads job (TD-07, TD-13).
@Processor(VIDEO_MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly abandonedUploads: AbandonedUploadsCleanupService,
    private readonly stuckProcessing: StuckProcessingRecoveryService,
  ) {
    super();
  }

  async process(): Promise<void> {
    const abandoned = await this.abandonedUploads.cleanupAbandonedDrafts(
      new Date(),
    );
    const { requeued, failed } =
      await this.stuckProcessing.recoverStuckProcessing(new Date());
    this.logger.log(
      `Maintenance: ${abandoned} abandoned drafts, ${requeued} stuck videos re-enqueued, ${failed} stuck videos failed`,
    );
  }
}
