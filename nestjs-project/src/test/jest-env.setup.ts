// Runs before every test file (Jest setupFiles). Test queues use their own
// Redis key prefix so they never reach the running video-worker ('bull').
process.env.QUEUE_PREFIX = 'test';
