# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 9/16 completed

### SI-03.1 — Infra: Instalar dependências de fila e storage com versões fixadas
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Pinned `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1161.0` (latest 3.x at install time); single resolved `client-s3` in `package-lock.json`; `npm ls` clean and `tsc --noEmit` exit 0.
  - `bullmq@6.5.3` was already in the tree as a transitive dep of `@nestjs-modules/mailer`; now deduped with the direct `^6.5.3` declaration.
  - `npm install` reports pre-existing `npm audit` advisories — not addressed here (out of scope).

### SI-03.2 — Infra: Serviços Redis, RustFS e storage-init no Compose + namespaces de config
- **Status:** completed
- **Tests:** 12 passing (`src/config/env.validation.integration-spec.ts` — 4 existing SWAGGER + 8 new)
- **Observations:**
  - Pinned helper images to exact tags: `rustfs/rustfs:1.0.3` (TD-02), `amazon/aws-cli:2.39.3`, `redis:7` (plan-given). Storage healthcheck uses `curl http://localhost:9000/health` (curl is present in the RustFS image).
  - `storage-init` sets `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION=when_required` so AWS CLI v2 does not add CRC checksum headers against the non-AWS server (same rationale as library-refs `@aws-sdk/client-s3`).
  - CORS `AllowedOrigins` is fixed to `http://localhost:3001` in `docker/storage/cors.json` (frontend host port from `next-frontend/compose.yaml`). TD-14 mentions an optional env-substituted origin (`STORAGE_CORS_ORIGIN`); the plan's action only asks for the static versioned file, so no env key was added.
  - Compose interpolates `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_REGION` / `S3_BUCKET` from `nestjs-project/.env` into `storage` and `storage-init`, so the RustFS root credentials and the app credentials are the same pair (dev only).
  - Added `REDIS_PORT` (default `6379`) to the Joi schema alongside `REDIS_HOST`, since `redis.config.ts` reads it. Added the 5 MiB S3 minimum check and a `[a-z0-9_-]` pattern for `QUEUE_PREFIX` as specified.
  - Exposed Redis on host port `6379` for local debugging; not required by the plan.

