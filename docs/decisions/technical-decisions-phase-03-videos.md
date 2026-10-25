---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-24
scope_description: "Backend foundation for video upload and processing: job queue technology, local S3-compatible storage, bucket/key layout and presigned-URL host, direct-to-storage multipart upload (initiation, completion, abandoned uploads), worker topology and FFmpeg/ffprobe extraction, unique public video ID, streaming/download delivery, and video status lifecycle with failure/retry/idempotency."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend that delivers the video upload API (draft pre-registration, presigned multipart, completion), the storage and queue integrations, the video-processing worker (ffprobe metadata + thumbnail), unique public IDs, and the streaming/download endpoints. Also hosts `compose.yaml`, where the new infrastructure services (queue backend, object storage) are added.
- `next-frontend/` — No TD owned here: by explicit user scoping, the frontend is out of this phase, and Phase 03 in `docs/project-plan.md` lists no screen bullet. The browser-side half of the upload handshake and the player `src` are fixed as contracts by the `Cross-layer` TDs below (TD-05, TD-10, TD-11) and will be implemented by the phase that builds the upload/watch screens. Inherited constraint: `next-frontend-config-base/TD-03` (Strict BFF) — the browser never calls NestJS directly, but it **does** talk directly to object storage through presigned URLs returned by the API.

---

## TD-01: Job Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". The API must hand off video processing to a worker without blocking the request, survive restarts without losing jobs, retry transient failures with backoff, keep a record of failed jobs, and (per TD-07) run a periodic cleanup job. Installed stack: NestJS 11.1.16 (CommonJS output, `module: nodenext`), PostgreSQL 17, Node 25. Version check: `@nestjs/bullmq@12.0.0` (Aug 2026) is ESM-only and targets Nest 12; the last line compatible with this project is `@nestjs/bullmq@11.0.5` (CJS, peers `@nestjs/* ^10 || ^11`, `bullmq ^3–^6`). `pg-boss@12` is also ESM-only (last CJS line: `11.x`).

**Options:**

### Option A: BullMQ + Redis via `@nestjs/bullmq` (11.x)
- Official Nest integration (`BullModule.forRootAsync`, `registerQueue`, `@Processor` + `WorkerHost`). Redis holds queue state; a new `redis` Compose service is added.
- **Pros:** Retry with `attempts` + `exponential`/fixed/custom `backoff`; `UnrecoverableError` skips retries for permanent failures; failed jobs are **kept by default** in the failed set (bounded via `removeOnFail: { count, age }`) and can be inspected/retried; stalled-job detection re-delivers jobs whose worker died; job schedulers (`upsertJobScheduler`) cover the cleanup job; `jobId`/`deduplication` give idempotent enqueue. Most battle-tested option, documented in docs.nestjs.com.
- **Cons:** New infrastructure piece and failure domain. Redis durability is **opt-in**: BullMQ docs require `maxmemory-policy noeviction` (anything else can evict queue keys) and recommend AOF (`appendonly yes`, `appendfsync everysec`) — without them, a Redis restart loses queued jobs. Must pin `@nestjs/bullmq@^11` until the project moves to Nest 12.

### Option B: BullMQ 6 with the PostgreSQL backend
- BullMQ 6 (Jul 2026) ships `createPostgresBackend`: the same Queue/Worker API, with state stored in PostgreSQL (≥13) in its own schema; wakeups via `LISTEN/NOTIFY`.
- **Pros:** No new container — reuses the existing `db`. Durable by default (WAL), no Redis persistence tuning. Full feature parity per docs (retries, schedulers, deduplication, events); code is identical to Option A, so switching later is cheap.
- **Cons:** ~3 months old; Redis remains "the most battle-tested option" per BullMQ docs. `@nestjs/bullmq@11.0.5` has no per-queue backend option — only the process-wide `setDefaultBackendFactory` works, which is not documented by NestJS (unverified path). Requires a separate `runMigrations` step alongside TypeORM migrations. ~1.5–2× lower throughput (irrelevant at this volume).

### Option C: pg-boss
- PostgreSQL-native job queue (`SKIP LOCKED`), mature since 2016. Jobs are sent with `retryLimit`, `retryDelay`, `retryBackoff`; supports dead-letter queues, `singletonKey`, cron `schedule`.
- **Pros:** No new container; durable by default; good retry/DLQ/schedule semantics; long track record.
- **Cons:** No official NestJS module — manual provider + `OnModuleInit`/`OnModuleDestroy` lifecycle wiring (or a community wrapper). Current major (12) is ESM-only; staying on 11.x means starting on an already-superseded major. Separate schema and lifecycle outside TypeORM.

### Option D: RabbitMQ (`@nestjs/microservices` RMQ transport or `@golevelup/nestjs-rabbitmq`)
- Dedicated message broker; durable queues + persistent messages + manual `ack` (`noAck: false`), unacked messages are re-queued when a consumer dies.
- **Pros:** Strong delivery semantics; standard broker with good tooling; scales to multi-service fan-out.
- **Cons:** No built-in delayed retry/backoff — needs DLX + TTL retry queues or the delayed-message plugin. No job state/attempt history: a "failed job" is a message in a DLQ. No scheduler (cleanup needs `@nestjs/schedule`). Heaviest infra for a single job type; the Nest RMQ transport is RPC/event-oriented, not a job-queue abstraction.

