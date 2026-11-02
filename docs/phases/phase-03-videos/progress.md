# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 5/16 completed

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
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.7 — Endpoint POST /videos (início do upload + pré-cadastro como rascunho)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.8 — Endpoints de URLs de parte e retomada (POST part-urls, GET upload/parts)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

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
