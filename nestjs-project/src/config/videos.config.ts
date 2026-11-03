import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  uploadPartSizeBytes: parseInt(
    process.env.UPLOAD_PART_SIZE_BYTES || '67108864',
    10,
  ),
  uploadAbandonAfterHours: parseInt(
    process.env.UPLOAD_ABANDON_AFTER_HOURS || '24',
    10,
  ),
  processingStuckAfterMinutes: parseInt(
    process.env.PROCESSING_STUCK_AFTER_MINUTES || '120',
    10,
  ),
}));