### SI-03.3 — Spike de compatibilidade S3 do RustFS (multipart pré-assinado, CORS com ETag, Range → 206)
- **Status:** completed
- **Tests:** 5 passing (`src/storage/rustfs-compat.integration-spec.ts`)
- **Observations:**
  - **Spike result (for the PR description, action 5):** RustFS `1.0.3` passed every item — presigned `UploadPart` PUT → 200 + `ETag`; `ListParts` → `CompleteMultipartUpload` → `HeadObject` `ContentLength` = 5 MiB + 1 KiB; part body larger than the signed `ContentLength` → 4xx; `PUT` with allowed `Origin` → `Access-Control-Allow-Origin` + `Access-Control-Expose-Headers` containing `ETag`; `OPTIONS` preflight → 2xx; presigned `GET` with `Range: bytes=0-99` → 206 + `Content-Range: bytes 0-99/{total}` + 100 bytes. No switch to Garage needed.
  - Test cleans up after itself: aborts any open multipart upload and deletes completed objects under `test/spike/{uuid}/`.
  - The test also asserts `Access-Control-Allow-Origin` on the preflight response (beyond the plan's 2xx requirement) and byte-equality of the ranged body.

### SI-03.4 — Criar StorageModule com clients S3 interno e público
- **Status:** completed
- **Tests:** 10 passing (`storage.module.spec.ts` 1, `storage.service.integration-spec.ts` 9)
- **Observations:**
  - Added `src/storage/storage.constants.ts` holding the `S3_CLIENT` / `S3_PUBLIC_CLIENT` symbol tokens (project rule: constants in `<module>.constants.ts`). `StorageService` destroys both clients in `onModuleDestroy`.
  - `abortMultipartUpload` swallows only `NoSuchUpload` (idempotent per plan AC); every other error is re-thrown, matching the service error rule's "valid domain result" exception.
  - **Test-environment constraint (affects SI-03.15):** URLs signed by the public client point at `S3_PUBLIC_ENDPOINT` (`localhost:9000`), which is unreachable from inside the `nestjs-api` container — and the host cannot be rewritten without breaking SigV4. The integration test therefore uploads setup parts via the internal client and asserts the public host only on the URL string. The full-flow test in SI-03.15 (PUT to presigned part URLs from the test process) will need a strategy for this, e.g. a test-only `S3_PUBLIC_ENDPOINT=http://storage:9000` override for the test run.
  - Fix attempt 1/1: the first run failed with `ECONNREFUSED 127.0.0.1:9000` for that reason; fixed in the test helper only (no service change).

### SI-03.5 — Criar entidade Video, migration e gerador de public_id
- **Status:** completed
- **Tests:** 20 passing (`public-id.util.spec.ts` 11, `video.entity.integration-spec.ts` 6, `migrations.integration-spec.ts` 2, `videos.module.spec.ts` 1); migrations spec re-run passes on the same DB; CLI `migration:revert` → `migration:run` verified in the container. Full suite green at SI end: unit+integration 29 suites / 185 tests, e2e 3 suites / 52 tests, lint and `tsc --noEmit` clean
- **Observations:**
  - **Anticipated from SI-03.7 (minimal `VideosModule`):** `AppModule` uses `autoLoadEntities`, so the inverse `Channel#videos` relation made TypeORM throw `Entity metadata for Channel#videos was not found` at app boot. That broke the e2e suites and `openapi-export.integration-spec.ts`, which boots `AppModule`. To keep the suite green at the end of this SI, I created `src/videos/videos.module.ts` with only `TypeOrmModule.forFeature([Video])` (it exports `TypeOrmModule`), imported it in `AppModule` and added the compilation test `src/videos/videos.module.spec.ts`. **SI-03.7 is still responsible for completing this module:** service, controller, producer, and the Storage/Channels/queue imports.
  - Migration `1793645223755-CreateVideos.ts` was generated by the CLI and formatted with Prettier; the SQL matches the Data Model (enum `videos_status_enum`, FK `ON DELETE NO ACTION`, unique `public_id`, indexes on `channel_id`, `(status, created_at)`, `(status, updated_at)`).
  - The migrations spec's revert test now targets the last migration (`CreateVideos`): it asserts that the `videos` table and the `videos_status_enum` type are gone and that the earlier tables remain. Before, it asserted that the token tables were removed.
  - `Video` was added to `ALL_ENTITIES` in all 10 existing specs, not just the entity tests the plan names (module and service specs too), because any data source that loads `Channel` now needs `Video`.

### SI-03.6 — Configurar a fila BullMQ e o produtor de process-video
- **Status:** completed
- **Tests:** 5 passing (`queue.module.spec.ts` 1, `video-processing.producer.integration-spec.ts` 2, `queue-prefix.integration-spec.ts` 2). Full suite green at SI end: unit+integration 32 suites / 190 tests, e2e 3 suites / 52 tests, lint and `tsc --noEmit` clean
- **Observations:**
  - **Added dependency `ioredis@5.11.1` (exact; not in the plan):** in `bullmq@6` `ioredis` is an *optional* peer dependency, so SI-03.1 did not install it. The first test run failed with "BullMQ could not load the optional 'ioredis' package". The version is pinned to the one `bullmq@6.5.3` develops against (its devDependency), not `ioredis@6.0.0` (the current `latest`). `npm ls ioredis` shows a single deduped copy (shared with `typeorm`). Fix attempt 1/3.
  - **BullMQ 6 API change:** `Queue.client` no longer exists. The raw Redis client is at `queue.getBackend().client` and is typed as BullMQ's own `IRedisClient` (no `exists`). The prefix test reads the job hashes with `hgetall` (`{}` when the key does not exist).
  - The prefix test starts a raw `Worker` with the `bull` prefix on `video-processing`. It leaves the bookkeeping keys `bull:video-processing:meta` and `:stalled-check` in Redis (no job keys). They are not cleaned up on purpose: obliterating or deleting under the `bull` prefix could wipe real dev jobs, and the real `video-worker` (SI-03.10) creates the same keys.
  - `QueueModule` is not yet imported by `AppModule`. The producer is not yet registered in `VideosModule` (with `BullModule.registerQueue`). Both are wired in SI-03.7, as the plan says ("storage, entidade e produtor no VideosModule"); the producer test builds its own module.
  - `PROCESS_VIDEO_JOB_OPTIONS` uses `as const satisfies JobsOptions`, which type-checks it against BullMQ without widening the literals.
  - `src/test/jest-env.setup.ts` is in the `setupFiles` of both Jest configs, after `dotenv/config`. It assigns `QUEUE_PREFIX = 'test'` unconditionally, so it overrides `.env`'s `bull`.

### SI-03.7 — Endpoint POST /videos (início do upload + pré-cadastro como rascunho)
- **Status:** completed
- **Tests:** 23 passing (`videos.service.spec.ts` 12, `videos.service.integration-spec.ts` 1, `channels.service.integration-spec.ts` +2 `findByUserId`, `videos.module.spec.ts` 1, `test/videos-create.e2e-spec.ts` 4 — spec-derived from `specs/videos-create.plan.md`). Full suite green at SI end: unit+integration 34 suites / 205 tests, e2e 4 suites / 56 tests (twice in a row), lint and `tsc --noEmit` clean
- **Observations:**
  - **Fixed `test:e2e` to run in band (`package.json`):** with a second database-backed e2e suite (`videos-create`), Jest ran `auth` and `videos-create` in parallel. Each suite's `cleanAllTables` wiped the other's rows, causing flaky FK violations, 401s and 500s. `nestjs-project/CLAUDE.md` already says `test:e2e` is "already configured" for `--runInBand`, but the script never had the flag; added it. Fix attempt 1/3 of the full-suite check.
  - `VideosModule` from SI-03.5 completed as planned: `BullModule.registerQueue(video-processing)`, `StorageModule`, `ChannelsModule`, `VideosService`, `VideoProcessingProducer`, `VideosController`. `QueueModule` is now imported in `AppModule`. The app now opens a Redis connection on boot; e2e and `openapi-export` close it via `app.close()`.
  - Extracted `isPgUniqueViolationOnColumn` to `src/common/database/pg-errors.ts`. Both the `public_id` retry (`VideosService`) and the `nickname` retry (`ChannelsService`) use it now, and the private copy (with its `PG_UNIQUE_VIOLATION` constant) was removed from `channels.service.ts` in the same SI, per the CLAUDE.md single-responsibility rule.
  - Storage keys come from `src/storage/storage-keys.ts` (`videoOriginalKey`, `videoThumbnailKey`, `videoPrefix`), created in SI-03.4. A duplicate `src/videos/video-storage-keys.ts` was created by mistake (a failed shell search hid the existing file) and was removed before closing the SI; every import points to `storage-keys`. Also created `src/videos/videos.constants.ts` (`MAX_VIDEO_SIZE_BYTES`, `PUBLIC_ID_MAX_RETRIES`).
  - `initiateUpload` inserts with `repository.insert` (avoids `save()`'s SELECT-before-insert on a preset `id`) and then reloads the row, so every nullable column comes back as `null` in the response. If no row is created (insert error or `public_id` retries exhausted), the multipart upload is aborted.
  - A user without a channel makes `initiateUpload` throw a plain `Error` (→ 500): every user gets a channel at registration, and the Error Catalog has no code for this case.
  - `title` derivation treats a leading dot as "no extension" (`.hidden` → `.hidden`, not an empty title).
  - Response DTOs (`VideoResponseDto`, `InitiateUploadResponseDto`) use explicit `@ApiProperty`, so `openapi.json` documents the response. **Pre-existing gap (out of scope):** `openapi:export` runs through `ts-node` without the `@nestjs/swagger` CLI plugin, so request DTO schemas (`InitiateUploadDto` and all the Phase 02 auth DTOs) are exported as empty `{ properties: {} }`.
  - Created `test/helpers/auth.helper.ts` (`registerConfirmAndLogin(app, email)`), the same flow as the private helper in `test/auth.e2e-spec.ts`, so the upcoming video e2e suites can share it. `auth.e2e-spec.ts` was not touched.
  - Multipart uploads opened by e2e runs are not aborted (`deletePrefix` only removes objects); RustFS discards stale multipart uploads after 24 h. The service integration test aborts the one it opens.

### SI-03.8 — Endpoints de URLs de parte e retomada (POST part-urls, GET upload/parts)
- **Status:** completed
- **Tests:** 35 passing (`upload-parts.util.spec.ts` + `videos.service.spec.ts` + `videos.service.integration-spec.ts` — 30 across the 3 suites; `test/videos-upload-parts.e2e-spec.ts` 5 — spec-derived from `specs/videos-upload-parts.plan.md`). `tsc --noEmit` and eslint on the changed files clean
- **Observations:**
  - The `videos` table has no `part_count` column. `part_count` is recomputed from `declared_size_bytes` and the current `UPLOAD_PART_SIZE_BYTES`, as `initiateUpload` already did. If that env value changes while uploads are open, the part layout of those drafts changes too. Not handled; the plan does not persist the part size.
  - `findActiveDraft` (private) requires `status = 'draft'` **and** a non-null `upload_id`, and returns both. That avoids non-null assertions on `upload_id` in `issuePartUrls` / `listUploadedParts`.
  - Added `PART_URL_EXPIRES_IN_SECONDS = 3600` and `MAX_PART_NUMBERS_PER_REQUEST = 100` to `videos.constants.ts`. The response mappers (`toPartUrlsResponse`, `toUploadedPartsResponse`) live next to their DTOs, the same pattern as `toVideoResponse`.
  - `PartUrlsDto` has an explicit `@ApiProperty` (min/max items, unique), so `openapi.json` documents its request schema. This sidesteps, for this DTO only, the empty request-schema gap noted in SI-03.7.
  - The integration and e2e tests set `S3_PUBLIC_ENDPOINT=http://storage:9000` and `UPLOAD_PART_SIZE_BYTES=5242880` in `beforeAll` before compiling, and restore them in `afterAll`. This is the strategy anticipated in SI-03.4 for PUTs to presigned URLs from inside the container.
  - The integration run prints a non-failing `pg` DeprecationWarning ("Calling client.query() when the client is already executing a query"). Not investigated; out of scope.

### SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)
- **Status:** completed
- **Tests:** 50 passing (`videos.service.spec.ts`, `videos.service.integration-spec.ts`, `videos.module.spec.ts`, `storage.service.integration-spec.ts` — 45 across the 4 suites; `test/videos-upload-complete.e2e-spec.ts` 5 — spec-derived from `specs/videos-upload-complete.plan.md`). `tsc --noEmit` and eslint on the changed files clean
- **Observations:**
  - Created `src/storage/storage-errors.ts` (`isNoSuchUploadError`) so S3 error-name checks stay in the storage module. `StorageService.abortMultipartUpload` (SI-03.4) now uses it too; its behavior is unchanged and its integration spec was re-run and passes.
  - `NoSuchUpload` path: when `ListParts` says the upload no longer exists, the flow skips the complete step and goes straight to `HeadObject`. If the object is missing too, the S3 `NotFound` error propagates (→ 500). That state means storage and database disagree; the Error Catalog has no code for it.
  - The "0 rows updated" branch reloads the video. If it is `processing`, it re-enqueues and returns it (same as a repeated call). Any other status → `VIDEO_UPLOAD_NOT_ACTIVE`.
  - An enqueue failure is logged (`Logger.error`) and swallowed in both the fresh-complete and the repeat path, as the plan specifies for the fresh path. The maintenance job (SI-03.12) re-enqueues stuck videos.
  - A `draft` row without an `upload_id` (should not happen) is treated as `VIDEO_UPLOAD_NOT_ACTIVE`.
  - The integration spec now also imports `QueueModule` + `BullModule.registerQueue` (producer dependency). It obliterates the `test`-prefixed queue around each test and deletes `videos/` in `afterAll`.

### SI-03.10 — Infra: Entrypoint do worker, WorkerModule e serviço video-worker no Compose
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.11 — Processar vídeo no worker (ffprobe, thumbnail, status e falhas)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.12 — Job agendado de manutenção (rascunhos abandonados + vídeos presos em processing)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.13 — Endpoint GET /videos/:publicId (status e metadados para o dono)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.14 — Endpoints de streaming e download (302 para GET pré-assinado)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.15 — Teste de fluxo completo: upload multipart direto ao storage até o vídeo pronto
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.16 — Documentação e Definition of Done da fase
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_
