// The multipart upload does not exist (never opened, aborted or completed).
export function isNoSuchUploadError(error: unknown): boolean {
  return error instanceof Error && error.name === 'NoSuchUpload';
}
