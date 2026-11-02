import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  CLEANUP_ABANDONED_UPLOADS_JOB,
  VIDEO_MAINTENANCE_QUEUE,
} from '../queue/queue.constants';
import { MAINTENANCE_INTERVAL_MS } from './video-processing.constants';

// Registers the hourly maintenance job. Upsert is idempotent per scheduler
// id, so running it on every worker boot keeps a single scheduler (TD-07).
@Injectable()
export class MaintenanceSchedulerService implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.maintenanceQueue.upsertJobScheduler(
      CLEANUP_ABANDONED_UPLOADS_JOB,
      { every: MAINTENANCE_INTERVAL_MS },
      { name: CLEANUP_ABANDONED_UPLOADS_JOB },
    );
  }
}
