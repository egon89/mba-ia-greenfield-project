import type { JobsOptions } from 'bullmq';

export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';

export const PROCESS_VIDEO_JOB = 'process-video';
export const CLEANUP_ABANDONED_UPLOADS_JOB = 'cleanup-abandoned-uploads';

// TD-13: 3 attempts with exponential backoff; failed jobs kept for 7 days.
export const PROCESS_VIDEO_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10000 },
  removeOnComplete: true,
  removeOnFail: { age: 604800 },
} as const satisfies JobsOptions;
