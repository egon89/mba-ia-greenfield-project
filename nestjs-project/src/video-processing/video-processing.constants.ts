// Lifetime of the internal GET URL that ffprobe/ffmpeg read (TD-04).
export const INTERNAL_READ_URL_EXPIRES_IN_SECONDS = 3600;

// Thumbnail frame position as a fraction of the duration (TD-09).
export const THUMBNAIL_POSITION_RATIO = 0.1;

export const THUMBNAIL_CONTENT_TYPE = 'image/jpeg';

// The cleanup-abandoned-uploads scheduler runs every hour (TD-07).
export const MAINTENANCE_INTERVAL_MS = 3_600_000;
