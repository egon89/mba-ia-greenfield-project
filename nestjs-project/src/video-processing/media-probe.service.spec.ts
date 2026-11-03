import { InvalidMediaError, parseProbeOutput } from './media-probe.service';

const videoStream = (overrides: Record<string, unknown> = {}) => ({
  codec_type: 'video',
  codec_name: 'h264',
  width: 1920,
  height: 1080,
  avg_frame_rate: '25/1',
  ...overrides,
});

const format = (overrides: Record<string, unknown> = {}) => ({
  format_name: 'mov,mp4,m4a,3gp,3g2,mj2',
  duration: '12.480000',
  bit_rate: '2500123',
  ...overrides,
});

describe('parseProbeOutput', () => {
  it('should map a video with audio to the metadata columns', () => {
    const metadata = parseProbeOutput({
      streams: [videoStream(), { codec_type: 'audio', codec_name: 'aac' }],
      format: format(),
    });

    expect(metadata).toEqual({
      duration_seconds: 12.48,
      width: 1920,
      height: 1080,
      mime_type: 'mov,mp4,m4a,3gp,3g2,mj2',
      video_codec: 'h264',
      audio_codec: 'aac',
      bitrate: 2500123,
      frame_rate: 25,
    });
  });

  it('should return a null audio codec when there is no audio stream', () => {
    const metadata = parseProbeOutput({
      streams: [videoStream()],
      format: format(),
    });

    expect(metadata.audio_codec).toBeNull();
  });

  it('should convert a fractional avg_frame_rate to a number', () => {
    const metadata = parseProbeOutput({
      streams: [videoStream({ avg_frame_rate: '30000/1001' })],
      format: format(),
    });

    expect(metadata.frame_rate).toBeCloseTo(29.97, 2);
  });

  it('should return a null frame rate when ffprobe reports 0/0', () => {
    const metadata = parseProbeOutput({
      streams: [videoStream({ avg_frame_rate: '0/0' })],
      format: format(),
    });

    expect(metadata.frame_rate).toBeNull();
  });

  it('should return null duration and bitrate when the format omits them', () => {
    const metadata = parseProbeOutput({
      streams: [videoStream()],
      format: format({ duration: undefined, bit_rate: 'N/A' }),
    });

    expect(metadata.duration_seconds).toBeNull();
    expect(metadata.bitrate).toBeNull();
  });

  it('should throw InvalidMediaError when there is no video stream', () => {
    expect(() =>
      parseProbeOutput({
        streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
        format: format(),
      }),
    ).toThrow(InvalidMediaError);
  });

  it('should throw InvalidMediaError when ffprobe returns no streams', () => {
    expect(() => parseProbeOutput({})).toThrow(InvalidMediaError);
  });
});
