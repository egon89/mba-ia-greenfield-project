import { Injectable } from '@nestjs/common';
import { runProcess } from './run-process';

@Injectable()
export class ThumbnailExtractorService {
  // Returns one JPEG frame at `atSeconds`. The buffer is empty when the
  // position is past the last frame (very short clips); the caller retries at 0.
  async extractFrame(url: string, atSeconds: number): Promise<Buffer> {
    const { code, stdout, stderr } = await runProcess('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(atSeconds),
      '-i',
      url,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      'pipe:1',
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`);
    }
    return stdout;
  }
}
