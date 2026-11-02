import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

// Second entrypoint of the same codebase: queue consumers, no HTTP server.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // Close BullMQ workers gracefully on SIGTERM so in-flight jobs are not
  // left stalled and re-delivered.
  app.enableShutdownHooks();
  new Logger('Worker').log('Video worker started');
}

void bootstrap();
