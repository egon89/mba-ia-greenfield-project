import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FIXTURE_WIDTH = 320;
export const FIXTURE_HEIGHT = 240;

export interface VideoFixtures {
  dir: string;
  // 2 s, 320x240 @ 25 fps, H.264 + AAC.
  withAudio: string;
  // 0.2 s, 160x120, H.264 only.
  shortNoAudio: string;
  // Plain text renamed to .mp4.
  invalid: string;
  cleanup: () => Promise<void>;
}

const VIDEO_ARGS = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'];
// moov atom first, so ffprobe reads metadata with few Range requests.
const MP4_ARGS = ['-movflags', '+faststart'];

// Generates the fixtures with ffmpeg's lavfi sources in a fresh temp dir.
export async function createVideoFixtures(): Promise<VideoFixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'video-fixtures-'));
  const withAudio = join(dir, 'with-audio.mp4');
  const shortNoAudio = join(dir, 'short-no-audio.mp4');
  const invalid = join(dir, 'invalid.mp4');

  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=2:size=${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}:rate=25`,
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    ...VIDEO_ARGS,
    '-c:a',
    'aac',
    '-shortest',
    ...MP4_ARGS,
    withAudio,
  ]);
  await execFileAsync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=0.2:size=160x120:rate=25',
    ...VIDEO_ARGS,
    ...MP4_ARGS,
    shortNoAudio,
  ]);
  await writeFile(invalid, 'this is not a video\n');

  return {
    dir,
    withAudio,
    shortNoAudio,
    invalid,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export const LARGE_FIXTURE_WIDTH = 1280;
export const LARGE_FIXTURE_HEIGHT = 720;
const LARGE_FIXTURE_RATE = 25;
const MAX_SIZE_ATTEMPTS = 6;

export interface GeneratedMp4 {
  path: string;
  sizeBytes: number;
  durationSeconds: number;
  width: number;
  height: number;
  cleanup: () => Promise<void>;
}

// A valid H.264 MP4 of at least `bytes`: testsrc2 encoded lossless (qp 0), so
// every frame is large; the duration doubles until the file is big enough.
export async function generateMp4OfAtLeast(
  bytes: number,
): Promise<GeneratedMp4> {
  const dir = await mkdtemp(join(tmpdir(), 'video-large-'));
  const path = join(dir, 'large.mp4');
  let durationSeconds = 1;

  for (let attempt = 0; attempt < MAX_SIZE_ATTEMPTS; attempt++) {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `testsrc2=duration=${durationSeconds}:size=${LARGE_FIXTURE_WIDTH}x${LARGE_FIXTURE_HEIGHT}:rate=${LARGE_FIXTURE_RATE}`,
      ...VIDEO_ARGS,
      '-preset',
      'ultrafast',
      '-qp',
      '0',
      ...MP4_ARGS,
      path,
    ]);
    const { size } = await stat(path);
    if (size >= bytes) {
      return {
        path,
        sizeBytes: size,
        durationSeconds,
        width: LARGE_FIXTURE_WIDTH,
        height: LARGE_FIXTURE_HEIGHT,
        cleanup: () => rm(dir, { recursive: true, force: true }),
      };
    }
    durationSeconds *= 2;
  }

  await rm(dir, { recursive: true, force: true });
  throw new Error(`Could not generate an MP4 of at least ${bytes} bytes`);
}
