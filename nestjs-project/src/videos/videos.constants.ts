// 10 GiB upper bound for an upload (TD-05 step 1).
export const MAX_VIDEO_SIZE_BYTES = 10_737_418_240;

// Retries when a freshly generated public_id collides (TD-10).
export const PUBLIC_ID_MAX_RETRIES = 5;

// Lifetime of a presigned UploadPart URL (TD-05 step 2).
export const PART_URL_EXPIRES_IN_SECONDS = 3600;

// Upper bound of part numbers per part-urls request.
export const MAX_PART_NUMBERS_PER_REQUEST = 100;

// Lifetimes of the presigned GET URLs behind stream / download (TD-11).
export const STREAM_URL_EXPIRES_IN_SECONDS = 21_600;
export const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 900;
