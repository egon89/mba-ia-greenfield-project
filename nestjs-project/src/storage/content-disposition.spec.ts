import { attachmentContentDisposition } from './content-disposition';

// Splits the header into its ASCII fallback and the decoded filename* value.
function parse(header: string): { fallback: string; decoded: string } {
  const match =
    /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9%!._~-]*)$/.exec(
      header,
    );
  if (!match) throw new Error(`Unexpected header: ${header}`);
  return { fallback: match[1], decoded: decodeURIComponent(match[2]) };
}

describe('attachmentContentDisposition', () => {
  it('keeps a plain ASCII name in both forms', () => {
    const header = attachmentContentDisposition('my-video.mp4');

    expect(header).toBe(
      `attachment; filename="my-video.mp4"; filename*=UTF-8''my-video.mp4`,
    );
  });

  it('drops quotes from the fallback and percent-encodes them in filename*', () => {
    const { fallback, decoded } = parse(
      attachmentContentDisposition('clip "final".mp4'),
    );

    expect(fallback).toBe('clip final.mp4');
    expect(decoded).toBe('clip "final".mp4');
  });

  it('strips accents in the fallback and keeps the exact UTF-8 name in filename*', () => {
    const name = 'Férias em família "2024".mp4';

    const header = attachmentContentDisposition(name);
    const { fallback, decoded } = parse(header);

    expect(fallback).toBe('Ferias em familia 2024.mp4');
    expect(decoded).toBe(name);
    expect(header).toContain(
      `filename*=UTF-8''F%C3%A9rias%20em%20fam%C3%ADlia`,
    );
  });

  it("escapes RFC 5987 reserved characters ' ( ) * in filename*", () => {
    const header = attachmentContentDisposition("it's (take*2).mp4");

    expect(header).toContain(`filename*=UTF-8''it%27s%20%28take%2A2%29.mp4`);
    expect(parse(header).decoded).toBe("it's (take*2).mp4");
  });

  it('replaces non-Latin characters in the fallback and removes backslashes', () => {
    const { fallback, decoded } = parse(
      attachmentContentDisposition('a\\b 日本.mp4'),
    );

    expect(fallback).toBe('ab __.mp4');
    expect(decoded).toBe('a\\b 日本.mp4');
  });

  it('falls back to "video" when nothing printable is left', () => {
    const { fallback, decoded } = parse(attachmentContentDisposition('"\\"'));

    expect(fallback).toBe('video');
    expect(decoded).toBe('"\\"');
  });
});
