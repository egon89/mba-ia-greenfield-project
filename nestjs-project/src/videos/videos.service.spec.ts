import { ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { isValidPublicId } from './public-id.util';
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
  };
  const channelsService = { findByUserId: jest.fn() };
  const storageService = {
    createMultipartUpload: jest.fn(),
    abortMultipartUpload: jest.fn(),
  };

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
});
