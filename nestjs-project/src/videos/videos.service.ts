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
import { generatePublicId, isValidPublicId } from './public-id.util';
import { videoOriginalKey } from '../storage/storage-keys';
import { partContentLength, partCount } from './upload-parts.util';
import {
  PART_URL_EXPIRES_IN_SECONDS,
  PUBLIC_ID_MAX_RETRIES,
} from './videos.constants';
import {
  InvalidPartNumberException,
  VideoNotFoundException,
  VideoUploadNotActiveException,
} from './videos.exceptions';

const PUBLIC_ID_COLUMN = 'public_id';

export interface InitiatedUpload {
  video: Video;
  partSize: number;
  partCount: number;
}

export interface IssuedPartUrl {
  partNumber: number;
  url: string;
  contentLength: number;
}

export interface IssuedPartUrls {
  parts: IssuedPartUrl[];
  expiresIn: number;
}

export interface UploadedPartsSummary {
  partSize: number;
  partCount: number;
  uploadedParts: { partNumber: number; size: number }[];
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
    const count = partCount(dto.size_bytes, partSize);
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
    return { video, partSize, partCount: count };
  }

  // Unknown, malformed and other users' videos all look the same (TD-11).
  async findOwnedByPublicId(userId: string, publicId: string): Promise<Video> {
    if (!isValidPublicId(publicId)) throw new VideoNotFoundException();
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  async issuePartUrls(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<IssuedPartUrls> {
    const { video, uploadId } = await this.findActiveDraft(userId, publicId);
    const partSize = this.config.uploadPartSizeBytes;
    const size = video.declared_size_bytes;
    const count = partCount(size, partSize);
    if (partNumbers.some((n) => n > count)) {
      throw new InvalidPartNumberException();
    }

    const key = videoOriginalKey(video.id);
    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => {
        const contentLength = partContentLength(partNumber, size, partSize);
        const url = await this.storageService.presignUploadPart(
          key,
          uploadId,
          partNumber,
          contentLength,
          PART_URL_EXPIRES_IN_SECONDS,
        );
        return { partNumber, url, contentLength };
      }),
    );
    return { parts, expiresIn: PART_URL_EXPIRES_IN_SECONDS };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<UploadedPartsSummary> {
    const { video, uploadId } = await this.findActiveDraft(userId, publicId);
    const partSize = this.config.uploadPartSizeBytes;
    const parts = await this.storageService.listParts(
      videoOriginalKey(video.id),
      uploadId,
    );
    return {
      partSize,
      partCount: partCount(video.declared_size_bytes, partSize),
      uploadedParts: parts.map(({ partNumber, size }) => ({
        partNumber,
        size,
      })),
    };
  }

  // A draft always has an open multipart upload (initiateUpload sets both).
  private async findActiveDraft(
    userId: string,
    publicId: string,
  ): Promise<{ video: Video; uploadId: string }> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoUploadNotActiveException();
    }
    return { video, uploadId: video.upload_id };
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
