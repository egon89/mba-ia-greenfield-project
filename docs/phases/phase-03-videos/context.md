---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-17T19:41:40-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T17:37:27-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-17T19:41:40-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-17T19:41:40-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-17T19:41:40-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-17T19:41:40-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-17T19:41:40-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-17T19:41:40-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

> Depende de: Fase 01, Fase 02

Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única.

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._
**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.
**Affected subprojects:** _None named in the phase body. It does not mention `nestjs-project`, `nextjs-project` or any other subproject path._
**Deferred subprojects:** _None._
**Sequencing notes:** "> Depende de: Fase 01, Fase 02"

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha. (Cadastro, Login e Gerenciamento de Conta; depende de Fase 01)
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública. (Gerenciamento de Vídeos e Canal; depende de Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Job Queue Technology | decided | A: BullMQ + Redis via `@nestjs/bullmq` (11.x) | @nestjs/bullmq@^11.0.5, bullmq |
|     └─ Last revision: 2026-11-01 — Recorded the libraries implied by the decision: `@nestjs/bullmq@^11.0.5` (the l… | | | | | | |
| phase-03-videos/TD-02 | phase | Repo-wide | Local S3-Compatible Object Storage Server | decided | A: RustFS | — |
| phase-03-videos/TD-03 | phase | Backend | Bucket and Object Key Layout | decided | A: Single private bucket, prefix per video (internal UUID) | — |
| phase-03-videos/TD-04 | phase | Backend | Presigned URL Host (Internal vs Public Storage Endpoint) | decided | A: Two endpoints (internal ops / public browser-facing signatures) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-11-01 — Recorded the S3 SDK packages implied by the two-client setup: `@aws-sdk/client-… | | | | | | |
| phase-03-videos/TD-05 | phase | Cross-layer | Large-File Upload Protocol (up to 10 GB, direct to storage) | decided | A: Presigned S3 multipart, orchestrated by the API | — |
|     └─ Last revision: 2026-11-01 — Draft pre-registration contents fixed: the video belongs to the uploader's **ch… | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Upload Completion Detection | decided | A: Client signals, API completes using its own `ListParts` | — |
| phase-03-videos/TD-07 | phase | Backend | Abandoned Upload Cleanup | decided | A: Application cleanup job (scheduled job on the queue) | — |
| phase-03-videos/TD-08 | phase | Backend | Video Worker Topology | decided | A: Same codebase, second entrypoint, separate Compose service | — |
| phase-03-videos/TD-09 | phase | Backend | FFmpeg/ffprobe Invocation and Input Access | decided | A: Spawn system binaries on a presigned URL | — |
|     └─ Last revision: 2026-11-01 — Metadata persisted on the video row after processing: `duration_seconds`, `wid… | | | | | | |
| phase-03-videos/TD-10 | phase | Cross-layer | Unique Public Video ID (URL strategy) | decided | B: Random 11-char base64url `public_id` | — |
| phase-03-videos/TD-11 | phase | Cross-layer | Streaming and Download Delivery | decided | A: Access check + `302` to presigned GET | — |
|     └─ Last revision: 2026-11-01 — Phase 03 access rule for stream and download: both require authentication **an… | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Video Status Lifecycle Model | decided | A: Single `status` enum `draft \| processing \| ready \| failed` | — |
| phase-03-videos/TD-13 | phase | Backend | Processing Failure, Retry and Idempotency Strategy | decided | A: Queue-native retries + idempotent `jobId = videoId` | — |
| phase-03-videos/TD-14 | phase | Repo-wide | Bucket and CORS Provisioning | decided | B: Init container creates bucket + applies versioned CORS policy via S3 API | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-14 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-08 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-14 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-05, phase-03-videos/TD-12 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-12, phase-03-videos/TD-13 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-08, phase-03-videos/TD-09, phase-03-videos/TD-13 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-10 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-11 |
| Download do vídeo pelo usuário | phase-03-videos/TD-11 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** It is the only option where retry/backoff, a kept failed-job record, stalled-job recovery, deduplicated enqueue and a periodic scheduler (needed by TD-07 and TD-13) all come out of the box with an official Nest integration that works on this CommonJS Nest 11 project. The cost is one Redis container that **must** be configured with `--appendonly yes --maxmemory-policy noeviction` in `compose.yaml`, plus new env keys (`REDIS_HOST=redis`, `REDIS_PORT`) in the Joi schema. Option B is the credible "no-Redis" alternative with the same code API; it is not recommended yet because it is new and has no documented Nest wiring — re-evaluate when `@nestjs/bullmq` supports backends officially.
**Libraries:** @nestjs/bullmq@^11.0.5, bullmq

**Revisions:**
- 2026-11-01 — Recorded the libraries implied by the decision: `@nestjs/bullmq@^11.0.5` (the last CommonJS-compatible line for Nest 11; 12.x is ESM-only) and its peer `bullmq`. Resolves IC-1 of phase-03-videos validation. Rationale: libraries implied by the decision were not recorded at decision time.

### phase-03-videos/TD-02

**Recommendation:** It keeps the one-container developer experience the plan assumed with MinIO, is actively maintained, and its documented features cover everything this phase needs (multipart, presign, CORS, `Range`, abandoned-upload cleanup). Because the code depends only on the S3 API, the risk of its youth is limited: the first implementation step should be a short spike that checks presigned `UploadPart` + `CompleteMultipartUpload`, CORS with `ETag` exposed, and `Range` → `206` against RustFS. If the spike fails, switch to Option B (Garage) with only Compose changes. Option C is not recommended: dev environments should not depend on an archived server with no official image. Separate task to note: update the diagram's "S3 or MinIO" label.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** It is the smallest correct setup: one bucket to create and protect, immutable keys based on the internal UUID (independent of TD-10's public ID), and one-prefix deletion. Storage growth is tracked through a `size_bytes` column in the DB rather than through key structure. If Phase 07 needs cacheable public thumbnails, a prefix policy or a move to Option B can be decided then.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** It is the only option that works on a fresh clone with no host-machine changes and keeps all server-to-server traffic on Compose service names, as `CLAUDE.md` requires. `S3_PUBLIC_ENDPOINT=http://localhost:9000` is an intended exception to the "never `localhost`" rule because it is read by the host's browser, not by a container. It should be documented as such in `.env.example`. Proposed canonical keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (true for the local server). Implementation note from the SDK docs: set `requestChecksumCalculation: 'WHEN_REQUIRED'` on the S3 clients, because the SDK's default flexible checksums add `x-amz-checksum-*` headers that break presigned part uploads against non-AWS servers.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-11-01 — Recorded the S3 SDK packages implied by the two-client setup: `@aws-sdk/client-s3` (operations: multipart create/complete/abort, `ListParts`, `HeadObject`, worker reads/writes) and `@aws-sdk/s3-request-presigner` (browser-facing presigned URLs). TD-05, TD-06, TD-09 and TD-11 use the same packages. Resolves IC-1 of phase-03-videos validation. Rationale: libraries implied by the decision were not recorded at decision time.

### phase-03-videos/TD-05

**Recommendation:** It is the only option where the file never passes through an application process (API, BFF or tus server), which matches both the requirement and the diagram's direct frontend ↔ storage link. Resume uses standard `ListParts`. Proposed parameters: fixed **64 MiB** part size (10 GiB → 160 parts, well under 10,000 and above the 5 MiB minimum), presigned part URLs valid for 1 h and issued in batches. Size enforcement without vendor extensions: (1) reject `size > 10 GiB` at initiation, (2) sign only part numbers `1..partCount` and include `Content-Length` in each part's signature, (3) after completion, verify the object size with `HeadObject` before accepting it. Pre-registration happens in the same initiation call that creates the multipart upload.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Draft pre-registration contents fixed: the video belongs to the uploader's **channel** (`channel_id` FK, resolved from the authenticated user; Phase 02 creates one channel per user). Initiation input: original filename, size in bytes and content type, all stored on the row. `title` defaults to the filename without its extension, `description` is null, `status = draft` (TD-12). Phase 04 edits title/description. Rationale: clarification from AMB-2 of phase-03-videos validation (owner and initial fields were undefined).

### phase-03-videos/TD-06

**Recommendation:** It gives a single, synchronous point where the API knows for certain that the object exists. It does not depend on storage-specific event setups, which differ between local and production environments. The only gap (a client that never signals) is covered by the cleanup job in TD-07.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** The DB row is what users and later phases see, and only application code can clean the DB and storage together. It reuses the TD-01 scheduler, so no new library is needed. A lifecycle rule (Option C) can be added cheaply at deploy time (Phase 07) as defense in depth, and RustFS already removes stale uploads after 24 h by default.
**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** It gives the process/container isolation the diagram and the performance requirement call for, without duplicating the domain model or creating a shared-package setup. FFmpeg runs as a child process, so the worker's event loop stays free to renew BullMQ job locks during long jobs. Responsibilities stay separate: the API's videos module only *produces* jobs, and a processing module loaded only by `WorkerModule` *consumes* them.
**Libraries:** —

### phase-03-videos/TD-09

**Recommendation:** Metadata and a single frame only need a small part of the file, so reading through HTTP `Range` avoids the disk space and download time of Option B, which grow with file size. Install binaries with `apt-get install ffmpeg` in the worker image (Debian package, versioned with the base image) rather than `ffmpeg-static`, so the version is visible and patchable. Pick the thumbnail frame relative to the duration (e.g. 10 % of the duration, with a fallback to the first frame for very short clips). If ffprobe reports no video stream, the file is treated as invalid media → permanent failure (TD-13).
**Libraries:** —

**Revisions:**
- 2026-11-01 — Metadata persisted on the video row after processing: `duration_seconds`, `width`, `height`, `mime_type` (container/format), `video_codec`, `audio_codec` (null when there is no audio stream), `bitrate`, `frame_rate`. `size_bytes` is recorded at completion from `HeadObject` (TD-05), not by ffprobe. All of these stay nullable until processing finishes. Rationale: clarification from AMB-3 of phase-03-videos validation ("metadados" was not enumerated); codecs/bitrate kept for a future browser-playability check (TD-11 known limitation).

### phase-03-videos/TD-10

**Recommendation:** It satisfies "short" and "never conflicts" (enforced by the `UNIQUE` index, not by probability) and cannot be guessed, which Phase 04's unlisted visibility depends on. It uses the same generate-and-retry-on-unique-violation pattern already used for channel nicknames, and needs no new dependency. Storage keys keep using the internal UUID (TD-03), so the public ID can change without moving any object.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** It is the only option that keeps video bytes off the API and still has one place where access is checked for Phases 04/05. Streaming and download become the same mechanism, and `Range`/`206` is handled by the storage server instead of custom code. Proposed TTLs: about 6 h for stream URLs (long enough for a viewing session with seeking), about 15 min for download URLs. Known limitation to record: the original file is played as uploaded, so formats the browser can't play (e.g. some MKV/HEVC files) will download but not play. Transcoding is not in this phase.
**Libraries:** —

**Revisions:**
- 2026-11-01 — Phase 03 access rule for stream and download: both require authentication **and** ownership (the video's channel belongs to the requesting user). Unauthenticated → `401` (existing auth guard); authenticated non-owner or unknown id → `404` (existence is not revealed); owner with `status ≠ ready` → `409`. Nothing is public in Phase 03; Phase 04 opens published videos to anonymous viewers through its visibility field. Rationale: clarification from AMB-1 of phase-03-videos validation (the Phase 03 access rule was undefined).

### phase-03-videos/TD-12

**Recommendation:** The phase literally describes the cycle "rascunho → processando → pronto/erro" and asks for "pré-cadastro como rascunho", so the status column mirrors the requirement one-to-one. The main Option A con is removed by fixing the meaning of `draft` and keeping publication out of this enum:
- `draft` means only "video pre-registered, upload not yet completed". It is set at upload initiation (TD-05) and left only by the `complete` call (TD-06), which moves `draft → processing`.
- Publication/visibility (Phase 04) will be a **separate field** created in Phase 04. It never adds values to this enum.
- TD-07 and TD-13 still get exact states: the cleanup job queries `draft` rows older than the threshold, and every transition is a conditional update on the current state (`WHERE status = 'draft'` on completion, `WHERE status = 'processing'` in the worker).

Why Option B was not chosen: its only advantage over A was separating the file's state from publication. With the meaning of `draft` fixed as above and publication kept in its own Phase 04 field, A provides the same separation and uses the plan's own vocabulary. B would rename the requirement's "rascunho" state to `uploading` and require API docs explaining that "rascunho" means something other than the status column.

Known trade-off to carry into Phase 04: there, "rascunho → publicação" uses "rascunho" in the *publication* sense, and a processed but unpublished video has `status = ready`, not `draft`. Phase 04 must name its publication field/values without reusing `draft`.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** Every step is safe to repeat (deduplicated enqueue, conditional update, fixed keys), so retries and re-delivery cause no damage. Separating permanent from temporary errors keeps bad uploads from using up retries. The one gap (commit succeeded, enqueue failed) is closed by re-enqueuing the same `jobId`, without an outbox. Revisit Option B if more job types later need guaranteed delivery.
**Libraries:** —

### phase-03-videos/TD-14

**Recommendation:** it is the only option where the CORS rule the upload flow depends on (`ExposeHeaders: ETag`) is stated explicitly in the standard S3 form, so the same file serves RustFS in dev and S3 in production (Phase 07) without drift. It also keeps admin operations out of the API/worker. Option A's env var is simpler but RustFS-only and silent about exposed headers. If the TD-02 spike shows it exposes `ETag`, it remains an acceptable fallback, not a portable contract. Option C works but gives the application admin rights and an infra responsibility it does not otherwise need. Integration tests run inside the same Compose network, so they get the provisioned bucket from `storage-init` and can isolate their data by key prefix.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Three converging reasons: (1) **Type-inference matches the FE's strict-TS culture** — `lib/env.ts` exports a typed `env` object with no `as` casts, satisfying the project's "Type Safety" working principle. (2) **Ecosystem gravity in Next.js / React 19** — Zod is the de-facto schema language for App Router (Server Actions inputs, form resolvers, future contract validation), so introducing it once at the env layer compounds value for forms in Phase 02+. (3) **Direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`)** — t3-env's first-citizen validator. Backend parity with Joi is not load-bearing: env schemas are not shared FE↔BE (different runtimes, different key sets); two validators across two subprojects is a bounded cost.
**Libraries:** zod

### next-frontend-config-base/TD-02

**Recommendation:** The only option that combines (i) **type-level NEXT_PUBLIC_ prefix enforcement**, (ii) **runtime Proxy-based leak detection**, and (iii) **single-file, single-import-path consumer ergonomics**. Option B reaches roughly the same _structural_ outcome at higher implementation and maintenance cost, with a weaker guarantee (no prefix enforcement, no proxy). Option C is unsafe at any non-trivial team size. The marginal cost over B is one ~3KB dep — well-spent for the strongest boundary among the three.
**Libraries:** @t3-oss/env-nextjs

### next-frontend-config-base/TD-03

**Recommendation:** Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation. Option B's `NEXT_PUBLIC_API_URL` is a future-proofing concession with no current consumer — and adding a public key later is a non-breaking change, while removing one is breaking. Option C ties a foundational decision to infra work explicitly deferred elsewhere. The Docker networking gap (how server-in-container resolves the backend) is a separate orthogonal decision, surfaced below.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase-that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory phase-03-videos and then rerun /plan-context phase-03-videos to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

_Source: `testing-guide-nestjs-project` § 3 Feature Implementation Checklist. Types not yet in the project (queue processors/workers, scheduled jobs) are covered in that skill's `artifacts/future-types.md`._
