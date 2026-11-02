import { Logger } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { isValidPublicId } from './public-id.util';
import { VideoProcessingProducer } from './video-processing.producer';
import {
  InvalidPartNumberException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  VideoNotFoundException,
  VideoUploadNotActiveException,
} from './videos.exceptions';
import { titleFromFilename, VideosService } from './videos.service';

const PART_SIZE = 67_108_864;
const USER_ID = 'user-1';
const CHANNEL_ID = 'channel-1';
const UPLOAD_ID = 'upload-1';

function uniqueViolation(column: string): QueryFailedError {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  } as unknown as Error);
}

describe('VideosService', () => {
  let service: VideosService;
  const videoRepository = {
    insert: jest.fn(),
    findOneByOrFail: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
    presignUploadPart: jest.fn(),
    listParts: jest.fn(),
    completeMultipartUpload: jest.fn(),
    headObject: jest.fn(),
    deletePrefix: jest.fn(),
  };
  const producer = { enqueue: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    channelsService.findByUserId.mockResolvedValue({ id: CHANNEL_ID });
    storageService.createMultipartUpload.mockResolvedValue(UPLOAD_ID);
    videoRepository.insert.mockResolvedValue({});
    videoRepository.findOneByOrFail.mockImplementation(({ id }) =>
      Promise.resolve({ id } as Video),
    );

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: ChannelsService, useValue: channelsService },
        { provide: StorageService, useValue: storageService },
        { provide: VideoProcessingProducer, useValue: producer },
        {
          provide: videosConfig.KEY,
          useValue: {
            uploadPartSizeBytes: PART_SIZE,
          } as ConfigType<typeof videosConfig>,
        },
      ],
    }).compile();

    service = module.get(VideosService);
  });

  const dto = (overrides = {}) => ({
    filename: 'Minha viagem.mp4',
    size_bytes: 150_000_000,
    content_type: 'video/mp4',
    ...overrides,
  });

  describe('titleFromFilename', () => {
    it.each([
      ['a.b.mp4', 'a.b'],
      ['Minha viagem.mp4', 'Minha viagem'],
      ['no-extension', 'no-extension'],
      ['.hidden', '.hidden'],
    ])('derives %s → %s', (filename, title) => {
      expect(titleFromFilename(filename)).toBe(title);
    });
  });

  describe('initiateUpload', () => {
    it("inserts a draft on the user's channel with the multipart upload id", async () => {
      await service.initiateUpload(USER_ID, dto({ filename: 'a.b.mp4' }));

      expect(channelsService.findByUserId).toHaveBeenCalledWith(USER_ID);
      const [key, contentType] = storageService.createMultipartUpload.mock
        .calls[0] as [string, string];
      expect(key).toMatch(/^videos\/[0-9a-f-]{36}\/original$/);
      expect(contentType).toBe('video/mp4');

      const inserted = videoRepository.insert.mock.calls[0][0] as Video;
      expect(inserted).toMatchObject({
        channel_id: CHANNEL_ID,
        title: 'a.b',
        original_filename: 'a.b.mp4',
        declared_size_bytes: 150_000_000,
        upload_id: UPLOAD_ID,
        status: VideoStatus.DRAFT,
      });
      expect(key).toBe(`videos/${inserted.id}/original`);
      expect(isValidPublicId(inserted.public_id)).toBe(true);
    });

    it.each([
      [PART_SIZE * 3, 3],
      [150_000_000, 3],
      [1, 1],
      [PART_SIZE + 1, 2],
    ])('computes part_count for %i bytes as %i', async (size, expected) => {
      const result = await service.initiateUpload(
        USER_ID,
        dto({ size_bytes: size }),
      );

      expect(result.partSize).toBe(PART_SIZE);
      expect(result.partCount).toBe(expected);
    });

    it('retries with a new public_id on a public_id unique violation', async () => {
      videoRepository.insert
        .mockRejectedValueOnce(uniqueViolation('public_id'))
        .mockResolvedValueOnce({});

      await service.initiateUpload(USER_ID, dto());

      expect(videoRepository.insert).toHaveBeenCalledTimes(2);
      const [first, second] = videoRepository.insert.mock.calls.map(
        ([video]) => video as Video,
      );
      expect(second.public_id).not.toBe(first.public_id);
      expect(second.id).toBe(first.id);
      expect(storageService.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('aborts the multipart upload and rethrows when the insert fails for another reason', async () => {
      const failure = new Error('db down');
      videoRepository.insert.mockRejectedValueOnce(failure);

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toBe(
        failure,
      );

      const [key] = storageService.createMultipartUpload.mock.calls[0] as [
        string,
      ];
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        key,
        UPLOAD_ID,
      );
    });

    it('aborts the multipart upload when public_id retries are exhausted', async () => {
      videoRepository.insert.mockRejectedValue(uniqueViolation('public_id'));

      await expect(service.initiateUpload(USER_ID, dto())).rejects.toThrow(
        /public_id conflict/,
      );
      expect(storageService.abortMultipartUpload).toHaveBeenCalledTimes(1);
    });
  });
  const PUBLIC_ID = 'AbCdEfGhIjK';
  const VIDEO_ID = '00000000-0000-4000-8000-000000000001';

  // 2 full parts + 1 MiB remainder → part_count 3.
  const draft = (overrides: Partial<Video> = {}): Video =>
    ({
      id: VIDEO_ID,
      public_id: PUBLIC_ID,
      status: VideoStatus.DRAFT,
      upload_id: UPLOAD_ID,
      declared_size_bytes: PART_SIZE * 2 + 1_048_576,
      ...overrides,
    }) as Video;

  describe('findOwnedByPublicId', () => {
    it("scopes the lookup to the caller's channel", async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      await expect(
        service.findOwnedByPublicId(USER_ID, PUBLIC_ID),
      ).resolves.toMatchObject({ id: VIDEO_ID });
      expect(videoRepository.findOne).toHaveBeenCalledWith({
        where: { public_id: PUBLIC_ID, channel: { user_id: USER_ID } },
      });
    });

    it('throws VIDEO_NOT_FOUND when no owned video matches (unknown or another owner)', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.findOwnedByPublicId(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws VIDEO_NOT_FOUND for a malformed publicId without querying', async () => {
      await expect(
        service.findOwnedByPublicId(USER_ID, 'abc'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(videoRepository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('issuePartUrls', () => {
    beforeEach(() => {
      storageService.presignUploadPart.mockImplementation(
        (_key: string, _uploadId: string, n: number) =>
          Promise.resolve(`https://storage.example/part-${n}`),
      );
    });

    it('signs each part with its exact content length, the last one carrying the remainder', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      const result = await service.issuePartUrls(USER_ID, PUBLIC_ID, [1, 3]);

      expect(result).toEqual({
        expiresIn: 3600,
        parts: [
          {
            partNumber: 1,
            url: 'https://storage.example/part-1',
            contentLength: PART_SIZE,
          },
          {
            partNumber: 3,
            url: 'https://storage.example/part-3',
            contentLength: 1_048_576,
          },
        ],
      });
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        UPLOAD_ID,
        3,
        1_048_576,
        3600,
      );
    });

    it('throws INVALID_PART_NUMBER for a part beyond part_count and signs nothing', async () => {
      videoRepository.findOne.mockResolvedValue(draft());

      await expect(
        service.issuePartUrls(USER_ID, PUBLIC_ID, [1, 4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('throws VIDEO_UPLOAD_NOT_ACTIVE when the video is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.PROCESSING }),
      );

      await expect(
        service.issuePartUrls(USER_ID, PUBLIC_ID, [1]),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
    });

    it('throws VIDEO_NOT_FOUND for a video the caller does not own', async () => {
      videoRepository.findOne.mockResolvedValue(null);

      await expect(
        service.issuePartUrls(USER_ID, PUBLIC_ID, [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });

  describe('listUploadedParts', () => {
    it('maps the stored parts to part number and size', async () => {
      videoRepository.findOne.mockResolvedValue(draft());
      storageService.listParts.mockResolvedValue([
        { partNumber: 1, etag: '"e1"', size: PART_SIZE },
      ]);

      await expect(
        service.listUploadedParts(USER_ID, PUBLIC_ID),
      ).resolves.toEqual({
        partSize: PART_SIZE,
        partCount: 3,
        uploadedParts: [{ partNumber: 1, size: PART_SIZE }],
      });
      expect(storageService.listParts).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/original`,
        UPLOAD_ID,
      );
    });

    it('throws VIDEO_UPLOAD_NOT_ACTIVE when the video is no longer a draft', async () => {
      videoRepository.findOne.mockResolvedValue(
        draft({ status: VideoStatus.READY, upload_id: null }),
      );

      await expect(
        service.listUploadedParts(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
      expect(storageService.listParts).not.toHaveBeenCalled();
    });
  });
  describe('completeUpload', () => {
    const SIZE = PART_SIZE * 2 + 1_048_576;
    const KEY = `videos/${VIDEO_ID}/original`;
    const storedParts = [
      { partNumber: 1, etag: '"e1"', size: PART_SIZE },
      { partNumber: 2, etag: '"e2"', size: PART_SIZE },
      { partNumber: 3, etag: '"e3"', size: 1_048_576 },
    ];

    function noSuchUpload(): Error {
      const err = new Error('The specified upload does not exist.');
      err.name = 'NoSuchUpload';
      return err;
    }

    beforeEach(() => {
      videoRepository.findOne.mockResolvedValue(draft());
      storageService.listParts.mockResolvedValue(storedParts);
      storageService.headObject.mockResolvedValue({ contentLength: SIZE });
      videoRepository.update.mockResolvedValue({ affected: 1 });
      videoRepository.findOneByOrFail.mockResolvedValue(
        draft({
          status: VideoStatus.PROCESSING,
          size_bytes: SIZE,
          upload_id: null,
        }),
      );
      producer.enqueue.mockResolvedValue(undefined);
    });

    it('completes from ListParts, moves draft → processing and enqueues', async () => {
      const video = await service.completeUpload(USER_ID, PUBLIC_ID);

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        KEY,
        UPLOAD_ID,
        storedParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      );
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        { status: VideoStatus.PROCESSING, size_bytes: SIZE, upload_id: null },
      );
      expect(producer.enqueue).toHaveBeenCalledWith(VIDEO_ID);
      expect(video.status).toBe(VideoStatus.PROCESSING);
    });

    it('re-enqueues and returns the video when it is already processing', async () => {
      const processing = draft({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      videoRepository.findOne.mockResolvedValue(processing);

      await expect(service.completeUpload(USER_ID, PUBLIC_ID)).resolves.toBe(
        processing,
      );
      expect(producer.enqueue).toHaveBeenCalledWith(VIDEO_ID);
      expect(storageService.listParts).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it.each([VideoStatus.READY, VideoStatus.FAILED])(
      'throws VIDEO_UPLOAD_NOT_ACTIVE when the video is %s',
      async (status) => {
        videoRepository.findOne.mockResolvedValue(
          draft({ status, upload_id: null }),
        );

        await expect(
          service.completeUpload(USER_ID, PUBLIC_ID),
        ).rejects.toBeInstanceOf(VideoUploadNotActiveException);
        expect(producer.enqueue).not.toHaveBeenCalled();
      },
    );

    it('throws UPLOAD_INCOMPLETE when a part is missing, leaving the draft untouched', async () => {
      storageService.listParts.mockResolvedValue([
        storedParts[0],
        storedParts[2],
      ]);

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadIncompleteException);
      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(videoRepository.update).not.toHaveBeenCalled();
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('marks the draft failed, deletes its prefix and throws UPLOAD_SIZE_MISMATCH on a size mismatch', async () => {
      storageService.headObject.mockResolvedValue({ contentLength: SIZE - 1 });

      await expect(
        service.completeUpload(USER_ID, PUBLIC_ID),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(videoRepository.update).toHaveBeenCalledTimes(1);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        {
          status: VideoStatus.FAILED,
          failure_reason: 'upload_size_mismatch',
          upload_id: null,
        },
      );
      expect(storageService.deletePrefix).toHaveBeenCalledWith(
        `videos/${VIDEO_ID}/`,
      );
      expect(producer.enqueue).not.toHaveBeenCalled();
    });

    it('continues from HeadObject when ListParts says NoSuchUpload (complete already done in storage)', async () => {
      storageService.listParts.mockRejectedValue(noSuchUpload());

      const video = await service.completeUpload(USER_ID, PUBLIC_ID);

      expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      expect(storageService.headObject).toHaveBeenCalledWith(KEY);
      expect(videoRepository.update).toHaveBeenCalledWith(
        { id: VIDEO_ID, status: VideoStatus.DRAFT },
        expect.objectContaining({ status: VideoStatus.PROCESSING }),
      );
      expect(video.status).toBe(VideoStatus.PROCESSING);
    });

    it('propagates NoSuchUpload when the final object does not exist either', async () => {
      const err = noSuchUpload();
      storageService.listParts.mockRejectedValue(err);
      const notFound = Object.assign(new Error('Not Found'), {
        name: 'NotFound',
      });
      storageService.headObject.mockRejectedValue(notFound);

      await expect(service.completeUpload(USER_ID, PUBLIC_ID)).rejects.toBe(
        notFound,
      );
      expect(videoRepository.update).not.toHaveBeenCalled();
    });

    it('answers like a repeat when a concurrent complete already moved the video (0 rows updated)', async () => {
      videoRepository.update.mockResolvedValue({ affected: 0 });
      const processing = draft({
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      videoRepository.findOne
        .mockResolvedValueOnce(draft())
        .mockResolvedValueOnce(processing);

      await expect(service.completeUpload(USER_ID, PUBLIC_ID)).resolves.toBe(
        processing,
      );
      expect(producer.enqueue).toHaveBeenCalledTimes(1);
      expect(producer.enqueue).toHaveBeenCalledWith(VIDEO_ID);
    });

    it('still returns the processing video when the enqueue fails', async () => {
      producer.enqueue.mockRejectedValue(new Error('Redis down'));
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      const video = await service.completeUpload(USER_ID, PUBLIC_ID);

      expect(video.status).toBe(VideoStatus.PROCESSING);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining(VIDEO_ID),
        expect.any(String),
      );
      logError.mockRestore();
    });
  });
});
