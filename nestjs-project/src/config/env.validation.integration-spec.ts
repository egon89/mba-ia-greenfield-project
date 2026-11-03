import * as Joi from 'joi';
import { envValidationSchema } from './env.validation';
import queueConfig from './queue.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  REDIS_HOST: 'redis',
  S3_ENDPOINT: 'http://storage:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'bucket',
};

const validate = (
  env: Record<string, string | undefined>,
): Joi.ValidationResult =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — queue, storage and videos', () => {
  it('should reject a missing REDIS_HOST', () => {
    const { error } = validate({ REDIS_HOST: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('REDIS_HOST');
  });

  it('should reject a missing S3_BUCKET', () => {
    const { error } = validate({ S3_BUCKET: undefined });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_BUCKET');
  });

  it('should apply defaults for queue prefix and video limits', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.QUEUE_PREFIX).toBe('bull');
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.UPLOAD_ABANDON_AFTER_HOURS).toBe(24);
    expect(value.PROCESSING_STUCK_AFTER_MINUTES).toBe(120);
    expect(value.S3_FORCE_PATH_STYLE).toBe('true');
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242879' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept UPLOAD_PART_SIZE_BYTES at the 5 MiB minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242880' });
    expect(error).toBeUndefined();
  });

  it('should reject a QUEUE_PREFIX with characters outside [a-z0-9_-]', () => {
    const { error } = validate({ QUEUE_PREFIX: 'Test:queue' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('QUEUE_PREFIX');
  });
});

describe('queueConfig', () => {
  const original = process.env.QUEUE_PREFIX;

  afterEach(() => {
    if (original === undefined) delete process.env.QUEUE_PREFIX;
    else process.env.QUEUE_PREFIX = original;
  });

  it('should default the prefix to bull when QUEUE_PREFIX is unset', () => {
    delete process.env.QUEUE_PREFIX;
    expect(queueConfig().prefix).toBe('bull');
  });

  it('should use QUEUE_PREFIX when set', () => {
    process.env.QUEUE_PREFIX = 'test';
    expect(queueConfig().prefix).toBe('test');
  });
});
