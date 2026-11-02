import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { isPgUniqueViolationOnColumn } from '../common/database/pg-errors';
import videosConfig from '../config/videos.config';
import { isNoSuchUploadError } from '../storage/storage-errors';
import {
  type CompletedPart,
  StorageService,
  type UploadedPart,
} from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { generatePublicId, isValidPublicId } from './public-id.util';
import { videoOriginalKey, videoPrefix } from '../storage/storage-keys';
import { partContentLength, partCount } from './upload-parts.util';
import {
  PART_URL_EXPIRES_IN_SECONDS,
  PUBLIC_ID_MAX_RETRIES,
} from './videos.constants';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
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
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    private readonly producer: VideoProcessingProducer,
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

  // The owner reads the video in any status (used to poll processing).
  async getOwnedVideo(userId: string, publicId: string): Promise<Video> {
    return this.findOwnedByPublicId(userId, publicId);
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

  // Idempotent: a video already in processing is re-enqueued (TD-06, TD-13).
  async completeUpload(userId: string, publicId: string): Promise<Video> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    switch (video.status) {
      case VideoStatus.PROCESSING:
        await this.enqueueProcessing(video.id);
        return video;
      case VideoStatus.DRAFT:
        return this.completeDraft(userId, publicId, video);
      default:
        throw new VideoUploadNotActiveException();
    }
  }

  private async completeDraft(
    userId: string,
    publicId: string,
    video: Video,
  ): Promise<Video> {
    if (!video.upload_id) throw new VideoUploadNotActiveException();
    const key = videoOriginalKey(video.id);
    await this.completeMultipart(video, key, video.upload_id);

    const head = await this.storageService.headObject(key);
    if (head.contentLength !== video.declared_size_bytes) {
      await this.failSizeMismatch(video);
    }

    const result = await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.PROCESSING,
        size_bytes: head.contentLength,
        upload_id: null,
      },
    );
    if (!result.affected) {
      // A concurrent complete won the transition — answer like a repeat.
      const current = await this.findOwnedByPublicId(userId, publicId);
      if (current.status !== VideoStatus.PROCESSING) {
        throw new VideoUploadNotActiveException();
      }
      await this.enqueueProcessing(current.id);
      return current;
    }

    await this.enqueueProcessing(video.id);
    return this.videoRepository.findOneByOrFail({ id: video.id });
  }

  // Parts and ETags come from the API's own ListParts, never from the client.
  // NoSuchUpload means a previous complete may have finished in storage but
  // not in the database — the caller's HeadObject then proves the object
  // exists (and fails if it does not).
  private async completeMultipart(
    video: Video,
    key: string,
    uploadId: string,
  ): Promise<void> {
    let parts: UploadedPart[];
    try {
      parts = await this.storageService.listParts(key, uploadId);
    } catch (err) {
      if (!isNoSuchUploadError(err)) throw err;
      return;
    }

    const count = partCount(
      video.declared_size_bytes,
      this.config.uploadPartSizeBytes,
    );
    const byNumber = new Map(parts.map((part) => [part.partNumber, part]));
    const completed: CompletedPart[] = [];
    for (let partNumber = 1; partNumber <= count; partNumber++) {
      const part = byNumber.get(partNumber);
      if (!part) throw new UploadIncompleteException();
      completed.push({ partNumber, etag: part.etag });
    }

    await this.storageService.completeMultipartUpload(key, uploadId, completed);
  }

  // The row is kept as failed; its objects are removed (TD-05 step 3).
  private async failSizeMismatch(video: Video): Promise<never> {
    await this.videoRepository.update(
      { id: video.id, status: VideoStatus.DRAFT },
      {
        status: VideoStatus.FAILED,
        failure_reason: 'upload_size_mismatch',
        upload_id: null,
      },
    );
    await this.storageService.deletePrefix(videoPrefix(video.id));
    throw new UploadSizeMismatchException();
  }

  // The maintenance job re-enqueues videos stuck in processing, so a failed
  // enqueue does not fail the request (TD-12, TD-13).
  private async enqueueProcessing(videoId: string): Promise<void> {
    try {
      await this.producer.enqueue(videoId);
    } catch (err) {
      this.logger.error(
        `Failed to enqueue processing for video ${videoId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
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
