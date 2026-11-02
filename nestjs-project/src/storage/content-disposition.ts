// Used when the cleaned ASCII name ends up empty.
const FALLBACK_FILENAME = 'video';

// RFC 6266 `attachment` header with an ASCII `filename` fallback for old
// clients and the exact name in `filename*` (RFC 5987, UTF-8).
export function attachmentContentDisposition(filename: string): string {
  return `attachment; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

function asciiFallback(filename: string): string {
  const cleaned = filename
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '');
  return cleaned.trim() === '' ? FALLBACK_FILENAME : cleaned;
}

// encodeURIComponent leaves ' ( ) * unescaped; RFC 5987 attr-char does not
// allow them.
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
