// Object key layout (TD-03): one prefix per video, keyed by the internal UUID.
export const videoPrefix = (id: string): string => `videos/${id}/`;

export const videoOriginalKey = (id: string): string =>
  `${videoPrefix(id)}original`;

export const videoThumbnailKey = (id: string): string =>
  `${videoPrefix(id)}thumbnail.jpg`;
