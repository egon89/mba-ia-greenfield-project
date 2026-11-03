import { registerAs } from '@nestjs/config';

// Prefix of the BullMQ keys in Redis. Tests use their own prefix so their
// queues never reach the running video-worker.
export default registerAs('queue', () => ({
  prefix: process.env.QUEUE_PREFIX || 'bull',
}));
