import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Used by API/worker for operations inside the Compose network.
  endpoint: process.env.S3_ENDPOINT || 'http://storage:9000',
  // Used only to sign browser-facing URLs (the host is part of the signature).
  publicEndpoint: process.env.S3_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  bucket: process.env.S3_BUCKET || '',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
}));
