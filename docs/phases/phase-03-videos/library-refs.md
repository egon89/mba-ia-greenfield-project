---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-01T17:38:48-03:00"
  "bullmq":
    version: "peer range of @nestjs/bullmq@11.x (^3–^6) — exact version pinned at install"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-01T17:38:48-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-01T17:38:48-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x (same release as @aws-sdk/client-s3)"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-01T17:38:48-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T17:37:27-03:00"
---

# Library References — phase-03-videos

Distilled from Context7 for the surfaces this phase uses (TD-01, TD-04, TD-05, TD-06, TD-07, TD-09, TD-11, TD-13). These are not full API docs; re-query Context7 for anything not covered here.

### @nestjs/bullmq

Used by TD-01 (queue integration), TD-08 (worker consumes in `WorkerModule`), TD-13 (job options).

- **Root config (async):** `BullModule.forRootAsync({ imports, inject, useFactory: (...) => ({ connection }) })` registers a **global** shared config. Per inherited conventions, inject the namespaced `redisConfig.KEY` (a `registerAs` factory) instead of `ConfigService`.
  ```ts
  BullModule.forRootAsync({
    inject: [redisConfig.KEY],
    useFactory: (cfg: ConfigType<typeof redisConfig>) => ({
      connection: { host: cfg.host, port: cfg.port },
    }),
  });
  ```
- **Queues:** `BullModule.registerQueue({ name: 'video-processing' })` in the producing module (API videos module) and in the consuming module (`WorkerModule`); inject with `@InjectQueue('video-processing') queue: Queue`.
- **Consumers:** the class extends `WorkerHost` and is decorated with `@Processor(queueName, workerOptions?)`. The second argument takes raw BullMQ `WorkerOptions` (e.g. `{ concurrency }`). Implement `async process(job: Job)`.
- **Worker events:** `@OnWorkerEvent('failed' | 'completed' | 'stalled' | 'error' | …)` on methods of a `@Processor` class. Use `failed` to set `status = failed` after the last attempt (TD-13).
- Version note: `@nestjs/bullmq@12.x` is ESM-only and targets Nest 12. Stay on `^11.0.5` (CJS, peers `@nestjs/* ^10 || ^11`).

### bullmq

Used by TD-01, TD-07 (scheduled cleanup), TD-13 (retries/idempotency).

- **Retries:** `queue.add(name, data, { attempts: 3, backoff: { type: 'exponential', delay: <ms> } })`.
- **Permanent failure:** throw `new UnrecoverableError(msg)` (from `bullmq`) inside the processor. The job goes straight to the failed set and `attempts` is ignored. Use it for invalid media (TD-09/TD-13).
- **Idempotent enqueue:** pass `jobId: videoId`. Adding a job whose `jobId` already exists is a no-op (TD-13).
- **Failed-job retention:** `removeOnFail: { age: <seconds>, count: <n> }` (and `removeOnComplete`). Removal is lazy: it runs when another job completes or fails.
- **Scheduled jobs (TD-07):** `queue.upsertJobScheduler(schedulerId, { every: <ms> } | { pattern: '<cron>' }, { name, data, opts })`. Use `every` or `pattern`, not both. Upsert is idempotent per `schedulerId`, so calling it on every boot is safe.
- **Stalled jobs:** jobs whose worker died are re-delivered after the stalled check (~30 s by default). Closing workers gracefully on shutdown avoids this.
- **Redis requirements (production guide):** `maxmemory-policy noeviction` is the **only** safe setting, and AOF persistence (`--appendonly yes`) is recommended. Both go on the `redis` Compose service (TD-01).

### @aws-sdk/client-s3

Used by TD-04 (two clients), TD-05 (multipart), TD-06 (completion via `ListParts`), TD-07 (abort/delete), TD-09 (worker writes the thumbnail), TD-11 (GET).

- **Clients (TD-04):** two `S3Client` instances. One for operations with `endpoint: S3_ENDPOINT` (internal, `http://storage:9000`), one for browser-facing presigning with `endpoint: S3_PUBLIC_ENDPOINT`. Both use `forcePathStyle: true` for the local server, plus `region` and `credentials`.
- **Checksums:** set `requestChecksumCalculation: 'WHEN_REQUIRED'` on both clients. The SDK default is `WHEN_SUPPORTED`, which adds CRC32 `x-amz-checksum-*` / `x-amz-sdk-checksum-algorithm` headers to operations such as `PutObject`/`UploadPart`. With `WHEN_REQUIRED` they are added only when the operation requires them or `ChecksumAlgorithm` is set explicitly. `responseChecksumValidation` takes the same two values.
- **Multipart commands:** `CreateMultipartUploadCommand` (returns `UploadId`), `UploadPartCommand` (presigned for the browser; see presigner), `ListPartsCommand` (the API's source of truth at completion, TD-06), `CompleteMultipartUploadCommand` (`MultipartUpload.Parts: [{ PartNumber, ETag }]`), `AbortMultipartUploadCommand` (cleanup, TD-07).
- **Verification:** `HeadObjectCommand` after completion gives `ContentLength` for the size check and `size_bytes` (TD-05, TD-09 revision).
- **Bucket bootstrap is not done by the app** (TD-14 option B: the `storage-init` container). `CreateBucketCommand` / `PutBucketCorsCommand` are needed only in test helpers, if at all. `PutBucketCors` takes `CORSRules[]` with `AllowedOrigins`, `AllowedMethods`, `AllowedHeaders`, `ExposeHeaders: ['ETag']` and `MaxAgeSeconds`. The browser can read only headers exposed by CORS, so `ETag` must be listed.

### @aws-sdk/s3-request-presigner

Used by TD-05 (part URLs), TD-09 (worker reads input over HTTP `Range`), TD-11 (stream/download `302`).

- `getSignedUrl(client, command, { expiresIn })`. `expiresIn` is in seconds and defaults to **900**. Always pass it explicitly: part URLs 1 h (TD-05), stream ~6 h, download ~15 min (TD-11).
- Sign browser-facing URLs with the **public** client (TD-04). SigV4 signs the `Host`, so a URL signed for `storage:9000` cannot be rewritten afterwards. Worker-internal presigned GETs for ffprobe/ffmpeg (TD-09) use the **internal** client.
- Part URLs: `new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ContentLength })`. Including `ContentLength` binds the part size into the signature (TD-05 size enforcement).
- Download URL: `new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'attachment; filename="…"' })`. The stream URL is the same command without the disposition override.
