// Multipart layout of an upload (TD-05): every part has `partSize` bytes
// except the last one, which carries the remainder.

export function partCount(size: number, partSize: number): number {
  return Math.ceil(size / partSize);
}

// `partNumber` is 1-based and must be within 1..partCount(size, partSize).
export function partContentLength(
  partNumber: number,
  size: number,
  partSize: number,
): number {
  if (partNumber < partCount(size, partSize)) return partSize;
  return size - (partNumber - 1) * partSize;
}
