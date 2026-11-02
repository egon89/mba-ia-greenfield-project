# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 1/16 completed

### SI-03.1 — Infra: Instalar dependências de fila e storage com versões fixadas
- **Status:** completed
- **Tests:** no tests
- **Observations:**
  - Pinned `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to `3.1161.0` (latest 3.x at install time); single resolved `client-s3` in `package-lock.json`; `npm ls` clean and `tsc --noEmit` exit 0.
  - `bullmq@6.5.3` was already in the tree as a transitive dep of `@nestjs-modules/mailer`; now deduped with the direct `^6.5.3` declaration.
  - `npm install` reports pre-existing `npm audit` advisories — not addressed here (out of scope).

### SI-03.2 — Infra: Serviços Redis, RustFS e storage-init no Compose + namespaces de config
- **Status:** pending
- **Tests:** _pending_
- **Observations:** _pending_

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