**Recommendation:** **Option A (BullMQ + Redis, `@nestjs/bullmq@^11`)** — it is the only option where retry/backoff, a kept failed-job record, stalled-job recovery, deduplicated enqueue and a periodic scheduler (needed by TD-07 and TD-13) all come out of the box with an official Nest integration that works on this CommonJS Nest 11 project. The cost is one Redis container that **must** be configured with `--appendonly yes --maxmemory-policy noeviction` in `compose.yaml`, plus new env keys (`REDIS_HOST=redis`, `REDIS_PORT`) in the Joi schema. Option B is the credible "no-Redis" alternative with the same code API; it is not recommended yet because it is new and has no documented Nest wiring — re-evaluate when `@nestjs/bullmq` supports backends officially.

**Decision:** Option A: BullMQ + Redis via `@nestjs/bullmq` (11.x)

---

## TD-02: Local S3-Compatible Object Storage Server

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The diagram names "S3 or MinIO", with MinIO intended for local development and S3 for production. Research finding: MinIO Community Edition entered maintenance mode (Dec 2025), its repository is archived and distributed as source only, and `minio/minio` no longer exists on Docker Hub (verified: the Hub API returns "object not found"; the quay.io mirror returned no active tags). The application code will use only the S3 API through `@aws-sdk/client-s3` (3.x), so the local server is swappable — but it must support multipart upload, presigned URLs, CORS (browser PUTs need `ETag` exposed) and `Range` GETs. Choosing it touches `compose.yaml`, `.env.example` and the bucket bootstrap.

**Options:**

### Option A: RustFS
- Rust S3-compatible server, single container (`rustfs/rustfs:1.0.3`, released Oct 2026), MinIO-like UX (port 9000 + web console), Apache-2.0.
- **Pros:** One-container setup like MinIO. Docs cover multipart, presigned URLs, CORS (`RUSTFS_CORS_ALLOWED_ORIGINS`), `AbortIncompleteMultipartUpload` lifecycle, plus built-in cleanup of stale multipart uploads (24h). Actively released.
- **Cons:** Young project (1.0 is recent); some 2026 comparisons still call it early-stage. Some features are RustFS-only extensions (e.g. `x-rustfs-max-total-object-size`) that must **not** be relied on, since production S3 does not have them.

### Option B: Garage
- Lightweight Rust S3 server for self-hosting (`dxflrs/garage:v2.5.0`), developed since 2020.
- **Pros:** Published compatibility table: multipart (incl. `ListParts`), presigned URLs, `PutBucketCors`, lifecycle `AbortIncompleteMultipartUpload`/`Expiration` all implemented. Small footprint, steady releases.
- **Cons:** Needs bootstrap steps before first use (`garage layout assign`/`apply`, key and bucket creation) — an init script/container in Compose. No versioning or object lock (not needed here). Default S3 port 3900; different admin UX from the MinIO the team expected.

### Option C: MinIO (last community release, pinned)
- Keep MinIO by building the archived source with its Dockerfile, or by pulling a third-party mirror of the last community image (Sep/Oct 2025).
- **Pros:** Most widely documented S3 emulator; matches the diagram label; very complete S3 compatibility.
- **Cons:** Unmaintained — no security fixes. No official pullable image: a source build adds a Go build step to the dev setup, and third-party mirrors are a supply-chain risk. Does not support the `AbortIncompleteMultipartUpload` lifecycle action (MinIO docs).

**Recommendation:** **Option A (RustFS)** — it keeps the one-container developer experience the plan assumed with MinIO, is actively maintained, and its documented features cover everything this phase needs (multipart, presign, CORS, `Range`, abandoned-upload cleanup). Because the code depends only on the S3 API, the risk of its youth is limited: the first implementation step should be a short spike that checks presigned `UploadPart` + `CompleteMultipartUpload`, CORS with `ETag` exposed, and `Range` → `206` against RustFS. If the spike fails, switch to Option B (Garage) with only Compose changes. Option C is not recommended: dev environments should not depend on an archived server with no official image. Separate task to note: update the diagram's "S3 or MinIO" label.

**Decision:** Option A: RustFS

---

## TD-03: Bucket and Object Key Layout

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Videos and thumbnails must be stored in a way that supports per-video access control (unpublished and, later, unlisted videos must not be publicly listable), easy deletion of everything belonging to one video, and storage growth planning (Pontos de Atenção: "Armazenamento"). The key format is a contract between the API (upload), the worker (reads the original, writes the thumbnail) and the DB columns that store the keys. Depends on TD-10 (which ID is public).

**Options:**

### Option A: Single private bucket, prefix per video (internal UUID)
- One bucket (e.g. `streamtube-media`), no public access. Keys: `videos/{videoId}/original` and `videos/{videoId}/thumbnail.jpg`, where `videoId` is the internal UUID primary key. Original filename and MIME type live in the DB, not in the key.
- **Pros:** One bucket to bootstrap, configure CORS for and secure. Deleting a video means deleting one prefix. Keys contain no user input (no encoding/path-traversal issues) and never change, even if the public ID or the title changes. Prefix-level policies (e.g. making thumbnails public later) remain possible on S3.
- **Cons:** Originals and thumbnails share one bucket-level configuration (CORS, lifecycle), so different rules must be prefix-scoped.

