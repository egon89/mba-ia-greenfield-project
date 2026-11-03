import { ApiProperty } from '@nestjs/swagger';
import {
  type Video,
  type VideoFailureReason,
  VideoStatus,
} from '../entities/video.entity';

const FAILURE_REASONS: VideoFailureReason[] = [
  'invalid_media',
  'processing_failed',
  'upload_abandoned',
  'upload_size_mismatch',
];

// Public shape of a video. Internal fields (id, channel_id, upload_id,
// declared_size_bytes, thumbnail_key) are never serialized.
export class VideoResponseDto {
  @ApiProperty({ example: 'aZ09-_bY8xW', minLength: 11, maxLength: 11 })
  public_id: string;

  @ApiProperty()
  title: string;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ enum: VideoStatus })
  status: VideoStatus;

  @ApiProperty({ enum: FAILURE_REASONS, nullable: true })
  failure_reason: VideoFailureReason | null;

  @ApiProperty()
  original_filename: string;

  @ApiProperty()
  content_type: string;

  @ApiProperty({ type: Number, nullable: true })
  size_bytes: number | null;

  @ApiProperty({ type: Number, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ type: Number, nullable: true })
  width: number | null;

  @ApiProperty({ type: Number, nullable: true })
  height: number | null;

  @ApiProperty({ type: String, nullable: true })
  mime_type: string | null;

  @ApiProperty({ type: String, nullable: true })
  video_codec: string | null;

  @ApiProperty({ type: String, nullable: true })
  audio_codec: string | null;

  @ApiProperty({ type: Number, nullable: true })
  bitrate: number | null;

  @ApiProperty({ type: Number, nullable: true })
  frame_rate: number | null;

  @ApiProperty({ format: 'date-time' })
  created_at: string;

  @ApiProperty({ format: 'date-time' })
  updated_at: string;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    public_id: video.public_id,
    title: video.title,
    description: video.description,
    status: video.status,
    failure_reason: video.failure_reason,
    original_filename: video.original_filename,
    content_type: video.content_type,
    size_bytes: video.size_bytes,
    duration_seconds: video.duration_seconds,
    width: video.width,
    height: video.height,
    mime_type: video.mime_type,
    video_codec: video.video_codec,
    audio_codec: video.audio_codec,
    bitrate: video.bitrate,
    frame_rate: video.frame_rate,
    created_at: video.created_at.toISOString(),
    updated_at: video.updated_at.toISOString(),
  };
}
