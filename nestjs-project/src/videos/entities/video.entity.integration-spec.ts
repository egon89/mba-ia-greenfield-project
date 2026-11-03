import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generatePublicId } from '../public-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const TEN_GIB = 10_737_418_240;

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let channel: Channel;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'video_owner@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'Owner',
      nickname: 'video_owner',
      user_id: user.id,
    });
  });

  function minimalVideo(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: 'My clip',
      original_filename: 'My clip.mp4',
      content_type: 'video/mp4',
      declared_size_bytes: 1024,
      ...overrides,
    };
  }

  it('should default to draft with failure reason, upload id, size and metadata null', async () => {
    const saved = await videoRepository.save(minimalVideo());

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found).toMatchObject({
      description: null,
      failure_reason: null,
      upload_id: null,
      size_bytes: null,
      duration_seconds: null,
      width: null,
      height: null,
      mime_type: null,
      video_codec: null,
      audio_codec: null,
      bitrate: null,
      frame_rate: null,
      thumbnail_key: null,
    });
    expect(found.created_at).toBeInstanceOf(Date);
    expect(found.updated_at).toBeInstanceOf(Date);
  });

  it('should enforce unique public_id', async () => {
    await videoRepository.save(minimalVideo({ public_id: 'dupDupDup_1' }));

    await expect(
      videoRepository.save(minimalVideo({ public_id: 'dupDupDup_1' })),
    ).rejects.toMatchObject({ driverError: { code: '23505' } });
  });

  it('should reject a channel_id that does not exist (FK)', async () => {
    await expect(
      videoRepository.save(minimalVideo({ channel_id: randomUUID() })),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });

  it('should require channel_id (not null)', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" (public_id, title, original_filename, content_type, declared_size_bytes)
         VALUES ($1, 'x', 'x.mp4', 'video/mp4', 1)`,
        [generatePublicId()],
      ),
    ).rejects.toMatchObject({ driverError: { code: '23502' } });
  });

  it('should read 10 GiB bigint sizes back as numbers', async () => {
    const saved = await videoRepository.save(
      minimalVideo({ declared_size_bytes: TEN_GIB, size_bytes: TEN_GIB }),
    );

    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.declared_size_bytes).toBe(TEN_GIB);
    expect(found.size_bytes).toBe(TEN_GIB);
  });

  it('should reject a status outside the enum', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO "videos" (public_id, channel_id, title, original_filename, content_type, declared_size_bytes, status)
         VALUES ($1, $2, 'x', 'x.mp4', 'video/mp4', 1, 'published')`,
        [generatePublicId(), channel.id],
      ),
    ).rejects.toMatchObject({ driverError: { code: '22P02' } });
  });
});
