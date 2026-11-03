import { Injectable } from '@nestjs/common';
import { runProcess } from './run-process';

// The file is not a playable video: retrying will not help (TD-09, TD-13).
export class InvalidMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMediaError';
  }
}

export interface MediaMetadata {
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  bitrate: number | null;
  frame_rate: number | null;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    bit_rate?: string;
  };
}

// ffprobe's message when the input matches no known container format.
const UNRECOGNIZED_INPUT = 'Invalid data found when processing input';

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// "30000/1001" → 29.97…; "0/0" (unknown) → null.
function parseFrameRate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const [numerator, denominator] = value.split('/').map(Number);
  if (!denominator || !Number.isFinite(numerator)) return null;
  const rate = numerator / denominator;
  return rate > 0 ? rate : null;
}

export function parseProbeOutput(output: ProbeOutput): MediaMetadata {
  const streams = output.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new InvalidMediaError('No video stream found');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const bitrate = toNumber(output.format?.bit_rate);

  return {
    duration_seconds: toNumber(output.format?.duration),
    width: video.width ?? null,
    height: video.height ?? null,
    mime_type: output.format?.format_name ?? null,
    video_codec: video.codec_name ?? null,
    audio_codec: audio?.codec_name ?? null,
    bitrate: bitrate === null ? null : Math.round(bitrate),
    frame_rate: parseFrameRate(video.avg_frame_rate),
  };
}

@Injectable()
export class MediaProbeService {
  async probe(url: string): Promise<MediaMetadata> {
    const { code, stdout, stderr } = await runProcess('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      url,
    ]);
    if (code !== 0) {
      if (stderr.includes(UNRECOGNIZED_INPUT)) {
        throw new InvalidMediaError('Unrecognized media format');
      }
      // Network or storage problem: a temporary error, retried by BullMQ.
      throw new Error(`ffprobe exited with code ${code}: ${stderr.trim()}`);
    }
    return parseProbeOutput(JSON.parse(stdout.toString('utf8')) as ProbeOutput);
  }
}
