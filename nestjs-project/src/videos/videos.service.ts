import { randomUUID } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import { videoOriginalKey } from '../storage/storage-keys';
import { PUBLIC_ID_MAX_RETRIES } from './videos.constants';

const PUBLIC_ID_COLUMN = 'public_id';

export interface InitiatedUpload {
  video: Video;
  partSize: number;
  partCount: number;
}

// "a.b.mp4" → "a.b"; a name without an extension (or a dotfile) stays whole.
export function titleFromFilename(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiatedUpload> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      // Every user gets a channel at registration (Phase 02).
      throw new Error(`Channel not found for user ${userId}`);
    }

    const id = randomUUID();
    const partSize = this.config.uploadPartSizeBytes;
    const partCount = Math.ceil(dto.size_bytes / partSize);
    const key = videoOriginalKey(id);

    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.content_type,
    );

    try {
      await this.insertDraft({
        id,
        channel_id: channel.id,
        title: titleFromFilename(dto.filename),
        original_filename: dto.filename,
        content_type: dto.content_type,
        declared_size_bytes: dto.size_bytes,
        upload_id: uploadId,
        status: VideoStatus.DRAFT,
      });
    } catch (err) {
      // No row points at the multipart upload — release it in storage.
      await this.storageService.abortMultipartUpload(key, uploadId);
      throw err;
    }

    const video = await this.videoRepository.findOneByOrFail({ id });
    return { video, partSize, partCount };
  }

  private async insertDraft(fields: Omit<Partial<Video>, 'public_id'>) {
    for (let attempt = 0; attempt <= PUBLIC_ID_MAX_RETRIES; attempt++) {
      try {
        await this.videoRepository.insert({
          ...fields,
          public_id: generatePublicId(),
        });
        return;
      } catch (err) {
        if (!isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) throw err;
      }
    }
    throw new Error('public_id conflict could not be resolved after retries');
  }
}
