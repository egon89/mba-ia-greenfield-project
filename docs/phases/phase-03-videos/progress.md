# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 2/16 completed

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
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.4 — Criar StorageModule com clients S3 interno e público
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

### SI-03.5 — Criar entidade Video, migration e gerador de public_id
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

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