### Option B: Two private buckets (`videos` and `thumbnails`)
- Originals in one bucket, images in another; same `{videoId}` key scheme inside each.
- **Pros:** Independent policies per asset type (e.g. a future public-read/CDN thumbnails bucket for the Phase 07 home grid; lifecycle rules only on the videos bucket).
- **Cons:** Two buckets to bootstrap and configure in every environment; one video's assets are split across buckets. The policy benefit is speculative for this phase.

### Option C: Channel-scoped prefixes
- `channels/{channelId}/videos/{videoId}/original` (+ thumbnail) in a single bucket.
- **Pros:** Per-channel storage usage can be computed by listing a prefix; ownership is visible in the key.
- **Cons:** Puts ownership into an immutable key; listing millions of objects to account usage is slower than a `SUM(size_bytes)` on the DB; adds no access-control value since all access goes through presigned URLs.

**Recommendation:** **Option A (single private bucket, `videos/{videoId}/…`)** — it is the smallest correct setup: one bucket to create and protect, immutable keys based on the internal UUID (independent of TD-10's public ID), and one-prefix deletion. Storage growth is tracked through a `size_bytes` column in the DB rather than through key structure. If Phase 07 needs cacheable public thumbnails, a prefix policy or a move to Option B can be decided then.

**Decision:** Option A: Single private bucket, prefix per video (internal UUID)

---

## TD-04: Presigned URL Host (Internal vs Public Storage Endpoint)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The API and the worker reach storage inside the Compose network by service name (`http://storage:9000`, per the project's Docker networking rule). The browser runs outside that network and cannot resolve `storage`. A SigV4 presigned URL signs the `Host` header, so a URL signed for `storage:9000` cannot be rewritten to `localhost:9000` afterwards — the signature would break. Every presigned URL meant for the browser (part uploads, streaming, download) must be signed for a host the browser can reach. This decides the canonical storage env keys (Joi schema + `compose.yaml` + `.env.example`).

**Options:**

### Option A: Two endpoints — internal for operations, public for browser-facing signatures
- `S3_ENDPOINT=http://storage:9000` is used by the S3 client that performs operations (create/complete/abort multipart, `HeadObject`, worker reads/writes). `S3_PUBLIC_ENDPOINT=http://localhost:9000` configures a second S3 client used **only** to presign URLs returned to the browser. Presigning is a local computation (no network call), so the public client never needs to reach storage from inside the container.
- **Pros:** Works without any host-machine setup. Respects the Compose service-name rule for every server-side connection. In production both point to the S3 or CDN host (or the public one is left unset and falls back to the internal one).
- **Cons:** Two client instances and one more env key; tests must confirm that browser URLs use the public host and server operations use the internal one.

### Option B: One hostname resolvable on both sides
- Use a single name (e.g. `storage.localhost` or a custom domain) mapped to the storage container by a Compose network alias, and to `127.0.0.1` on the developer's machine via `/etc/hosts`.
- **Pros:** One S3 client, one endpoint; URLs look the same everywhere.
- **Cons:** Every developer must edit their hosts file (and `*.localhost` resolution varies by OS/browser); setup fails silently when forgotten. Mixes the browser's host with the server's network path.

### Option C: Same-origin reverse proxy for storage
- Expose storage under the frontend origin (e.g. `/storage/*`) through a proxy, and sign URLs for that public origin.
- **Pros:** No CORS configuration on storage; one public origin.
- **Cons:** 10 GB uploads and every streamed byte pass through the proxy. If that proxy is the Next.js BFF, this goes against the requirement that the file does not pass through application servers. A dedicated nginx would be new infrastructure that this phase does not need.

**Recommendation:** **Option A (internal + public endpoints)** — it is the only option that works on a fresh clone with no host-machine changes and keeps all server-to-server traffic on Compose service names, as `CLAUDE.md` requires. `S3_PUBLIC_ENDPOINT=http://localhost:9000` is an intended exception to the "never `localhost`" rule because it is read by the host's browser, not by a container. It should be documented as such in `.env.example`. Proposed canonical keys: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE` (true for the local server). Implementation note from the SDK docs: set `requestChecksumCalculation: 'WHEN_REQUIRED'` on the S3 clients, because the SDK's default flexible checksums add `x-amz-checksum-*` headers that break presigned part uploads against non-AWS servers.

**Decision:** Option A: Two endpoints — internal for operations, public for browser-facing signatures

---

## TD-05: Large-File Upload Protocol (up to 10 GB, direct to storage)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** 10 GB uploads must not pass through the API process, and Pontos de Atenção requires resuming after a connection failure. A single presigned `PUT` cannot be used: S3 caps a single PUT at 5 GiB and it cannot be resumed. S3 multipart limits: up to 10,000 parts, 5 MiB–5 GiB per part (the last part can be smaller). The protocol is a handshake between the API and the future upload screen, which is why it is Cross-layer. With Strict BFF, the handshake calls go browser → BFF → API, while the part bytes go browser → storage. Depends on TD-03 and TD-04.

**Options:**

### Option A: Presigned S3 multipart, orchestrated by the API
- `POST /videos/uploads` (with filename, size, MIME type) creates the video row with `status = draft` (TD-12), calls `CreateMultipartUpload`, stores `upload_id` and the key, and returns the video ID, a fixed part size and the part count. The client then asks for presigned `UploadPart` URLs in batches, `PUT`s each part directly to storage, and keeps the returned `ETag`s. To resume, an endpoint backed by `ListParts` reports which parts are already stored, and only the missing ones are re-signed.
- **Pros:** No file bytes go through the API or the BFF. Uses only standard S3 (works on RustFS/Garage/S3). Parts can be uploaded in parallel and retried individually. The API decides the part size and part count, so it controls the maximum size.
- **Cons:** The API needs several endpoints (initiate, sign parts, list parts, complete, abort), and the client needs part-upload logic (or Uppy's `@uppy/aws-s3` later in the frontend). Storage needs CORS that allows `PUT` and exposes `ETag`. S3 has no total-size limit for a multipart upload, so the 10 GB limit must be enforced by the API (see Recommendation).

### Option B: tus resumable protocol through a tus server (`tusd` container or `@tus/server` + `@tus/s3-store`)
- The client uses tus (`tus-js-client`/Uppy). A tus server receives the chunks and writes them to S3 as multipart; hooks (`pre-create`, `post-finish`) call the API to create the draft and to signal completion.
- **Pros:** Standard resumable protocol with mature clients; resume behavior and offsets are handled by the protocol; uploads are not limited by presigned URL expiry.
- **Cons:** Every byte goes through the tus server. Embedded in NestJS (`@tus/server` 2.x, which is ESM-only), this breaks the "not through the API" constraint. As a separate `tusd` container, it adds a new service that handles bandwidth and a hook contract to secure. It also adds a protocol the production setup must host, while Option A uses S3 directly.

**Recommendation:** **Option A (presigned S3 multipart)** — it is the only option where the file never passes through an application process (API, BFF or tus server), which matches both the requirement and the diagram's direct frontend ↔ storage link. Resume uses standard `ListParts`. Proposed parameters: fixed **64 MiB** part size (10 GiB → 160 parts, well under 10,000 and above the 5 MiB minimum), presigned part URLs valid for 1 h and issued in batches. Size enforcement without vendor extensions: (1) reject `size > 10 GiB` at initiation, (2) sign only part numbers `1..partCount` and include `Content-Length` in each part's signature, (3) after completion, verify the object size with `HeadObject` before accepting it. Pre-registration happens in the same initiation call that creates the multipart upload.

**Decision:** Option A: Presigned S3 multipart, orchestrated by the API

---

## TD-06: Upload Completion Detection

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** After the last part is uploaded, the system must know that the upload finished, before the processing job can be queued. A multipart upload only becomes an object after someone calls `CompleteMultipartUpload`. The question is who calls it and how the API finds out. Depends on TD-05.

**Options:**

### Option A: Client signals, API completes using its own `ListParts`
- The client calls `POST /videos/{id}/upload/complete`. The API calls `ListParts`, then `CompleteMultipartUpload` with the server-side part list, checks the size with `HeadObject`, moves the video `draft → processing` (conditional update `WHERE status = 'draft'`) and enqueues the job.
- **Pros:** Synchronous and deterministic: when the endpoint returns, the object exists and the job is queued. The API does not trust client-reported ETags. Works the same on every S3-compatible server. Retry-safe when combined with TD-13 (calling it again is a no-op or re-enqueues the same job).
- **Cons:** If the client never calls `complete` (tab closed after the last part), the video stays in `draft` until TD-07 cleans it up. Completing an upload of about 160 parts takes a moment, but it is still fast.

### Option B: Client completes directly, storage event notifies the API
- The client also gets a presigned `CompleteMultipartUpload` URL. The storage server publishes an `ObjectCreated:CompleteMultipartUpload` event (webhook/queue) to the API.
- **Pros:** The API does not take part in the final step; the notification fires even if the client goes away right after completing.
- **Cons:** Event notifications are configured differently on each server (RustFS/Garage/S3→SQS/EventBridge), so the local and production setups behave differently. Delivery is asynchronous and can be delayed or lost. A webhook endpoint must be authenticated. The API no longer checks the part list before accepting the object.

### Option C: Polling reconciler
- A scheduled job lists videos in `draft` and checks the storage (`HeadObject`/`ListParts`) to see whether the object is now complete.
- **Pros:** Needs no client signal and no storage events.
- **Cons:** Delays processing by up to one polling interval; makes many storage calls; the client still has to complete the multipart upload itself (as in Option B).

**Recommendation:** **Option A (client signals, API completes)** — it gives a single, synchronous point where the API knows for certain that the object exists. It does not depend on storage-specific event setups, which differ between local and production environments. The only gap (a client that never signals) is covered by the cleanup job in TD-07.

**Decision:** Option A: Client signals, API completes using its own `ListParts`

---

## TD-07: Abandoned Upload Cleanup

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** An incomplete multipart upload keeps its parts in storage (still using space, billed on S3) and leaves the video row stuck in `draft`. Uploads can be abandoned (tab closed, user gave up) and must not pile up. Depends on TD-01 (scheduler), TD-05, TD-12.

**Options:**

### Option A: Application cleanup job (scheduled job on the queue)
- A recurring job (BullMQ job scheduler, e.g. hourly) finds videos in `draft` whose `created_at`/last-activity is older than a threshold (e.g. 24 h), calls `AbortMultipartUpload`, and marks them `failed` (conditional update `WHERE status = 'draft'`, so a `complete` that wins the race is not overwritten) with the reason `upload_abandoned` (or deletes the row).
- **Pros:** Cleans storage **and** the DB together. Behaves the same on every storage server. Testable as normal application code.
- **Cons:** It is more code to write; if `AbortMultipartUpload` fails, the job must retry on the next run.

### Option B: Storage lifecycle rule only
- Configure `AbortIncompleteMultipartUpload` (e.g. `DaysAfterInitiation: 1`) on the bucket.
- **Pros:** No application code; it is applied by the storage server.
- **Cons:** It only removes parts — the DB row stays stuck in `draft`. Support depends on the server (S3/Garage/RustFS: yes; MinIO: no).

### Option C: Both
- The application cleanup job is the main mechanism; the lifecycle rule is a safety net for aborts that failed.
- **Pros:** Strongest guarantee against forgotten parts.
- **Cons:** Two mechanisms to configure; the lifecycle rule mostly duplicates the cleanup job.

**Recommendation:** **Option A (application cleanup job)** — the DB row is what users and later phases see, and only application code can clean the DB and storage together. It reuses the TD-01 scheduler, so no new library is needed. A lifecycle rule (Option C) can be added cheaply at deploy time (Phase 07) as defense in depth, and RustFS already removes stale uploads after 24 h by default.

**Decision:** Option A: Application cleanup job (scheduled job on the queue)

---

## TD-08: Video Worker Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The diagram has a separate Video Worker container (FFmpeg) that reads from storage and updates the DB. FFmpeg work is CPU-heavy and must not slow the API down ("sem impacto na performance"). The worker needs the same entities, config (TD-04 env keys) and storage client as the API. The current `Dockerfile.dev` is `node:25.6.0-slim` without FFmpeg.

**Options:**

### Option A: Same codebase, second entrypoint, separate Compose service
- `nestjs-project/src/worker.ts` starts `NestFactory.createApplicationContext(WorkerModule)` (no HTTP server). `WorkerModule` imports the shared config/TypeORM/storage modules and the BullMQ processor. A `video-worker` Compose service reuses the same build context, with `ffmpeg` installed via `apt`.
- **Pros:** Separate process and container, so CPU load is isolated, the worker can be scaled on its own, and it matches the diagram. Entities, config and storage code are reused with full DI. One `package.json`, one lint/test/tsc pipeline.
- **Cons:** The image is larger because of FFmpeg (also in the API image if they share a Dockerfile, unless a separate stage/target is used). Module boundaries need care so the worker does not load HTTP-only modules.

### Option B: Processor inside the API process
- Register `@Processor` in the API's `AppModule`; the same Node process serves HTTP and runs FFmpeg jobs (as child processes).
- **Pros:** Simplest: no new service or entrypoint.
- **Cons:** CPU-heavy work runs in the same container as the API, which works against the "sem impacto na performance" requirement. The API and the worker can't be scaled separately. Goes against the diagram.

### Option C: Separate subproject (`video-worker/` with its own `package.json`)
- An independent Node/Nest project for the worker.
- **Pros:** Smallest worker image and dependency set; fully independent deploys.
- **Cons:** Entities, config and storage code must be duplicated or moved into a shared package (new monorepo tooling decision). Two dependency trees and pipelines to maintain.

**Recommendation:** **Option A (same codebase, second entrypoint, `video-worker` service)** — it gives the process/container isolation the diagram and the performance requirement call for, without duplicating the domain model or creating a shared-package setup. FFmpeg runs as a child process, so the worker's event loop stays free to renew BullMQ job locks during long jobs. Responsibilities stay separate: the API's videos module only *produces* jobs, and a processing module loaded only by `WorkerModule` *consumes* them.

**Decision:** Option A: Same codebase, second entrypoint, separate Compose service

---

## TD-09: FFmpeg/ffprobe Invocation and Input Access

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The worker must extract duration and metadata (container, codecs, resolution, bitrate) and grab one frame as the thumbnail, from files up to 10 GB stored in object storage. Two questions are linked: how the binaries are called, and how they read the file. Version check: `fluent-ffmpeg` (2.1.3) is **deprecated** on npm ("Package no longer supported"), so it is not a candidate. Depends on TD-04 (internal endpoint) and TD-08.

**Options:**

### Option A: Spawn system `ffprobe`/`ffmpeg` reading a presigned GET URL
- The worker presigns a short-lived GET for the original (with the **internal** endpoint) and runs `ffprobe -v error -print_format json -show_format -show_streams <url>` and `ffmpeg -ss <t> -i <url> -frames:v 1 …` through `child_process.spawn`. FFmpeg's HTTP input uses `Range` requests, so it only downloads the headers and the bytes around the chosen frame.
- **Pros:** Never downloads the 10 GB file, so no temporary disk space is needed and processing time doesn't grow with file size. JSON output is easy to type. No wrapper library.
- **Cons:** Depends on the network during processing (handled by retries, TD-13). Files with the index at the end (MP4 `moov` atom) need extra range requests (FFmpeg handles this). Process exit codes and timeouts must be handled by hand.

### Option B: Spawn system binaries after downloading to a temporary volume
- The worker streams the object to a scratch volume, then runs `ffprobe`/`ffmpeg` on the local file and deletes it.
- **Pros:** Local file reads are the most predictable for FFmpeg; no network dependency once downloaded.
- **Cons:** Needs up to 10 GB of free disk per job running at the same time, and a full download before any work starts (minutes for large files). The temporary files must be cleaned up if the job crashes.

**Recommendation:** **Option A (spawn system binaries on a presigned URL)** — metadata and a single frame only need a small part of the file, so reading through HTTP `Range` avoids the disk space and download time of Option B, which grow with file size. Install binaries with `apt-get install ffmpeg` in the worker image (Debian package, versioned with the base image) rather than `ffmpeg-static`, so the version is visible and patchable. Pick the thumbnail frame relative to the duration (e.g. 10 % of the duration, with a fallback to the first frame for very short clips). If ffprobe reports no video stream, the file is treated as invalid media → permanent failure (TD-13).

**Decision:** Option A (spawn system binaries on a presigned URL)

---

## TD-10: Unique Public Video ID (URL strategy)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, unique URL that never conflicts with another (Pontos de Atenção: "URLs únicas"). The ID appears in API routes and in the future frontend watch route (`/watch/{id}`), so it is a contract shared by both sides. It is generated during pre-registration (TD-05). The internal primary key stays a UUID, following the project's existing entity pattern.

**Options:**

### Option A: Use the UUID primary key in the URL
- Expose the existing `uuid` PK directly.
- **Pros:** No new column, no generation logic; guaranteed unique.
- **Cons:** 36 characters — not the "URL curta" the plan asks for. Exposes the internal identifier.

### Option B: Random short ID (11-char base64url from `node:crypto`) in its own unique column
- `public_id = randomBytes(8).toString('base64url')` → 11 URL-safe characters (64 bits), stored with a `UNIQUE` index. On a unique-violation error, regenerate and retry (same pattern as the channel nickname in `phase-02-auth/TD-10`).
- **Pros:** Short, YouTube-like, impossible to guess. The `UNIQUE` index guarantees no conflict, and with 64 bits retries almost never happen (~3·10⁻⁶ chance at 10 M videos). No dependency (`nanoid@6` is ESM-only, which conflicts with this CJS build).
- **Cons:** One more column and index; the generation and retry logic must be tested.

### Option C: Sqids/Hashids encoding of a sequential number
- Encode a `bigint` sequence into a short string.
- **Pros:** Very short, collision-free by design, no retries.
- **Cons:** Can be decoded back to the sequence, which reveals upload order and volume and lets anyone list videos one by one — this would defeat Phase 04's unlisted ("somente via link") visibility. Needs an extra sequence column.

### Option D: Slug from the title
- `my-video-title-x7k2`.
- **Pros:** Readable, SEO-friendly.
- **Cons:** Titles are not known when the upload starts and can be edited in Phase 04, so URLs would change or go stale. Still needs a random suffix to be unique.

**Recommendation:** **Option B (random 11-char base64url `public_id`)** — it satisfies "short" and "never conflicts" (enforced by the `UNIQUE` index, not by probability) and cannot be guessed, which Phase 04's unlisted visibility depends on. It uses the same generate-and-retry-on-unique-violation pattern already used for channel nicknames, and needs no new dependency. Storage keys keep using the internal UUID (TD-03), so the public ID can change without moving any object.

**Decision:** Option B (random 11-char base64url `public_id`)

---

## TD-11: Streaming and Download Delivery

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file, which means HTTP `Range` requests answered with `206 Partial Content`. Users must also be able to download the original file. The diagram shows the frontend streaming **directly from storage**. Who may watch a non-published video is a Phase 04/05 rule (visibility, anonymous access); this TD only decides *where* that check runs and how the bytes are delivered. The player's `src` URL is a backend↔frontend contract. Transcoding to HLS/DASH is **not** in Phase 03 ("extração de duração e metadados" only), so delivery is the original file played progressively. Depends on TD-03, TD-04, TD-10.

**Options:**

### Option A: API checks access, then redirects (`302`) to a presigned GET
- `GET /videos/{publicId}/stream` checks access and responds `302` to a presigned GET URL (public endpoint). Storage then handles `Range` → `206` natively. `GET /videos/{publicId}/download` does the same, with `ResponseContentDisposition: attachment; filename="<original name>"` signed into the URL.
- **Pros:** No video bytes go through the API, matching the diagram. Access is decided in one place (the redirect endpoint), where the Phase 04/05 visibility rules will plug in. `Range`/`206` and `Content-Length`/`ETag` come from the storage server without custom code. Download is the same mechanism with one extra parameter.
- **Cons:** A presigned URL's expiry is checked on **every** request, and the player sends new range requests while seeking, so the stream URL must stay valid for a whole viewing session (e.g. 6 h; SigV4 allows up to 7 days). Anyone who copies the URL can use it until it expires. Under Strict BFF, the Next route must pass the `302` through instead of following it.

### Option B: API proxies the bytes with `Range` passthrough
- The API reads the `Range` header, calls `GetObject` with that range, and streams the result back with `206`, `Content-Range` and `Accept-Ranges`.
- **Pros:** Access is checked on every request; storage is never exposed to clients; no URL-expiry concerns.
- **Cons:** Every watched byte goes through Node (and through the BFF under Strict BFF), which loads the API with exactly the traffic the plan wants to keep away from it. `Range` parsing, `206`/`416` handling and backpressure have to be written by hand.

### Option C: Public-read bucket with permanent object URLs
- Make the video objects publicly readable and return their direct URLs.
- **Pros:** Simplest; URLs never expire; works directly with a CDN.
- **Cons:** No access control at all: unpublished videos (and later unlisted ones) are readable by anyone with the URL, and a URL can never be revoked. This conflicts with the private bucket in TD-03.

**Recommendation:** **Option A (access check + `302` to presigned GET)** — it is the only option that keeps video bytes off the API and still has one place where access is checked for Phases 04/05. Streaming and download become the same mechanism, and `Range`/`206` is handled by the storage server instead of custom code. Proposed TTLs: about 6 h for stream URLs (long enough for a viewing session with seeking), about 15 min for download URLs. Known limitation to record: the original file is played as uploaded, so formats the browser can't play (e.g. some MKV/HEVC files) will download but not play. Transcoding is not in this phase.

**Decision:** Option A (access check + `302` to presigned GET)

---

## TD-12: Video Status Lifecycle Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** A video is pre-registered "como rascunho" when the upload starts, then processed, then becomes ready or fails. Phase 04 later adds the separate "rascunho → publicação" flow and visibility. How states are modeled now decides whether Phase 04 can add publication without reworking this column, whether TD-07 can find abandoned uploads, and whether TD-13 can make updates conditional on the current state.

**Options:**

### Option A: Single `status` enum — `draft | processing | ready | failed`
- Follows the phase wording literally: `draft` from upload start until `complete`, then `processing`, then `ready` or `failed`.
- **Pros:** Matches the plan's language one-to-one; one column.
- **Cons:** "Draft" means two things: "upload in progress" and "not published". After processing, a `ready` video is still a draft in Phase 04's sense, so Phase 04 must either add `published` to this enum (mixing processing state with publication state) or add a second field anyway. "Uploading" and "uploaded, waiting to be queued" can't be told apart.

### Option B: Processing status separate from publication — `uploading | processing | ready | failed`
- `status` describes the file's technical state only. "Rascunho" means *not published*: every video starts unpublished, and Phase 04 adds publication/visibility as its own fields. A `failure_reason` code is stored when `failed`.
- **Pros:** Two independent questions in two places, so Phase 04 adds publication without changing this enum. `uploading` makes TD-07's cleanup query exact. Each transition is a clean conditional update (`WHERE status = 'processing'`) for TD-13.
- **Cons:** The plan's word "rascunho" doesn't appear in the enum; it has to be explained in the API docs (a video is a draft while it is unpublished, whatever its processing status).

### Option C: One enum covering both lifecycles — `uploading | processing | draft | published | failed`
- One state machine for upload, processing and publication.
- **Pros:** One field answers "what can the user do with this video".
- **Cons:** Defines Phase 04 states now (out of scope). Combinations can't be expressed (e.g. a published video being reprocessed). Every publication change must also consider processing states.

**Recommendation:** **Option A (single `status` enum: `draft | processing | ready | failed`)** — the phase literally describes the cycle "rascunho → processando → pronto/erro" and asks for "pré-cadastro como rascunho", so the status column mirrors the requirement one-to-one. The main Option A con is removed by fixing the meaning of `draft` and keeping publication out of this enum:
- `draft` means only "video pre-registered, upload not yet completed". It is set at upload initiation (TD-05) and left only by the `complete` call (TD-06), which moves `draft → processing`.
- Publication/visibility (Phase 04) will be a **separate field** created in Phase 04. It never adds values to this enum.
- TD-07 and TD-13 still get exact states: the cleanup job queries `draft` rows older than the threshold, and every transition is a conditional update on the current state (`WHERE status = 'draft'` on completion, `WHERE status = 'processing'` in the worker).

Why Option B was not chosen: its only advantage over A was separating the file's state from publication. With the meaning of `draft` fixed as above and publication kept in its own Phase 04 field, A provides the same separation and uses the plan's own vocabulary. B would rename the requirement's "rascunho" state to `uploading` and require API docs explaining that "rascunho" means something other than the status column.

Known trade-off to carry into Phase 04: there, "rascunho → publicação" uses "rascunho" in the *publication* sense, and a processed but unpublished video has `status = ready`, not `draft`. Phase 04 must name its publication field/values without reusing `draft`.

**Decision:** Option A (single `status` enum: `draft | processing | ready | failed`) — `draft` = pre-registered, upload not yet completed; publication/visibility is a separate field created in Phase 04.

**Note:** Changed from Option B to Option A during pre-`plan-context` review, so that the status column reflects the phase's "rascunho → processando → pronto/erro" cycle literally. The Recommendation above was rewritten to match.

---

## TD-13: Processing Failure, Retry and Idempotency Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Processing can fail for temporary reasons (storage/network/DB unavailable, worker restarted mid-job) or permanent ones (the file is not a valid video). The same job can run more than once (retries, stalled-job re-delivery, a `complete` call repeated by the client). There is also a gap between the DB commit (`status = processing`) and the enqueue: if the enqueue fails after the commit, the video stays in `processing` with no job. A manual "reprocess" endpoint is not in the Phase 03 bullets and is not proposed. Depends on TD-01, TD-06, TD-12.

**Options:**

### Option A: Queue-native retries + idempotent job keyed by video + re-enqueue on repeat
- Enqueue with `jobId = videoId` (duplicates are ignored), `attempts: 3`, exponential `backoff`, and kept failures. Worker: invalid media throws `UnrecoverableError` (fails at once); other errors are retried. Results are written with a conditional update (`WHERE id = $1 AND status = 'processing'`) and a fixed thumbnail key (overwriting is safe). When the last attempt fails, the worker sets `status = failed` with a `failure_reason`. Commit/enqueue gap: `complete` is retry-safe (it moves `draft → processing` only with `WHERE status = 'draft'`; if the video is already `processing`, it enqueues again with the same `jobId`), and the TD-07 scheduled job also re-enqueues videos stuck in `processing` with no active job.
- **Pros:** Uses only TD-01 features; every step can run twice without side effects. Permanent failures stop immediately instead of wasting retries. The commit/enqueue gap is closed by idempotent re-enqueue, with no new table.
- **Cons:** The gap is closed *eventually* (on the client's retry or on the next scheduled run), not atomically. The "stuck in `processing`" check must use a threshold well above the longest normal job.

### Option B: Transactional outbox
- The `processing` status change and an `outbox` row are written in the same DB transaction; a relay reads the outbox and enqueues jobs; the worker side is as in Option A.
- **Pros:** Guarantees every committed `processing` status gets a job; standard pattern.
- **Cons:** New table, relay process/loop, and outbox cleanup — infrastructure built for a single job type whose gap Option A already closes through idempotency.

**Recommendation:** **Option A (queue-native retries + idempotent `jobId = videoId`)** — every step is safe to repeat (deduplicated enqueue, conditional update, fixed keys), so retries and re-delivery cause no damage. Separating permanent from temporary errors keeps bad uploads from using up retries. The one gap (commit succeeded, enqueue failed) is closed by re-enqueuing the same `jobId`, without an outbox. Revisit Option B if more job types later need guaranteed delivery.

**Decision:** Option A (queue-native retries + idempotent `jobId = videoId`)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Job Queue Technology | BullMQ + Redis via `@nestjs/bullmq@^11` | A (BullMQ + Redis via `@nestjs/bullmq` 11.x) |
| TD-02 | Repo-wide | Local S3-Compatible Object Storage Server | RustFS (spike first; Garage as fallback) | A (RustFS) |
| TD-03 | Backend | Bucket and Object Key Layout | Single private bucket, `videos/{videoId}/…` | A (Single private bucket, prefix per video — internal UUID) |
| TD-04 | Backend | Presigned URL Host (Internal vs Public Endpoint) | Two endpoints: internal for operations, public for browser-facing signatures | A (Two endpoints — internal for operations, public for browser-facing signatures) |
| TD-05 | Cross-layer | Large-File Upload Protocol | Presigned S3 multipart orchestrated by the API (64 MiB parts) | A (Presigned S3 multipart, orchestrated by the API) |
| TD-06 | Backend | Upload Completion Detection | Client signals, API completes using its own `ListParts` | A (Client signals, API completes using its own `ListParts`) |
| TD-07 | Backend | Abandoned Upload Cleanup | Application cleanup job on the queue scheduler | A (Application cleanup job — scheduled job on the queue) |
| TD-08 | Backend | Video Worker Topology | Same codebase, second entrypoint, `video-worker` service | A (Same codebase, second entrypoint, separate Compose service) |
| TD-09 | Backend | FFmpeg/ffprobe Invocation and Input Access | Spawn system binaries on a presigned URL (no download) | A (Spawn system binaries on a presigned URL) |
| TD-10 | Cross-layer | Unique Public Video ID | Random 11-char base64url `public_id` + `UNIQUE` index | B (Random 11-char base64url `public_id`) |
| TD-11 | Cross-layer | Streaming and Download Delivery | Access check + `302` to presigned GET | A (Access check + `302` to presigned GET) |
| TD-12 | Backend | Video Status Lifecycle Model | Single `status` enum `draft/processing/ready/failed` (`draft` = upload not completed) | A (Single `status` enum: `draft \| processing \| ready \| failed`) |
| TD-13 | Backend | Processing Failure, Retry and Idempotency | Queue-native retries + idempotent `jobId = videoId` | A (Queue-native retries + idempotent `jobId = videoId`) |
