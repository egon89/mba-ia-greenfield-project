# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"; video-worker must show "(healthy)"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Storage bucket:** `docker compose ps -a storage-init` — the one-shot `storage-init` must have exited with code `0`

**Exception — `video-worker`:** the video worker (`src/worker.ts`, script `start:worker:dev`) is part of the infrastructure and **does** start on `docker compose up`, so videos are processed after upload with no manual step. Check it with `docker compose ps video-worker` — expect `(healthy)` (the healthcheck runs `pgrep -f dist/worker`; it can show `(health: starting)` for up to 120 s on the first `up`, while `npm install`/compilation finish) — and `docker compose logs video-worker` (expect `Video worker started`); it opens no HTTP port. `(unhealthy)` means the worker process died while the container stayed up (the `nest start --watch` parent survives it): recover with `docker compose restart video-worker`. Dependencies must be installed (`docker compose exec nestjs-api npm install`) before the first `up`, otherwise `video-worker` restarts in a loop (`restart: unless-stopped`).

**Restart policy:** `video-worker`, `db`, `redis` and `storage` use `restart: unless-stopped`, so they come back together when the machine (or the Docker daemon) restarts. `storage-init` (one-shot), `nestjs-api` (idle) and `mailpit` do not; run `docker compose up -d` after a reboot to bring them back.

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000` (idle container; the API starts only on `npm run start:dev`)
- `video-worker` — same image and code, running the worker entrypoint (`npm run start:worker:dev`); starts with `up`, no port; `restart: unless-stopped`; healthy when `docker compose ps` shows `(healthy)` (`unhealthy` = worker stopped → `docker compose restart video-worker`)
- `db` — PostgreSQL 17 (`restart: unless-stopped`), port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP capture for transactional emails: SMTP on port `1025`, web UI on `8025`
- `redis` — Redis 7 (BullMQ backend, `restart: unless-stopped`), port `6379`, AOF on and `maxmemory-policy noeviction`; ready when `docker compose exec redis redis-cli ping` returns `PONG`
- `storage` — RustFS (S3-compatible object storage, `restart: unless-stopped`), port `9000`; healthcheck on `/health`
- `storage-init` — one-shot AWS CLI container: creates the `S3_BUCKET` bucket (idempotent) and applies `docker/storage/cors.json`; must exit with code `0` (`docker compose ps -a storage-init`)

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos

### Endpoints (`VideosController`, all owner-only)

Every `/videos` route requires a valid access token (global `JwtAuthGuard`), and the controller is exempt from the auth throttler (`@SkipThrottle()`). `:publicId` is the 11-character `public_id`; the internal `id` never appears in a URL. Another user's video, an unknown `publicId` and a malformed one all return the same `404 VIDEO_NOT_FOUND`.

| Route | Effect | Main errors |
|-------|--------|-------------|
| `POST /videos` | Creates the draft on the caller's channel and opens the multipart upload | `400 VALIDATION_ERROR` |
| `POST /videos/:publicId/upload/part-urls` | Presigned `UploadPart` URLs (public endpoint, 1 h) | `400 INVALID_PART_NUMBER`, `409 VIDEO_UPLOAD_NOT_ACTIVE` |
| `GET /videos/:publicId/upload/parts` | Parts already stored (resume) | `409 VIDEO_UPLOAD_NOT_ACTIVE` |
| `POST /videos/:publicId/upload/complete` | Completes the upload, checks the size, `draft → processing`, enqueues `process-video` (idempotent while `processing`) | `409 UPLOAD_INCOMPLETE`, `409 VIDEO_UPLOAD_NOT_ACTIVE`, `422 UPLOAD_SIZE_MISMATCH` |
| `GET /videos/:publicId` | Status and extracted metadata (used to poll processing) | — |
| `GET /videos/:publicId/stream` | `302` to a presigned GET (6 h), `Cache-Control: no-store`; storage serves `Range` → `206` | `409 VIDEO_NOT_READY` |
| `GET /videos/:publicId/download` | Same as stream (15 min), with `Content-Disposition: attachment` and the original filename | `409 VIDEO_NOT_READY` |

### Queue (BullMQ + Redis)

- Queues: `video-processing` (job `process-video`, enqueued by the API on upload complete) and `video-maintenance` (job `cleanup-abandoned-uploads`, an hourly job scheduler registered by the worker).
- `process-video` uses `jobId` = the video `id`, so a repeated enqueue is a no-op; 3 attempts with exponential backoff (`PROCESS_VIDEO_JOB_OPTIONS` in `src/queue/queue.constants.ts`); failed jobs are kept for 7 days.
- The maintenance job marks drafts older than `UPLOAD_ABANDON_AFTER_HOURS` as failed (`upload_abandoned`) and re-enqueues or fails videos stuck in `processing` for more than `PROCESSING_STUCK_AFTER_MINUTES`.
- `QUEUE_PREFIX` sets the Redis key prefix (`bull` in `.env`). Jest sets it to `test` in `src/test/jest-env.setup.ts`, so test jobs never reach the running `video-worker`.

### Worker

- Entrypoint `src/worker.ts` → `WorkerModule` (no HTTP server). Started by the `video-worker` service with `npm run start:worker:dev`; `npm run build` emits `dist/worker.js` (`npm run start:worker:prod`).
- Runs on `docker compose up`; logs `Video worker started` (`docker compose logs video-worker`).
- Healthcheck: `pgrep -f dist/worker` (every 30 s, 3 retries, `start_period` 120 s). The container's main process is `nest start --watch`, which keeps running if the worker child dies, so `docker compose ps` shows `(unhealthy)` instead of a stopped container. Recover with `docker compose restart video-worker`.
- Uses `ffprobe` (metadata) and `ffmpeg` (thumbnail), both installed in the image (`Dockerfile.dev`). The video ends as `ready`, or `failed` with `invalid_media` / `processing_failed`.

### Storage (RustFS in dev, S3 in production)

- One private bucket, `S3_BUCKET`. Keys: `videos/{id}/original` (uploaded file) and `videos/{id}/thumbnail.jpg`.
- `storage-init` creates the bucket and applies `docker/storage/cors.json`, which must keep `ExposeHeaders: ["ETag"]` (the browser reads each part's `ETag`).
- Two S3 clients: `S3_ENDPOINT` (`http://storage:9000`) for the API and worker inside the Compose network, and `S3_PUBLIC_ENDPOINT` for URLs handed to the browser.
- **Exception to "never `localhost`":** `S3_PUBLIC_ENDPOINT=http://localhost:9000` is correct, because the browser on the host follows those URLs. The SigV4 signature binds the host, so tests that call presigned URLs from inside the container override it with `http://storage:9000`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
