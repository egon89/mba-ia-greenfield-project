import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  type ValueTransformer,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export type VideoFailureReason =
  | 'invalid_media'
  | 'processing_failed'
  | 'upload_abandoned'
  | 'upload_size_mismatch';

// pg returns bigint as a string; video sizes (≤ 10 GiB) fit safely in a JS number.
const bigintToNumber: ValueTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index(['status', 'created_at'])
@Index(['status', 'updated_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 11 })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'enum', enum: VideoStatus, default: VideoStatus.DRAFT })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 50, nullable: true })
  failure_reason: VideoFailureReason | null;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 255 })
  content_type: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  declared_size_bytes: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumber })
  size_bytes: number | null;

  @Column({ type: 'double precision', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'integer', nullable: true })
  width: number | null;

  @Column({ type: 'integer', nullable: true })
  height: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  mime_type: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  video_codec: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  audio_codec: string | null;

  @Column({ type: 'integer', nullable: true })
  bitrate: number | null;

  @Column({ type: 'double precision', nullable: true })
  frame_rate: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, (channel) => channel.videos)
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}
