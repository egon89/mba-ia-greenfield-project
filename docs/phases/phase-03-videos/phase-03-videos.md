---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-01T17:38:44-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-01T17:39:22-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-01T17:37:27-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-17T19:41:40-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-10-17T19:41:40-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the backend for uploading videos of up to 10GB directly to object storage without impacting API performance — with automatic draft pre-registration at upload start, background processing on a job queue (duration/metadata extraction and thumbnail generation from a video frame), a unique public URL per video, streaming playback without a full download, and video download by the user.

---

## Step Implementations

### SI-03.1 — Infra: Instalar dependências de fila e storage com versões fixadas

**Description:** Adiciona ao `nestjs-project` as bibliotecas da fila (BullMQ) e do S3 SDK com versões fixadas, para que os SIs seguintes partam de um manifesto estável e compatível com Nest 11 CommonJS.

**Technical actions:**

1. Instalar `@nestjs/bullmq@11.0.5` com versão exata (sem `^`) — última linha CommonJS para Nest 11; a 12.x é ESM-only (per `phase-03-videos/TD-01`, library-refs `@nestjs/bullmq`)
2. Instalar `bullmq@^6.5.3` — peer de `@nestjs/bullmq@11.x` (faixa `^3–^6`) (per `phase-03-videos/TD-01`)
3. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` fixados na **mesma versão exata 3.x** (ex.: ambos `3.N.M`), para que o presigner e o client compartilhem o mesmo `@smithy/*` (per `phase-03-videos/TD-04`)
4. Rodar dentro do container: `docker compose exec nestjs-api npm install` e conferir em `package-lock.json` que há uma única versão resolvida de `@aws-sdk/client-s3`

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `package.json` declara `"@nestjs/bullmq": "11.0.5"`, `"bullmq": "^6.5.3"` e `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` com a mesma string de versão 3.x exata
- `npm ls @nestjs/bullmq bullmq @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` (no container) termina sem `ERESOLVE`, `invalid` ou `missing`
- `npx tsc --noEmit` continua saindo com código 0

---

### SI-03.2 — Infra: Serviços Redis, RustFS e storage-init no Compose + namespaces de config

**Description:** Sobe a infraestrutura da fase (Redis para a fila, RustFS como storage S3 local, container `storage-init` que cria o bucket e aplica o CORS versionado) e registra os namespaces de configuração validados por Joi.

**Technical actions:**

1. Em `nestjs-project/compose.yaml`, adicionar: `redis` (`redis:7`, `command: redis-server --appendonly yes --maxmemory-policy noeviction`, healthcheck `redis-cli ping`) (per `phase-03-videos/TD-01`); `storage` (imagem RustFS, porta `9000:9000`, volume nomeado, credenciais via env) (per `phase-03-videos/TD-02`); `storage-init` (imagem `amazon/aws-cli`, `depends_on: storage`, roda `aws s3api create-bucket` idempotente + `aws s3api put-bucket-cors --cors-configuration file:///cors/cors.json` contra `http://storage:9000`) (per `phase-03-videos/TD-14`); `nestjs-api` passa a depender de `redis: service_healthy` e `storage-init: service_completed_successfully`
2. Criar `nestjs-project/docker/storage/cors.json` (montado em `storage-init`) — `CORSRules` com `AllowedOrigins` do frontend, `AllowedMethods: [PUT, GET, HEAD]`, `AllowedHeaders: ['*']`, `ExposeHeaders: ['ETag']`, `MaxAgeSeconds` (per `phase-03-videos/TD-14`, library-refs `@aws-sdk/client-s3`)
3. Criar `src/config/redis.config.ts` (`registerAs('redis')`: `REDIS_HOST`, `REDIS_PORT`), `src/config/queue.config.ts` (`registerAs('queue')`: `QUEUE_PREFIX` — prefixo das chaves BullMQ no Redis, isola as filas dos testes das filas do `video-worker`), `src/config/storage.config.ts` (`registerAs('storage')`: `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`) e `src/config/videos.config.ts` (`registerAs('videos')`: `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_ABANDON_AFTER_HOURS`, `PROCESSING_STUCK_AFTER_MINUTES`); registrar os quatro em `ConfigModule.forRoot({ load })` (per `phase-01-configuracao-base/TD-03`, `phase-03-videos/TD-04`)
4. Estender `src/config/env.validation.ts` com as novas chaves (`REDIS_HOST` obrigatório; `QUEUE_PREFIX` default `bull`, apenas `[a-z0-9_-]`; `S3_*` obrigatórios exceto `S3_FORCE_PATH_STYLE` default `true`; `UPLOAD_PART_SIZE_BYTES` default `67108864`, min `5242880`; `UPLOAD_ABANDON_AFTER_HOURS` default `24`; `PROCESSING_STUCK_AFTER_MINUTES` default `120`) (per `phase-01-configuracao-base/TD-02`)
5. Atualizar `.env` / `.env.example` com `REDIS_HOST=redis`, `QUEUE_PREFIX=bull`, `S3_ENDPOINT=http://storage:9000` e `S3_PUBLIC_ENDPOINT=http://localhost:9000`, com comentário registrando que este último é a exceção intencional à regra "nunca `localhost`" (lido pelo navegador do host, não por um container) (per `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: rejeita ausência de `REDIS_HOST` / `S3_BUCKET`; aplica defaults de `QUEUE_PREFIX` (`bull`), `UPLOAD_PART_SIZE_BYTES`, `UPLOAD_ABANDON_AFTER_HOURS`, `PROCESSING_STUCK_AFTER_MINUTES`; rejeita `UPLOAD_PART_SIZE_BYTES < 5242880` | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.1 — pacotes instalados antes de tocar config que os usa

**Acceptance criteria:**

- `docker compose up -d` deixa `redis` e `storage` em `running`/`healthy` e `storage-init` termina com exit code `0`
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` retorna `noeviction` e `CONFIG GET appendonly` retorna `yes`
- Rodar `storage-init` uma segunda vez também termina com exit code `0` (criação do bucket é idempotente)
- `aws s3api get-bucket-cors` contra `http://storage:9000` retorna a regra com `ExposeHeaders` contendo `ETag`
- A aplicação não sobe (erro de validação Joi) quando `S3_BUCKET` está ausente
- Sem `QUEUE_PREFIX` no ambiente, `queueConfig().prefix` vale `bull`; com `QUEUE_PREFIX=test`, vale `test`

---

### SI-03.3 — Spike de compatibilidade S3 do RustFS (multipart pré-assinado, CORS com ETag, Range → 206)

**Description:** Valida no RustFS, antes de qualquer código de domínio, os três comportamentos S3 dos quais a fase depende; o teste fica no repositório como regressão de compatibilidade do servidor de storage.

**Technical actions:**

1. Criar `src/storage/rustfs-compat.integration-spec.ts` montando um `S3Client` no próprio teste a partir de `storageConfig` (endpoint interno `http://storage:9000`, `forcePathStyle: true`, `requestChecksumCalculation: 'WHEN_REQUIRED'`, `responseChecksumValidation: 'WHEN_REQUIRED'`) e usando chaves sob o prefixo `test/spike/{uuid}/` no bucket provisionado pelo `storage-init` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`, `phase-03-videos/TD-14`)
2. Cenário multipart: `CreateMultipartUploadCommand` → `getSignedUrl(UploadPartCommand({ ..., PartNumber, ContentLength }))` para 2 partes (5 MiB + 1 KiB) → `fetch` `PUT` de cada parte na URL pré-assinada → `ListPartsCommand` → `CompleteMultipartUploadCommand` com as partes do `ListParts` → `HeadObjectCommand` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
3. Cenário CORS: `PUT` de uma parte com header `Origin` igual a uma origem permitida em `docker/storage/cors.json` e assert de `Access-Control-Allow-Origin` + `Access-Control-Expose-Headers` contendo `ETag`; mais um `OPTIONS` (preflight) com `Access-Control-Request-Method: PUT` retornando 2xx (per `phase-03-videos/TD-14`)
4. Cenário Range: `getSignedUrl(GetObjectCommand)` sobre o objeto completo e `fetch` com `Range: bytes=0-99` (per `phase-03-videos/TD-11`)
5. Registrar o resultado do spike (passou / falhou por item) na descrição do PR; se algum item falhar, trocar para Garage apenas no `compose.yaml` (Option B do `phase-03-videos/TD-02`) e repetir este SI antes de seguir

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| RustFS (S3 API) — multipart pré-assinado, CORS, Range | Integration: servidor de storage real no Compose | `src/storage/rustfs-compat.integration-spec.ts` |

**Dependencies:** SI-03.2 — `storage` e `storage-init` precisam estar no Compose

**Acceptance criteria:**

- `PUT` em URL pré-assinada de `UploadPart` com exatamente `ContentLength` bytes retorna `200` com header `ETag`
- `CompleteMultipartUpload` com as partes vindas do `ListParts` cria o objeto, e `HeadObject` retorna `ContentLength` = 5 MiB + 1 KiB
- `PUT` de parte com corpo de tamanho diferente do `ContentLength` assinado é rejeitado pelo storage (status 4xx)
- Resposta a `PUT` com header `Origin` permitido traz `Access-Control-Expose-Headers` contendo `ETag`
- `GET` pré-assinado com `Range: bytes=0-99` retorna `206`, `Content-Range: bytes 0-99/{total}` e 100 bytes de corpo

---

### SI-03.4 — Criar StorageModule com clients S3 interno e público

**Description:** Encapsula todo acesso ao object storage em um `StorageService` com dois `S3Client` (operações internas e assinatura voltada ao navegador), usado pela API e pelo worker.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois providers por token — `S3_CLIENT` (`endpoint: S3_ENDPOINT`) e `S3_PUBLIC_CLIENT` (`endpoint: S3_PUBLIC_ENDPOINT`) — ambos com `region`, `credentials`, `forcePathStyle` e `requestChecksumCalculation: 'WHEN_REQUIRED'`, construídos via `inject: [storageConfig.KEY]`; exportar `StorageService` (per `phase-03-videos/TD-04`, library-refs `@aws-sdk/client-s3`)
2. Criar `src/storage/storage.service.ts` com operações sobre o bucket `S3_BUCKET`: `createMultipartUpload(key, contentType)`, `listParts(key, uploadId, pageSize?)` (segue `NextPartNumberMarker` até o fim), `completeMultipartUpload(key, uploadId, parts)`, `abortMultipartUpload(key, uploadId)` (ignora `NoSuchUpload`), `headObject(key)`, `putObject(key, body, contentType)`, `deletePrefix(prefix)` (`ListObjectsV2` + `DeleteObjects`) (per `phase-03-videos/TD-03`, `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-07`)
3. Adicionar ao `StorageService` os métodos de assinatura: `presignUploadPart(key, uploadId, partNumber, contentLength, expiresIn)` e `presignGetObject(key, { expiresIn, downloadFilename? })` com o client **público**; `presignInternalGetObject(key, expiresIn)` com o client **interno** (worker/ffprobe). `expiresIn` sempre explícito (per `phase-03-videos/TD-04`, `phase-03-videos/TD-09`, `phase-03-videos/TD-11`, library-refs `@aws-sdk/s3-request-presigner`)
4. Criar `src/storage/storage-keys.ts` com `videoOriginalKey(id)` → `videos/{id}/original`, `videoThumbnailKey(id)` → `videos/{id}/thumbnail.jpg` e `videoPrefix(id)` → `videos/{id}/` (per `phase-03-videos/TD-03`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test (providers `S3_CLIENT`, `S3_PUBLIC_CLIENT`, `StorageService` resolvem) | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: RustFS real — multipart create/list/complete/abort, `headObject`, `putObject`, `deletePrefix` remove só o prefixo alvo; URL de `presignUploadPart` usa o host de `S3_PUBLIC_ENDPOINT` e `presignInternalGetObject` o de `S3_ENDPOINT` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.3 — o spike confirma que o servidor suporta as operações encapsuladas aqui

**Acceptance criteria:**

- `deletePrefix('videos/{id}/')` remove todos os objetos daquele prefixo e mantém intactos os objetos de outro prefixo `videos/{outro-id}/`
- `abortMultipartUpload` sobre um `uploadId` já abortado conclui sem erro
- URL retornada por `presignUploadPart` tem host igual ao de `S3_PUBLIC_ENDPOINT` e contém `partNumber` e `uploadId` na query string
- URL retornada por `presignGetObject` com `downloadFilename` contém `response-content-disposition=attachment` na query string
- `listParts` sobre um upload com 3 partes enviadas retorna as 3, com `PartNumber` e `Size`, mesmo quando a página é limitada a 2 (`MaxParts: 2`)

---

### SI-03.5 — Criar entidade Video, migration e gerador de public_id

**Description:** Persiste o vídeo com o ciclo de status, os metadados e o `public_id` curto e único, conforme `### Data Model → Video`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`@Entity('videos')`) com todas as colunas de `### Data Model → Video` — incluindo o enum `VideoStatus` (`draft | processing | ready | failed`, default `draft`), `failure_reason` (`varchar(50)`, nullable) com o tipo `VideoFailureReason` (`invalid_media | processing_failed | upload_abandoned | upload_size_mismatch`), transformer `bigint → number` em `declared_size_bytes` / `size_bytes`, `@ManyToOne(() => Channel)` com `@JoinColumn({ name: 'channel_id' })` e os índices `(public_id)` único, `(channel_id)`, `(status, created_at)`, `(status, updated_at)` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-09`, `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
2. Adicionar o lado inverso `@OneToMany(() => Video, (video) => video.channel) videos: Video[]` em `src/channels/entities/channel.entity.ts`
3. Gerar a migration `src/database/migrations/{timestamp}-CreateVideos.ts` via CLI, revisar o SQL (enum `videos_status_enum`, FK `ON DELETE NO ACTION`, índices) e garantir o `down()` reverso (per `phase-01-configuracao-base/TD-04`)
4. Criar `src/videos/public-id.util.ts` — `generatePublicId()` com `crypto.randomBytes(8)` → base64url truncado em 11 chars, e `isValidPublicId()` (`/^[A-Za-z0-9_-]{11}$/`) (per `phase-03-videos/TD-10`)
5. Atualizar os helpers de teste para incluir `Video`: listas `ALL_ENTITIES` dos testes de entidade existentes; `cleanAllTables` de `src/test/create-test-data-source.ts` (FK para `channels` exige limpar `videos` primeiro); e, em `src/database/migrations.integration-spec.ts`, `'videos'` em `MANAGED_TABLES` e `'videos_status_enum'` em `MANAGED_ENUM_TYPES`, para o teste de migrations continuar reexecutável (o `beforeAll` derruba tabela e tipo antes de rodar as migrations)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: default `status = 'draft'`, `failure_reason`/metadados `null` por default, `public_id` único, FK `channel_id` obrigatória, `size_bytes` de 10 GiB volta como `number`, enum rejeita valor fora da lista | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` / `isValidPublicId` | Unit: 11 chars no alfabeto base64url; validação rejeita tamanho e caracteres inválidos | `src/videos/public-id.util.spec.ts` |
| Migration `CreateVideos` | Integration: `up` + `down` aplicam e revertem sem erro; tabela `videos` presente na lista de tabelas criadas; suíte passa em duas execuções seguidas | `src/database/migrations.integration-spec.ts` |

**Dependencies:** none — depende apenas das entidades da Fase 02

**Acceptance criteria:**

- Inserir um vídeo só com `public_id`, `channel_id`, `title`, `original_filename`, `content_type` e `declared_size_bytes` persiste `status = 'draft'` e `failure_reason`, `upload_id`, `size_bytes` e todos os metadados como `null`
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade
- Inserir um vídeo com `channel_id` inexistente falha com violação de FK
- `declared_size_bytes = 10737418240` é lido de volta como o número `10737418240`
- `npm run migration:run` seguido de `migration:revert` (no container) deixa o schema como antes, sem a tabela `videos` nem o tipo `videos_status_enum`
- 10 000 chamadas a `generatePublicId()` produzem apenas strings que satisfazem `isValidPublicId()`
- `src/database/migrations.integration-spec.ts` passa duas vezes seguidas no mesmo banco (sem erro de "type `videos_status_enum` already exists")

---

### SI-03.6 — Configurar a fila BullMQ e o produtor de process-video

**Description:** Conecta o Nest ao Redis via `@nestjs/bullmq` em um módulo compartilhado (API e worker) e cria o produtor idempotente do job `process-video`, conforme `### Events/Messages`.

**Technical actions:**

1. Criar `src/queue/queue.constants.ts` com `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `VIDEO_MAINTENANCE_QUEUE = 'video-maintenance'`, `PROCESS_VIDEO_JOB = 'process-video'`, `CLEANUP_ABANDONED_UPLOADS_JOB = 'cleanup-abandoned-uploads'` e `PROCESS_VIDEO_JOB_OPTIONS` (`attempts: 3`, `backoff: { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail: { age: 604800 }`) (per `phase-03-videos/TD-13`)
2. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ inject: [redisConfig.KEY, queueConfig.KEY], useFactory: (redis, queue) => ({ connection: { host: redis.host, port: redis.port }, prefix: queue.prefix }) })` — o `prefix` vale para todas as filas e workers registrados, importado depois por `AppModule` e `WorkerModule` (per `phase-03-videos/TD-01`, library-refs `@nestjs/bullmq`)
3. Criar `src/videos/video-processing.producer.ts` — `enqueue(videoId)` faz `queue.add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: videoId })` com `@InjectQueue(VIDEO_PROCESSING_QUEUE)` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-13`)
4. Isolar os testes: criar `src/test/jest-env.setup.ts` que força `process.env.QUEUE_PREFIX = 'test'` e incluí-lo em `setupFiles` da config Jest de `package.json` (unit/integration) e de `test/jest-e2e.json` (e2e), junto de `dotenv/config`; as suítes de fila limpam as filas com prefixo `test` (`queue.obliterate({ force: true })`) no `afterAll`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test com `redisConfig` de teste | `src/queue/queue.module.spec.ts` |
| `VideoProcessingProducer` | Integration: Redis real — job aparece em `waiting` com `data = { videoId }`, `id = videoId` e as opções de retry; segunda chamada com o mesmo id não cria outro job | `src/videos/video-processing.producer.integration-spec.ts` |
| `QueueModule` (prefixo) | Integration: Redis real — job enfileirado com prefixo `test` gera chaves `test:video-processing:*` e não é entregue a um `Worker` BullMQ criado no teste com prefixo `bull` na mesma fila | `src/queue/queue-prefix.integration-spec.ts` |

**Dependencies:** SI-03.2 — Redis e `redisConfig` precisam existir

**Acceptance criteria:**

- `enqueue(id)` cria na fila `video-processing` um job `process-video` com `id = id`, `data = { videoId: id }`, `attempts = 3` e backoff exponencial
- Duas chamadas a `enqueue(id)` com o mesmo `id` deixam exatamente um job na fila
- O job lido por `queue.getJob(id)` traz `opts.removeOnComplete = true` e `opts.removeOnFail.age = 604800` (registro de falha mantido por 7 dias)
- Rodando a suíte de testes, os jobs criados pelos testes ficam sob chaves `test:*` e nenhum deles aparece em `bull:video-processing:*`
- Um job enfileirado com o prefixo `test` continua em `waiting` enquanto um worker com prefixo `bull` escuta a mesma fila (não é consumido)

---

### SI-03.7 — Endpoint POST /videos (início do upload + pré-cadastro como rascunho)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (per `### Authorization Matrix`)

**Description:** Cria o `VideosModule` e o endpoint que, numa única chamada, pré-cadastra o vídeo como rascunho no canal do usuário e abre o multipart upload no storage, conforme `### API Contracts → POST /videos`.

**Technical actions:**

1. Criar `src/videos/videos.module.ts` (`TypeOrmModule.forFeature([Video])`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, imports `StorageModule` + `ChannelsModule`, providers `VideosService` + `VideoProcessingProducer`) e registrar `QueueModule` + `VideosModule` em `AppModule`; adicionar `ChannelsService.findByUserId(userId)` (exportado) para o lookup do canal — a entidade `Channel` continua com seu dono (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
2. Criar `src/videos/videos.exceptions.ts` com as subclasses de `DomainException` de `### Error Catalog`: `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `VideoUploadNotActiveException` (`VIDEO_UPLOAD_NOT_ACTIVE`, 409), `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400), `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 409), `UploadSizeMismatchException` (`UPLOAD_SIZE_MISMATCH`, 422), `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) (per `phase-02-auth/TD-07`)
3. Criar DTOs em `src/videos/dto/`: `InitiateUploadDto` (`filename`, `size_bytes`, `content_type` com as regras de `#### Validation Rules — Videos`), `VideoResponseDto` + função `toVideoResponse(video)` (campos de `VideoResponse`, incluindo `failure_reason`, sem campos internos) e `InitiateUploadResponseDto` (`VideoResponse` + `upload: { part_size, part_count }`) (per `phase-02-auth/TD-06`)
4. Implementar `VideosService.initiateUpload(userId, dto)`: busca o canal, gera `id` (`randomUUID()`), `title` = filename sem a última extensão, calcula `part_count = ceil(size_bytes / UPLOAD_PART_SIZE_BYTES)`, chama `storage.createMultipartUpload(videoOriginalKey(id), content_type)`, insere a linha (`status = 'draft'`, `upload_id`, `declared_size_bytes`) repetindo com novo `public_id` em violação de unicidade (mesmo padrão de `ChannelsService`); se o insert falhar de vez, aborta o multipart (per `phase-03-videos/TD-05`, `phase-03-videos/TD-10`, `phase-03-videos/TD-12`)
5. Criar `src/videos/videos.controller.ts` (`@Controller('videos')`, `@SkipThrottle()`) com `POST /videos` → `201`, `@CurrentUser()` como dono, decorators `@ApiOperation` / `@ApiResponse` (201, 400, 401 com `ApiErrorEnvelope`) e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`, `phase-02-auth/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: derivação de `title` (`a.b.mp4` → `a.b`, sem extensão → nome inteiro), cálculo de `part_count` (exato e com resto), nova tentativa de `public_id` em violação de unicidade, abort do multipart quando o insert falha | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: Postgres + RustFS reais — linha `draft` com `channel_id` do usuário e `upload_id` igual ao de um multipart existente no storage | `src/videos/videos.service.integration-spec.ts` |
| `ChannelsService.findByUserId` | Integration: retorna o canal do usuário; `null` para usuário sem canal | `src/channels/channels.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4 — `StorageService`; SI-03.5 — entidade `Video`; SI-03.6 — `QueueModule` e produtor registrados no módulo

**Acceptance criteria:**

- `POST /videos` com `{ filename: "Minha viagem.mp4", size_bytes: 150000000, content_type: "video/mp4" }` retorna `201` com `status: "draft"`, `title: "Minha viagem"`, `description: null`, `failure_reason: null`, `public_id` de 11 chars e `upload: { part_size: 67108864, part_count: 3 }`
- O vídeo criado pertence ao canal do usuário autenticado (`channel_id` = canal cujo `user_id` é o `sub` do token)
- `POST /videos` com `size_bytes: 10737418241` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` com `content_type: "image/png"` retorna `400` com `error: "VALIDATION_ERROR"`
- `POST /videos` sem `Authorization` retorna `401`
- A resposta não contém `id`, `channel_id`, `upload_id`, `declared_size_bytes` nem `thumbnail_key`
- Onze `POST /videos` seguidos do mesmo usuário em menos de 1 minuto retornam todos `201` (endpoint fora do throttler de auth)

---

### SI-03.8 — Endpoints de URLs de parte e retomada (POST part-urls, GET upload/parts)

**Route:** POST /videos/:publicId/upload/part-urls, GET /videos/:publicId/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Entrega ao navegador URLs pré-assinadas por parte (assinadas para o storage público, com `Content-Length` fixado) e a lista de partes já enviadas para retomar um upload, conforme `### API Contracts`.

**Technical actions:**

1. Implementar `VideosService.findOwnedByPublicId(userId, publicId)`: `publicId` fora de `isValidPublicId()` ou vídeo cujo canal não pertence a `userId` → `VideoNotFoundException` (mesma resposta para inexistente e de outro dono) (per `phase-03-videos/TD-11` revision)
2. Criar `src/videos/upload-parts.util.ts` com `partCount(size, partSize)` e `partContentLength(partNumber, size, partSize)` (última parte = resto) e usá-los também em `initiateUpload` (per `phase-03-videos/TD-05`)
3. Implementar `VideosService.issuePartUrls(userId, publicId, partNumbers)`: exige `status = 'draft'` (`VideoUploadNotActiveException`), rejeita número > `part_count` (`InvalidPartNumberException`), chama `storage.presignUploadPart(key, upload_id, n, partContentLength(...), 3600)` para cada parte; e `VideosService.listUploadedParts(userId, publicId)`: exige `draft`, mapeia `storage.listParts` para `{ part_number, size }` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`)
4. Criar `PartUrlsDto` (`part_numbers`: `@IsArray`, `@ArrayMinSize(1)`, `@ArrayMaxSize(100)`, `@ArrayUnique`, `@IsInt({ each: true })`, `@Min(1, { each: true })`) e os DTOs de resposta `PartUrlsResponseDto` (`parts[]`, `expires_in`) e `UploadedPartsResponseDto` (`part_size`, `part_count`, `uploaded_parts[]`) (per `phase-02-auth/TD-06`)
5. Adicionar as duas rotas ao `VideosController` (`POST` → `200` via `@HttpCode(HttpStatus.OK)`, `GET` → `200`) com `@ApiOperation` / `@ApiResponse` (200, 400, 401, 404, 409) e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `partCount` / `partContentLength` | Unit: tamanho múltiplo exato da parte, com resto, arquivo menor que uma parte | `src/videos/upload-parts.util.spec.ts` |
| `VideosService.issuePartUrls` / `listUploadedParts` / `findOwnedByPublicId` | Unit: ramos `VIDEO_NOT_FOUND` (outro dono, id malformado), `VIDEO_UPLOAD_NOT_ACTIVE`, `INVALID_PART_NUMBER`, `content_length` da última parte | `src/videos/videos.service.spec.ts` |
| `VideosService.listUploadedParts` | Integration: Postgres + RustFS — após enviar 1 de 2 partes pela URL emitida, retorna só aquela parte com o `size` correto | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.7 — `VideosModule`, `VideosController` e vídeos em `draft`

**Acceptance criteria:**

- `POST /videos/{publicId}/upload/part-urls` com `{ part_numbers: [1, 2] }` pelo dono de um rascunho retorna `200` com 2 itens, cada um com `url` no host de `S3_PUBLIC_ENDPOINT`, `content_length` correto e `expires_in: 3600`
- `PUT` do número exato de bytes na `url` emitida retorna `200` do storage; `GET /videos/{publicId}/upload/parts` passa então a listar aquela parte
- `part-urls` com uma parte maior que `part_count` retorna `400` com `error: "INVALID_PART_NUMBER"`
- `part-urls` com 101 números ou números repetidos retorna `400` com `error: "VALIDATION_ERROR"`
- Os dois endpoints chamados por outro usuário autenticado, ou com `publicId` inexistente, retornam `404` com `error: "VIDEO_NOT_FOUND"`
- Os dois endpoints sobre um vídeo em `processing` retornam `409` com `error: "VIDEO_UPLOAD_NOT_ACTIVE"`

---

### SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)

**Route:** POST /videos/:publicId/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Conclui o multipart a partir do `ListParts` da própria API, valida o tamanho com `HeadObject`, move `draft → processing` e enfileira o processamento de forma idempotente, conforme `### API Contracts → POST /videos/:publicId/upload/complete`.

**Technical actions:**

1. Implementar `VideosService.completeUpload(userId, publicId)` — ramos por status: `processing` → `producer.enqueue(id)` (no-op se o job existe) e retorna o vídeo; `ready` / `failed` → `VideoUploadNotActiveException`; `draft` → segue o fluxo abaixo (per `phase-03-videos/TD-06`, `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
2. Fluxo `draft`: `storage.listParts`; faltando qualquer parte `1..part_count` → `UploadIncompleteException`; senão `completeMultipartUpload` com `PartNumber` + `ETag` vindos do `ListParts` (nunca do cliente). Se `ListParts` responder `NoSuchUpload` e o objeto `videos/{id}/original` já existir (repetição após um complete anterior que não chegou a gravar no banco), seguir direto para o passo 3 (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
3. `storage.headObject(videoOriginalKey(id))`: se `ContentLength ≠ declared_size_bytes` → update condicional `WHERE id = :id AND status = 'draft'` com `status = 'failed'`, `failure_reason = 'upload_size_mismatch'`, `upload_id = null`; `storage.deletePrefix(videoPrefix(id))`; lança `UploadSizeMismatchException` (linha mantida) (per `phase-03-videos/TD-05` passo 3)
4. Tamanho ok: update condicional `WHERE id = :id AND status = 'draft'` com `status = 'processing'`, `size_bytes = ContentLength`, `upload_id = null`; 0 linhas afetadas (complete concorrente) → recarrega e segue o ramo `processing`; depois `producer.enqueue(id)` — falha no enqueue é logada e a resposta continua `200`, pois o job de manutenção reenfileira vídeos presos em `processing` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`)
5. Adicionar a rota `POST /videos/:publicId/upload/complete` (`200`) ao `VideosController` com `@ApiOperation` / `@ApiResponse` (200, 401, 404, 409, 422) e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: ramos `processing` (reenfileira), `ready`/`failed` (409), parte faltando (`UPLOAD_INCOMPLETE`), tamanho divergente (marca `failed` + apaga prefixo + 422), `NoSuchUpload` com objeto existente, update condicional com 0 linhas, falha de enqueue não derruba a resposta | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: Postgres + RustFS + Redis reais — partes enviadas pelas URLs emitidas → objeto completo no storage, linha `processing` com `size_bytes`, job `process-video` com `id = video.id`; `declared_size_bytes` adulterado → linha `failed` / `upload_size_mismatch` e prefixo vazio | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — URLs de parte e `findOwnedByPublicId`; SI-03.6 — `VideoProcessingProducer`

**Acceptance criteria:**

- Com todas as partes enviadas, `POST /videos/{publicId}/upload/complete` retorna `200` com `status: "processing"` e `size_bytes` igual ao tamanho declarado, e a fila `video-processing` passa a ter um job `process-video` com `id` igual ao id interno do vídeo
- Repetir o `complete` sobre o mesmo vídeo retorna `200` com `status: "processing"` e a fila continua com um único job para ele
- `complete` com uma parte faltando retorna `409` com `error: "UPLOAD_INCOMPLETE"` e o vídeo continua `draft`
- `complete` cujo objeto final tem tamanho diferente do declarado retorna `422` com `error: "UPLOAD_SIZE_MISMATCH"`; depois disso a linha do vídeo continua existindo com `status = 'failed'` e `failure_reason = 'upload_size_mismatch'`, e não há objetos sob `videos/{id}/`
- `complete` sobre vídeo `ready` ou `failed` retorna `409` com `error: "VIDEO_UPLOAD_NOT_ACTIVE"`
- `complete` por outro usuário retorna `404` com `error: "VIDEO_NOT_FOUND"`

---

### SI-03.10 — Infra: Entrypoint do worker, WorkerModule e serviço video-worker no Compose

**Description:** Cria o segundo entrypoint do mesmo código (`WorkerModule`), isolado em seu próprio serviço do Compose que já roda o worker no `docker compose up` (o processamento após o upload não exige passo manual), e instala `ffmpeg`/`ffprobe` na imagem — sem ainda nenhum processor.

**Technical actions:**

1. Em `nestjs-project/Dockerfile.dev`, instalar `ffmpeg` via `apt install -y ffmpeg` (pacote Debian, versionado com a imagem base); a imagem é a mesma de `nestjs-api` e `video-worker`, então os testes de integração rodados em `nestjs-api` também têm os binários (per `phase-03-videos/TD-09`)
2. Extrair as opções de `ConfigModule.forRoot` e a factory de `TypeOrmModule.forRootAsync` de `AppModule` para `src/config/config-module.options.ts` e `src/database/typeorm-options.factory.ts`, reutilizadas por `AppModule` e `WorkerModule` sem duplicação (per `phase-01-configuracao-base/TD-01`, Inherited Conventions — `databaseConfig` único)
3. Criar `src/video-processing/video-processing.module.ts` (`TypeOrmModule.forFeature([Video])`, `BullModule.registerQueue` de `VIDEO_PROCESSING_QUEUE` e `VIDEO_MAINTENANCE_QUEUE`, import `StorageModule`) e `src/worker/worker.module.ts` (config + TypeORM + `QueueModule` + `VideoProcessingModule`); `AppModule` **não** importa `VideoProcessingModule` (per `phase-03-videos/TD-08`)
4. Criar `src/worker.ts` — `NestFactory.createApplicationContext(WorkerModule)` + `app.enableShutdownHooks()` (fechamento gracioso dos workers BullMQ evita reentrega por job travado) — e scripts `start:worker:dev` (`nest start --watch --entryFile worker`) e `start:worker:prod` (`node dist/worker`) em `package.json` (per `phase-03-videos/TD-08`, library-refs `bullmq`)
5. Adicionar o serviço `video-worker` em `compose.yaml` (mesmo `build` e volume de `nestjs-api`, `command: npm run start:worker:dev`, `restart: unless-stopped`, `depends_on` `db: service_healthy` / `redis: service_healthy` / `storage-init: service_completed_successfully`, sem portas); `nestjs-api` mantém o `CMD` ocioso. Atualizar `nestjs-project/CLAUDE.md`: o `video-worker` é a exceção à regra "não subir a aplicação ao iniciar o ambiente" — roda no `up`, logs em `docker compose logs video-worker`; dependências precisam estar instaladas (`docker compose exec nestjs-api npm install`) antes do primeiro `up`, senão o serviço reinicia em loop; verificações de prontidão de `redis` (`redis-cli ping`) e `storage-init` (exit code `0`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test (config, TypeORM, fila e `VideoProcessingModule` resolvem) | `src/worker/worker.module.spec.ts` |
| `VideoProcessingModule` | Unit: compilation test | `src/video-processing/video-processing.module.spec.ts` |

**Dependencies:** SI-03.6 — `QueueModule`; SI-03.4 — `StorageModule`; SI-03.5 — entidade `Video`

**Acceptance criteria:**

- `docker compose exec nestjs-api ffprobe -version` e `docker compose exec video-worker ffmpeg -version` imprimem a versão sem erro
- `docker compose up -d` deixa `video-worker` em `running` com o processo do worker já iniciado: `docker compose logs video-worker` mostra o contexto Nest inicializado, sem abrir porta HTTP
- `docker compose up -d` mantém `nestjs-api` ocioso (nenhum processo Node da API iniciado)
- Matar o processo Node dentro de `video-worker` faz o container reiniciar sozinho (`restart: unless-stopped`) e o worker volta a subir
- `docker compose stop video-worker` encerra o worker de forma limpa (sem stack trace no log)
- Com o `video-worker` rodando, um job enfileirado na fila `video-processing` com `QUEUE_PREFIX=test` continua em `waiting` (não é consumido pelo worker, que usa o prefixo `bull`)
- A API (`AppModule`) continua subindo e respondendo `GET /` com `200`, sem registrar nenhum processor de fila

---

### SI-03.11 — Processar vídeo no worker (ffprobe, thumbnail, status e falhas)

**Description:** Implementa o consumidor de `process-video`: extrai os metadados via `ffprobe` e um frame via `ffmpeg` lendo o original por HTTP `Range`, grava a thumbnail no storage e fecha o ciclo `processing → ready | failed`, conforme `### Events/Messages → video-processing`. Como não há endpoint de thumbnail nesta fase, a prova da thumbnail fica nos testes deste SI.

**Technical actions:**

1. Criar `src/video-processing/media-probe.service.ts` — `probe(url)` faz `spawn('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url])` (sem shell) e uma função pura `parseProbeOutput(json)` que devolve `duration_seconds`, `width`, `height`, `mime_type` (`format.format_name`), `video_codec`, `audio_codec` (`null` sem stream de áudio), `bitrate` (`format.bit_rate`) e `frame_rate` (fração `avg_frame_rate` → número); sem stream de vídeo → `InvalidMediaError` (per `phase-03-videos/TD-09`)
2. Criar `src/video-processing/thumbnail-extractor.service.ts` — `extractFrame(url, atSeconds)` faz `spawn('ffmpeg', ['-ss', at, '-i', url, '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'])` e devolve o `Buffer`; o chamador usa `at = 10 %` da duração e repete com `0` quando a saída vem vazia (clipes muito curtos) (per `phase-03-videos/TD-09`)
3. Criar `src/video-processing/video-processing.processor.ts` (`@Processor(VIDEO_PROCESSING_QUEUE)`, `extends WorkerHost`) — `process(job)`: carrega a linha e retorna sem fazer nada se `status ≠ 'processing'`; `storage.presignInternalGetObject(videoOriginalKey(id), 3600)`; `probe`; `InvalidMediaError` → `throw new UnrecoverableError(...)`; `extractFrame`; `storage.putObject(videoThumbnailKey(id), buffer, 'image/jpeg')`; update condicional `WHERE id = :id AND status = 'processing'` com os metadados, `thumbnail_key` e `status = 'ready'`; outros erros são relançados para o BullMQ tentar de novo (per `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-09`, `phase-03-videos/TD-13`, library-refs `bullmq`)
4. No mesmo processor, `@OnWorkerEvent('failed') onFailed(job, error)`: `UnrecoverableError` → `failure_reason = 'invalid_media'`; `job.attemptsMade >= job.opts.attempts` → `failure_reason = 'processing_failed'`; em ambos, update condicional `WHERE status = 'processing'` para `status = 'failed'`; falhas intermediárias não alteram a linha (per `phase-03-videos/TD-13`, library-refs `@nestjs/bullmq`)
5. Criar `src/test/video-fixtures.ts` — gera em diretório temporário, com `ffmpeg -f lavfi` (`testsrc` + `sine`), um MP4 de 2 s com áudio, um MP4 de 0,2 s sem áudio e um arquivo de texto renomeado para `.mp4` (mídia inválida), usados pelos testes deste SI e do SI-03.15; registrar `VideoProcessingProcessor`, `MediaProbeService` e `ThumbnailExtractorService` em `VideoProcessingModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `parseProbeOutput` | Unit: JSON de ffprobe com e sem áudio, `avg_frame_rate` fracionário (`30000/1001`), sem stream de vídeo → `InvalidMediaError` | `src/video-processing/media-probe.service.spec.ts` |
| `MediaProbeService` / `ThumbnailExtractorService` | Integration: binários reais sobre URL pré-assinada de fixture no RustFS — metadados do MP4 de 2 s; JPEG não vazio; fallback para o frame 0 no clipe de 0,2 s | `src/video-processing/media-tools.integration-spec.ts` |
| `VideoProcessingProcessor.process` | Integration: Postgres + RustFS reais, `process(job)` chamado direto — linha `ready` com metadados e `thumbnail_key = videos/{id}/thumbnail.jpg`; `HeadObject` da thumbnail com `ContentType: image/jpeg` e corpo iniciando em `FF D8`; mídia inválida lança `UnrecoverableError` e não grava thumbnail; reentrega sobre linha `ready` não altera nada | `src/video-processing/video-processing.processor.integration-spec.ts` |
| `VideoProcessingProcessor.onFailed` | Unit: `UnrecoverableError` → `invalid_media`; última tentativa → `processing_failed`; tentativa intermediária → sem update | `src/video-processing/video-processing.processor.spec.ts` |

**Dependencies:** SI-03.10 — `VideoProcessingModule` e `ffmpeg` na imagem; SI-03.9 — vídeos chegam a `processing` com o objeto original completo

**Acceptance criteria:**

- Processar um vídeo `processing` cujo original é o MP4 de 2 s com áudio deixa a linha com `status = 'ready'`, `duration_seconds ≈ 2`, `width`/`height` do fixture, `video_codec = 'h264'`, `audio_codec` não nulo, `bitrate` e `frame_rate` preenchidos e `failure_reason = null`
- Após esse processamento, `thumbnail_key = 'videos/{id}/thumbnail.jpg'` e o storage tem esse objeto com `ContentType: image/jpeg` e conteúdo JPEG válido (começa em `FF D8`)
- Processar o MP4 de 0,2 s sem áudio resulta em `ready`, `audio_codec = null` e thumbnail gravada (fallback para o primeiro frame)
- Processar o arquivo inválido termina com `status = 'failed'` e `failure_reason = 'invalid_media'` sem consumir novas tentativas e sem objeto de thumbnail
- Um erro temporário em todas as 3 tentativas termina com `status = 'failed'` e `failure_reason = 'processing_failed'`; um erro só na 1ª tentativa termina em `ready`
- Reprocessar (reentrega) um vídeo já `ready` não altera a linha nem a thumbnail

---

### SI-03.12 — Job agendado de manutenção (rascunhos abandonados + vídeos presos em processing)

**Description:** Implementa o job `cleanup-abandoned-uploads` da fila `video-maintenance`, que marca rascunhos abandonados como falhos liberando seu storage e recupera vídeos presos em `processing`, conforme `### Events/Messages → video-maintenance`.

**Technical actions:**

1. Criar `src/video-processing/maintenance-scheduler.service.ts` — em `onApplicationBootstrap`, `maintenanceQueue.upsertJobScheduler('cleanup-abandoned-uploads', { every: 3600000 }, { name: CLEANUP_ABANDONED_UPLOADS_JOB })` (idempotente por id, seguro em todo boot do worker) (per `phase-03-videos/TD-07`, library-refs `bullmq`)
2. Criar `src/video-processing/abandoned-uploads-cleanup.service.ts` — `cleanupAbandonedDrafts(now)`: seleciona `status = 'draft'` com `created_at < now - UPLOAD_ABANDON_AFTER_HOURS`; para cada um, update condicional `WHERE id = :id AND status = 'draft'` para `status = 'failed'`, `failure_reason = 'upload_abandoned'`, `upload_id = null` (0 linhas → pula); depois `abortMultipartUpload` com o `upload_id` lido antes (se havia) e `deletePrefix(videoPrefix(id))`; a linha é mantida (per `phase-03-videos/TD-07`, `phase-03-videos/TD-12`)
3. Criar `src/video-processing/stuck-processing-recovery.service.ts` — `recoverStuckProcessing(now)`: seleciona `status = 'processing'` com `updated_at < now - PROCESSING_STUCK_AFTER_MINUTES`; para cada um, `processingQueue.getJob(id)`: sem job → `add(PROCESS_VIDEO_JOB, { videoId }, { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: id })`; job `failed` → update condicional `WHERE status = 'processing'` para `failed` / `processing_failed` (um novo `add` seria ignorado porque `removeOnFail` mantém o job por 7 dias); `waiting` / `active` / `delayed` → não faz nada (per `phase-03-videos/TD-13`)
4. Criar `src/video-processing/maintenance.processor.ts` (`@Processor(VIDEO_MAINTENANCE_QUEUE)`, `extends WorkerHost`) cujo `process(job)` chama `cleanupAbandonedDrafts(new Date())` e `recoverStuckProcessing(new Date())`, logando as contagens; registrar os três serviços e o processor em `VideoProcessingModule` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `AbandonedUploadsCleanupService` | Integration: Postgres + RustFS — rascunho antigo com 1 parte enviada vira `failed`/`upload_abandoned`, `upload_id = null`, multipart abortado e prefixo vazio, linha mantida; rascunho recente e vídeo `processing` antigo intactos | `src/video-processing/abandoned-uploads-cleanup.service.integration-spec.ts` |
| `StuckProcessingRecoveryService` | Unit: ramos sem job / `failed` / `waiting` / `active` (fila e repositório mockados) | `src/video-processing/stuck-processing-recovery.service.spec.ts` |
| `StuckProcessingRecoveryService` | Integration: Postgres + Redis — vídeo preso sem job ganha job com `id = video.id`; com job `failed` vira `failed`/`processing_failed`; com job `waiting` fica intacto; vídeo `processing` recente é ignorado | `src/video-processing/stuck-processing-recovery.service.integration-spec.ts` |
| `MaintenanceSchedulerService` | Integration: Redis — após dois bootstraps existe exatamente um job scheduler `cleanup-abandoned-uploads` com `every = 3600000` | `src/video-processing/maintenance-scheduler.service.integration-spec.ts` |

**Dependencies:** SI-03.11 — `VideoProcessingModule` com o processor de `process-video` (o caminho `failed` depende da retenção de falhas configurada no SI-03.6)

**Acceptance criteria:**

- Um rascunho criado há mais de `UPLOAD_ABANDON_AFTER_HOURS` horas termina com `status = 'failed'`, `failure_reason = 'upload_abandoned'` e `upload_id = null`; `ListParts` do seu antigo `UploadId` retorna `NoSuchUpload` e não há objetos sob `videos/{id}/`
- A linha do rascunho abandonado continua existindo na tabela `videos`
- Um rascunho criado há menos do limite não é alterado
- Um vídeo em `processing` há mais de `PROCESSING_STUCK_AFTER_MINUTES` minutos sem job na fila ganha um job `process-video` com `id` igual ao seu id interno
- Um vídeo em `processing` há mais do limite cujo job está `failed` termina com `status = 'failed'` e `failure_reason = 'processing_failed'`
- Um vídeo em `processing` com job `waiting` ou `active` não é alterado e nenhum job novo é criado
- Iniciar o worker duas vezes deixa um único job scheduler `cleanup-abandoned-uploads` na fila `video-maintenance`

---

### SI-03.13 — Endpoint GET /videos/:publicId (status e metadados para o dono)

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Permite ao dono acompanhar o processamento e ler os metadados extraídos, conforme `### API Contracts → GET /videos/:publicId`.

**Technical actions:**

1. Implementar `VideosService.getOwnedVideo(userId, publicId)` reutilizando `findOwnedByPublicId` (404 único para inexistente, malformado ou de outro dono) (per `phase-03-videos/TD-11` revision)
2. Adicionar a rota `GET /videos/:publicId` (`200`, `toVideoResponse`) ao `VideosController`, com `@ApiOperation` / `@ApiResponse` (200, 401, 404) e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Integration: Postgres — retorna o vídeo do dono; outro dono e id inexistente → `VideoNotFoundException` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — `findOwnedByPublicId`; SI-03.7 — `toVideoResponse`

**Acceptance criteria:**

- `GET /videos/{publicId}` pelo dono de um vídeo `ready` retorna `200` com `status: "ready"`, metadados preenchidos e `failure_reason: null`
- `GET /videos/{publicId}` pelo dono de um vídeo `failed` retorna `200` com `status: "failed"` e o `failure_reason` gravado
- `GET /videos/{publicId}` por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`, igual ao de um `publicId` inexistente
- `GET /videos/{publicId}` sem `Authorization` retorna `401`
- A resposta não contém `id`, `channel_id`, `upload_id`, `declared_size_bytes` nem `thumbnail_key`

---

### SI-03.14 — Endpoints de streaming e download (302 para GET pré-assinado)

**Route:** GET /videos/:publicId/stream, GET /videos/:publicId/download
**Test Specs:** see `nestjs-project/specs/videos-playback.plan.md`
**Authorization:** Owner (per `### Authorization Matrix`)

**Description:** Checa acesso e redireciona para uma URL pré-assinada do storage, que serve `Range`/`206` sozinho — streaming e download sem bytes de vídeo passando pela API, conforme `### API Contracts`.

**Technical actions:**

1. Implementar `VideosService.getPlaybackUrl(userId, publicId, mode: 'stream' | 'download')`: `findOwnedByPublicId`; `status ≠ 'ready'` → `VideoNotReadyException`; `stream` → `storage.presignGetObject(videoOriginalKey(id), { expiresIn: 21600 })`; `download` → `presignGetObject(..., { expiresIn: 900, downloadFilename: original_filename })` com o nome escapado para o header `Content-Disposition` (aspas e caracteres não-ASCII via `filename*=UTF-8''...`) (per `phase-03-videos/TD-04`, `phase-03-videos/TD-11`)
2. Adicionar `GET /videos/:publicId/stream` e `GET /videos/:publicId/download` ao `VideosController` respondendo `302` com header `Location` (`res.redirect(302, url)` ou `@Redirect()` dinâmico) e `Cache-Control: no-store` (per `phase-03-videos/TD-11`)
3. Documentar as duas rotas com `@ApiOperation` / `@ApiResponse` (302 com header `Location`, 401, 404, 409) e regenerar `openapi.json` (per `openapi-docs-nestjs/TD-01`, `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: `VIDEO_NOT_READY` para `draft`/`processing`/`failed`; TTL 21600 vs 900; `downloadFilename` só no download; escape de nome com aspas e acentos | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl` | Integration: Postgres + RustFS — URL de stream com `Range: bytes=0-1023` retorna `206` e 1024 bytes do original; URL de download retorna `Content-Disposition: attachment` com o nome original | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.13 — `VideosController` com a leitura do dono; SI-03.11 — vídeos chegam a `ready`

**Acceptance criteria:**

- `GET /videos/{publicId}/stream` pelo dono de um vídeo `ready` retorna `302`, `Cache-Control: no-store` e `Location` no host de `S3_PUBLIC_ENDPOINT` com `X-Amz-Expires=21600`
- Seguir o `Location` do stream com `Range: bytes=0-1023` retorna `206` com 1024 bytes, sem chamada adicional à API
- `GET /videos/{publicId}/download` retorna `302` com `Location` contendo `X-Amz-Expires=900` e `response-content-disposition=attachment`; seguir a URL retorna o arquivo com `Content-Disposition: attachment; filename=...` do nome original
- Os dois endpoints sobre um vídeo `processing` retornam `409` com `error: "VIDEO_NOT_READY"`
- Os dois endpoints por outro usuário autenticado ou com `publicId` inexistente retornam `404` com `error: "VIDEO_NOT_FOUND"`
- Os dois endpoints sem `Authorization` retornam `401`

---

### SI-03.15 — Teste de fluxo completo: upload multipart direto ao storage até o vídeo pronto

**Description:** Prova, num único teste ponta a ponta do backend, que as partes do upload vão do cliente direto ao storage sem passar pela API, e que o vídeo é processado até `ready` com thumbnail gravada — cobrindo as entregas da fase (upload, processamento, streaming, URL única).

**Technical actions:**

1. Estender `src/test/video-fixtures.ts` com `generateMp4OfAtLeast(bytes)` (ffmpeg `testsrc2` em alta taxa de bits até passar do tamanho pedido) para gerar um MP4 válido > 10 MiB, que vira 3 partes com `UPLOAD_PART_SIZE_BYTES = 5242880` (per `phase-03-videos/TD-05`)
2. No setup de `test/videos-upload-flow.e2e-spec.ts`, sobrescrever `S3_PUBLIC_ENDPOINT=http://storage:9000` (a assinatura SigV4 fixa o host, e de dentro do container `localhost:9000` não alcança o storage) e `UPLOAD_PART_SIZE_BYTES=5242880`; reproduzir os globais de `main.ts` (`ValidationPipe`, filtros); instalar no app Express de teste um middleware que soma os bytes de corpo de **toda** requisição recebida pela API (per `phase-03-videos/TD-04`)
3. Fluxo: criar e confirmar usuário → login → `POST /videos` → `POST .../upload/part-urls` para `[1, 2, 3]` → `fetch` `PUT` de cada fatia **direto** em cada `url` (fora do supertest) → `POST .../upload/complete` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`)
4. Processamento: subir no teste um contexto de `WorkerModule` (`NestFactory.createApplicationContext`) apontando para o mesmo Redis/Postgres/RustFS e com o prefixo de fila `test` (o `video-worker` em execução, com prefixo `bull`, não disputa esses jobs), fazer polling de `GET /videos/{publicId}` até `ready` (timeout 60 s) e fechá-lo no `afterAll`; ao final, `HeadObject` em `videos/{id}/thumbnail.jpg` e `GET .../stream` seguido de `fetch` com `Range` (per `phase-03-videos/TD-08`, `phase-03-videos/TD-11`)
5. Ajustar `test/jest-e2e.json` (`testTimeout` suficiente para o fluxo) se necessário, mantendo `--runInBand`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Fluxo upload → complete → worker → stream | E2E: API real + worker em processo + Postgres/Redis/RustFS reais; contador de bytes recebidos pela API | `test/videos-upload-flow.e2e-spec.ts` |

**Dependencies:** SI-03.14 — todos os endpoints da fase; SI-03.12 — `WorkerModule` completo

**Acceptance criteria:**

- Todas as `url` de parte apontam para o host do storage, nunca para o host da API
- Ao final do upload de um arquivo > 10 MiB em 3 partes, o total de bytes de corpo recebidos pela API em todas as requisições do fluxo é menor que 10 KiB, enquanto `HeadObject` de `videos/{id}/original` retorna `ContentLength` igual ao tamanho do arquivo
- Depois do `complete`, `GET /videos/{publicId}` chega a `status: "ready"` com `duration_seconds` e `width`/`height` do fixture
- A linha do vídeo pronto tem `thumbnail_key = 'videos/{id}/thumbnail.jpg'` e o storage tem esse objeto com `ContentType: image/jpeg`
- `GET /videos/{publicId}/stream` do vídeo pronto retorna `302`, e a URL do `Location` responde a `Range: bytes=0-1023` com `206`
- Dois uploads seguidos no mesmo teste recebem `public_id` diferentes

---

### SI-03.16 — Documentação e Definition of Done da fase

**Description:** Alinha a documentação do repositório com o que a fase entregou (tecnologias de fila e storage, worker, endpoints de vídeo, serviços do Compose) e fecha a fase com a Definition of Done técnica.

**Technical actions:**

1. `CLAUDE.md` (raiz), seção Architecture: **Message Queue** = BullMQ + Redis (filas `video-processing` e `video-maintenance`); **Object Storage** = RustFS em dev, S3 em produção (bucket privado único, URLs pré-assinadas); **Video Worker** = segundo entrypoint do `nestjs-project` (`src/worker.ts`, `WorkerModule`), serviço `video-worker` do Compose, com FFmpeg/ffprobe (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`, `phase-03-videos/TD-08`)
2. `nestjs-project/CLAUDE.md`, nova seção de vídeos: endpoints de `/videos` (rotas, dono, códigos de erro principais); fila (filas, jobs `process-video` e `cleanup-abandoned-uploads`, `jobId = id`, 3 tentativas com backoff exponencial, `QUEUE_PREFIX` e o prefixo `test` dos testes); worker (entrypoint, comando, roda no `up`, `docker compose logs video-worker`); storage (bucket, chaves `videos/{id}/original` e `videos/{id}/thumbnail.jpg`, `storage-init`, `docker/storage/cors.json` com `ExposeHeaders: ETag`, `S3_PUBLIC_ENDPOINT` como exceção ao "nunca `localhost`"); e os serviços `redis`, `storage`, `storage-init`, `video-worker` nas seções de ambiente com suas verificações de prontidão (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-13`, `phase-03-videos/TD-14`)
3. `docs/diagrams/software-arch.mermaid`: `queue` passa de `"TBD"` para `"BullMQ + Redis"` e `storage` de `"S3 or MinIO"` para `"RustFS (dev) / S3 (prod)"`, mantendo as relações e os estilos existentes (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`)
4. Conferir que todo nome citado na documentação (arquivos, scripts npm, serviços do Compose, variáveis de ambiente, rotas, filas, jobs) existe no código — `grep` de cada identificador no `nestjs-project/`
5. Rodar a Definition of Done no container: suíte completa (`npm test -- --runInBand` e `npm run test:e2e`), `npx tsc --noEmit` e `npm run lint`

**Tests:** _(empty — documentação; a verificação é a Definition of Done da ação 5)_

**Dependencies:** SI-03.15 — a documentação descreve o comportamento já entregue e testado

**Acceptance criteria:**

- `CLAUDE.md` da raiz não contém mais `TBD` nem `MinIO` na descrição de fila e storage, e descreve o `video-worker`
- `nestjs-project/CLAUDE.md` lista todos os endpoints de `/videos` presentes em `openapi.json` e os serviços `redis`, `storage`, `storage-init` e `video-worker` presentes em `compose.yaml`
- Cada arquivo, script, serviço, variável de ambiente, fila e job citado em `CLAUDE.md`, `nestjs-project/CLAUDE.md` e `docs/diagrams/software-arch.mermaid` existe no código
- `docs/diagrams/software-arch.mermaid` renderiza com fila `BullMQ + Redis` e storage `RustFS (dev) / S3 (prod)`
- `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit` e `npm run lint` (no container) terminam com código 0

---

## Technical Specifications

### Data Model

#### Video

Table `videos`. Owned by the channel (per phase-03-videos/TD-05 revision). Status lifecycle per phase-03-videos/TD-12; metadata columns per phase-03-videos/TD-09 revision; public ID per phase-03-videos/TD-10; storage keys derive from the internal `id` (per phase-03-videos/TD-03).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Internal ID; the only ID used in storage keys and queue payloads (TD-03, TD-13) — never exposed in URLs |
| public_id | varchar(11) | unique, not null | Random 11-char base64url (`[A-Za-z0-9_-]{11}`); generate-and-retry-on-unique-violation, same pattern as channel nicknames (TD-10) |
| channel_id | uuid | FK → channels.id, not null | Resolved from the authenticated user's channel at initiation (TD-05 revision) |
| title | varchar(255) | not null | Defaults to `original_filename` without its extension (TD-05 revision); edited in Phase 04 |
| description | text | nullable | `null` at initiation (TD-05 revision) |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'failed'` | TD-12. Transitions only via conditional updates on the current state |
| failure_reason | varchar(50) | nullable | Set only together with `status = 'failed'` (TD-12, TD-13). Values: `invalid_media` (worker `UnrecoverableError`, TD-09/TD-13), `processing_failed` (retries exhausted, TD-13), `upload_abandoned` (cleanup job, TD-07), `upload_size_mismatch` (completion `HeadObject` check, TD-05 step 3) |
| original_filename | varchar(255) | not null | From initiation input (TD-05 revision) |
| content_type | varchar(255) | not null | Declared content type from initiation input (TD-05 revision) |
| declared_size_bytes | bigint | not null | Size in bytes declared at initiation (TD-05 revision); drives `part_count` and the post-completion `HeadObject` check |
| upload_id | varchar(255) | nullable | S3 multipart `UploadId` from `CreateMultipartUpload` (TD-05); set while `status = 'draft'`, cleared (`null`) after completion, size-mismatch rejection or cleanup abort |
| size_bytes | bigint | nullable | Recorded at completion from `HeadObject` `ContentLength` (TD-05, TD-09 revision); used to track storage growth (TD-03) |
| duration_seconds | double precision | nullable | ffprobe, set by the worker (TD-09 revision) |
| width | integer | nullable | ffprobe (TD-09 revision) |
| height | integer | nullable | ffprobe (TD-09 revision) |
| mime_type | varchar(255) | nullable | Container/format reported by ffprobe (TD-09 revision) |
| video_codec | varchar(50) | nullable | ffprobe (TD-09 revision) |
| audio_codec | varchar(50) | nullable | `null` when there is no audio stream (TD-09 revision) |
| bitrate | integer | nullable | bits per second, ffprobe (TD-09 revision) |
| frame_rate | double precision | nullable | ffprobe (TD-09 revision) |
| thumbnail_key | varchar(255) | nullable | Object key of the generated thumbnail; set by the worker when processing succeeds |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`, `ON DELETE NO ACTION` — same as existing FKs); Channel → Video (one-to-many, inverse side `videos`).
**Indexes:** `(public_id)` — unique; `(channel_id)` — FK lookup; `(status, created_at)` — abandoned-draft query of the cleanup job (TD-07, TD-12); `(status, updated_at)` — stuck-`processing` query of the same job (TD-13).
**Row retention:** rows are never deleted in this phase. Abandoned drafts and size-mismatch rejections become `status = 'failed'` with a `failure_reason`, and only their storage objects are removed (TD-07 allows either form; keeping the record was chosen).
**Column mapping notes:** `bigint` columns (`declared_size_bytes`, `size_bytes`) use a TypeORM column `transformer` that maps the `pg` string to `number` (10 GiB fits in `Number.MAX_SAFE_INTEGER`). All metadata columns stay `null` until processing finishes (TD-09 revision).

#### Object storage layout (per phase-03-videos/TD-03)

Single private bucket (`S3_BUCKET`, created by the `storage-init` container per phase-03-videos/TD-14). One prefix per video, keyed by the internal UUID:

| Key | Written by | Notes |
|-----|-----------|-------|
| `videos/{id}/original` | Browser, via presigned multipart parts (TD-05) | The uploaded file as-is; streamed and downloaded as uploaded (TD-11) |
| `videos/{id}/thumbnail.jpg` | Worker (TD-09) | Single frame at 10 % of the duration, fallback to the first frame for very short clips |

Deleting a video's storage = deleting the `videos/{id}/` prefix (TD-03).

### API Contracts

All endpoints live in `VideosController` (`@Controller('videos')`) and require a valid access token (global `JwtAuthGuard`, no `@Public()`). `:publicId` is the 11-char `public_id` (TD-10) — the internal `id` never appears in a URL. Errors use the inherited envelope `{ statusCode, error, message }` (phase-02-auth/TD-07). The controller is annotated `@SkipThrottle()` (phase-02-auth/TD-08 exemption mechanism): the throttler is meant for auth endpoints, and a 10 req/min limit would break batched part-URL requests and player redirects. Every endpoint carries explicit `@ApiOperation` / `@ApiResponse` decorators with `ApiErrorEnvelope` for errors (openapi-docs-nestjs/TD-01 revision), and `openapi.json` is regenerated (openapi-docs-nestjs/TD-02).

**`VideoResponse` (shared response shape):**
- public_id: string — 11 chars
- title: string
- description: string | null
- status: `'draft' | 'processing' | 'ready' | 'failed'`
- failure_reason: `'invalid_media' | 'processing_failed' | 'upload_abandoned' | 'upload_size_mismatch'` | null — non-null only when `status = 'failed'`
- original_filename: string
- content_type: string
- size_bytes: number | null
- duration_seconds: number | null
- width: number | null
- height: number | null
- mime_type: string | null
- video_codec: string | null
- audio_codec: string | null
- bitrate: number | null
- frame_rate: number | null
- created_at: string (ISO-8601)
- updated_at: string (ISO-8601)

Internal fields (`id`, `channel_id`, `upload_id`, `declared_size_bytes`, `thumbnail_key`) are never serialized.

---

#### POST /videos (SI-03.7)

Initiates the upload: pre-registers the video as a draft and creates the S3 multipart upload in the same call (TD-05).

**Request headers:**
- Content-Type: application/json

**Request body:**
- filename: string, required — non-empty, max 255 characters
- size_bytes: integer, required — min 1, max 10737418240 (10 GiB, TD-05 step 1)
- content_type: string, required — must start with `video/`, max 255 characters

**Response 201:**
- `VideoResponse` fields (status `'draft'`, `title` = filename without extension, `description` = null, `size_bytes` = null)
- upload: object
  - part_size: number — fixed `67108864` (64 MiB, TD-05); read from `UPLOAD_PART_SIZE_BYTES` (default and production value `67108864`, Joi min `5242880`) so tests can use the 5 MiB S3 minimum and still exercise several parts
  - part_count: number — `ceil(size_bytes / part_size)`; the last part is `size_bytes - (part_count - 1) * part_size` bytes

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation (including `size_bytes` > 10 GiB)
- 401 Unauthorized: missing/invalid access token

---

#### POST /videos/:publicId/upload/part-urls (SI-03.8)

Issues a batch of presigned `UploadPart` URLs, signed with the **public** S3 client (TD-04), valid for 1 h, each binding its exact `Content-Length` into the signature (TD-05 step 2).

**Request headers:**
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 to 100 items, unique, each ≥ 1

**Response 200:**
- parts: array of
  - part_number: number
  - url: string — presigned `PUT` URL on `S3_PUBLIC_ENDPOINT`
  - content_length: number — exact byte count the browser must send for this part
- expires_in: number — `3600` (seconds)

**Error responses:**
- 400 VALIDATION_ERROR: body fails validation
- 400 INVALID_PART_NUMBER: any part number is greater than the video's `part_count`
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another user
- 409 VIDEO_UPLOAD_NOT_ACTIVE: video `status ≠ 'draft'`

---

#### GET /videos/:publicId/upload/parts (SI-03.8)

Resume support: lists the parts already stored, read from S3 `ListParts` (TD-05). The browser uploads only the missing part numbers.

**Response 200:**
- part_size: number
- part_count: number
- uploaded_parts: array of
  - part_number: number
  - size: number

**Error responses:**
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another user
- 409 VIDEO_UPLOAD_NOT_ACTIVE: video `status ≠ 'draft'`

---

#### POST /videos/:publicId/upload/complete (SI-03.9)

The client signals that all parts were sent; the API completes the upload from its own `ListParts` (TD-06), verifies the object size with `HeadObject` (TD-05 step 3), moves `draft → processing` with a conditional update (`WHERE status = 'draft'`, TD-12), then enqueues the processing job with `jobId = id` (TD-13). No request body.

**Idempotency:** when the video is already `processing`, the call re-enqueues with the same `jobId` (no-op if the job exists — closes the "commit succeeded, enqueue failed" gap, TD-13) and returns 200 with the current video.

**Response 200:**
- `VideoResponse` (status `'processing'`, `size_bytes` set from `HeadObject`)

**Error responses:**
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another user
- 409 UPLOAD_INCOMPLETE: `ListParts` does not contain every part `1..part_count`
- 409 VIDEO_UPLOAD_NOT_ACTIVE: video `status` is `'ready'` or `'failed'`
- 422 UPLOAD_SIZE_MISMATCH: `HeadObject` `ContentLength ≠ declared_size_bytes`; the row is moved to `status = 'failed'`, `failure_reason = 'upload_size_mismatch'`, `upload_id = null` via a conditional update `WHERE status = 'draft'`, and the objects under `videos/{id}/` are deleted (the row is kept)

---

#### GET /videos/:publicId (SI-03.13)

Owner reads the video, including status and extracted metadata (used to poll processing).

**Response 200:**
- `VideoResponse`

**Error responses:**
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another user

---

#### GET /videos/:publicId/stream (SI-03.14)

Access check, then `302` to a presigned `GetObject` URL for `videos/{id}/original`, signed with the public client, valid ~6 h (TD-11). `Range` / `206` are served by the storage server.

**Response 302:**
- Location: presigned GET URL (`expiresIn` = 21600 s)
- Cache-Control: no-store

**Error responses:**
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another user (TD-11 revision — existence not revealed)
- 409 VIDEO_NOT_READY: owner request while `status ≠ 'ready'`

---

#### GET /videos/:publicId/download (SI-03.14)

Same as stream, but the presigned URL sets `ResponseContentDisposition: attachment; filename="{original_filename}"` and is valid ~15 min (TD-11).

**Response 302:**
- Location: presigned GET URL (`expiresIn` = 900 s)
- Cache-Control: no-store

**Error responses:**
- 401 Unauthorized: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown `publicId` or video owned by another user
- 409 VIDEO_NOT_READY: owner request while `status ≠ 'ready'`

---

#### Validation Rules — Videos

| Field | Rule | Error message |
|-------|------|---------------|
| filename | Required string, not empty, max 255 | filename should not be empty / filename must be shorter than or equal to 255 characters |
| size_bytes | Required integer, min 1, max 10737418240 | size_bytes must not be greater than 10737418240 |
| content_type | Required string, matches `^video\/`, max 255 | content_type must match /^video\// regular expression |
| part_numbers | Required array, 1–100 items, unique, each integer ≥ 1 | part_numbers must contain no more than 100 elements |
| publicId (path) | 11 chars, `[A-Za-z0-9_-]` — a malformed value is treated as unknown → 404 VIDEO_NOT_FOUND | — |

### Authorization Matrix

Owner = the video's channel belongs to the authenticated user (`channels.user_id = jwt.sub`). Nothing is public in Phase 03; Phase 04 opens published videos through its own visibility field (TD-11 revision). Non-owners get the same `404` as an unknown ID, so existence is never revealed.

| Endpoint | Anonymous | Authenticated (non-owner) | Owner | Notes |
|----------|-----------|---------------------------|-------|-------|
| POST /videos | ✗ 401 | ✓ | — | Creates a video owned by the caller's channel |
| POST /videos/:publicId/upload/part-urls | ✗ 401 | ✗ 404 | ✓ | Requires `status = 'draft'` |
| GET /videos/:publicId/upload/parts | ✗ 401 | ✗ 404 | ✓ | Requires `status = 'draft'` |
| POST /videos/:publicId/upload/complete | ✗ 401 | ✗ 404 | ✓ | `draft → processing`; idempotent when `processing` |
| GET /videos/:publicId | ✗ 401 | ✗ 404 | ✓ | Any status |
| GET /videos/:publicId/stream | ✗ 401 | ✗ 404 | ✓ | `409` when `status ≠ 'ready'` |
| GET /videos/:publicId/download | ✗ 401 | ✗ 404 | ✓ | `409` when `status ≠ 'ready'` |

### Error Catalog

Inherits the error envelope from phase-02-auth (`{ statusCode, error, message }`, `DomainException` subclasses mapped by `DomainExceptionFilter`). The `401` from the global `JwtAuthGuard` keeps Nest's default `UnauthorizedException` body, unchanged from Phase 02.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | Any `/videos/:publicId*` endpoint with an unknown or malformed `publicId`, or a video whose channel is not the caller's (TD-11 revision) |
| VIDEO_UPLOAD_NOT_ACTIVE | 409 | Video upload is not active | `part-urls` / `upload/parts` when `status ≠ 'draft'`; `upload/complete` when `status` is `'ready'` or `'failed'` |
| INVALID_PART_NUMBER | 400 | Part number is out of range | `part-urls` with a part number greater than the video's `part_count` (TD-05 step 2 — only `1..partCount` are signed) |
| UPLOAD_INCOMPLETE | 409 | Upload has missing parts | `upload/complete` when `ListParts` lacks any part `1..part_count` (TD-06) |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded file size does not match the declared size | `upload/complete` when `HeadObject` `ContentLength ≠ declared_size_bytes` (TD-05 step 3). Side effect: video → `status = 'failed'`, `failure_reason = 'upload_size_mismatch'`; objects under `videos/{id}/` deleted; row kept |
| VIDEO_NOT_READY | 409 | Video is not ready | `stream` / `download` by the owner while `status ≠ 'ready'` (TD-11 revision) |
| VALIDATION_ERROR | 400 | _array of field messages_ | Inherited — request body fails DTO validation (see Validation Rules — Videos) |

### Events/Messages

Queue backend: BullMQ on Redis via `@nestjs/bullmq` (TD-01). Redis runs with `--appendonly yes --maxmemory-policy noeviction`. The API's `VideosModule` only **produces**; a processing module loaded only by `WorkerModule` **consumes** (TD-08).

#### video-processing → `process-video`

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoProcessingProducer` in `VideosModule` — called by the upload-completion flow after the `draft → processing` commit, and again on an idempotent repeat of `complete` (per phase-03-videos/TD-06, TD-13)
**Consumer:** `VideoProcessingProcessor` (`@Processor('video-processing')`, extends `WorkerHost`) in the worker's processing module (per phase-03-videos/TD-08)
**Trigger:** successful `POST /videos/:publicId/upload/complete`
**Job options:** `jobId: videoId` (deduplicated enqueue), `attempts: 3`, `backoff: { type: 'exponential', delay: 10000 }`, `removeOnComplete: true`, `removeOnFail: { age: 604800 }` (keep failed-job record 7 days) (per phase-03-videos/TD-13)
**Processing steps:** load the row; skip if `status ≠ 'processing'` (re-delivery after success) → presign an internal GET for `videos/{id}/original` with the **internal** client (TD-04) → spawn system `ffprobe` on the URL (HTTP `Range`, TD-09) → no video stream ⇒ throw `UnrecoverableError` (permanent failure) → spawn `ffmpeg` to extract one frame at 10 % of the duration (fallback: first frame) → `PutObject` `videos/{id}/thumbnail.jpg` (fixed key, safe to repeat) → conditional update `WHERE id = :id AND status = 'processing'` setting metadata columns, `thumbnail_key` and `status = 'ready'`
**Failure handling:** `@OnWorkerEvent('failed')` sets `status = 'failed'` (conditional `WHERE status = 'processing'`) with `failure_reason = 'invalid_media'` when the error is `UnrecoverableError`, or `failure_reason = 'processing_failed'` when `job.attemptsMade >= job.opts.attempts`; temporary errors (storage/network/ffmpeg crash) are rethrown so BullMQ retries (TD-13)
**Delivery semantics:** at-least-once; every step is idempotent (deduplicated enqueue, conditional update, fixed keys) (per phase-03-videos/TD-13)

#### video-maintenance → `cleanup-abandoned-uploads` (scheduled)

**Payload:**

```json
{}
```

**Producer:** BullMQ job scheduler registered by the worker on boot via `queue.upsertJobScheduler('cleanup-abandoned-uploads', { every: 3600000 }, { name: 'cleanup-abandoned-uploads' })` — idempotent per scheduler ID (per phase-03-videos/TD-07)
**Consumer:** `AbandonedUploadsCleanupProcessor` (`@Processor('video-maintenance')`) in the worker's processing module (per phase-03-videos/TD-07, TD-08)
**Trigger:** every hour
**Behavior — abandoned drafts (TD-07):** select `videos` with `status = 'draft'` and `created_at` older than `UPLOAD_ABANDON_AFTER_HOURS` (default `24`, aligned with RustFS's 24 h stale-upload default). For each: first a conditional update `WHERE id = :id AND status = 'draft'` setting `status = 'failed'`, `failure_reason = 'upload_abandoned'`, `upload_id = null` (a concurrent `complete` wins — 0 rows affected ⇒ skip); then `AbortMultipartUpload` with the previously read `upload_id` when set (ignore `NoSuchUpload`) and delete the objects under `videos/{id}/`. The row is kept.
**Behavior — stuck in `processing` (TD-13):** select `videos` with `status = 'processing'` and `updated_at` older than `PROCESSING_STUCK_AFTER_MINUTES` (default `120`, well above the longest normal job). For each, look up the job by `jobId = id` on the `video-processing` queue:
- no job → re-enqueue `process-video` with the same options (closes the "commit succeeded, enqueue failed" gap);
- job in the failed state → conditional update `WHERE id = :id AND status = 'processing'` setting `status = 'failed'`, `failure_reason = 'processing_failed'` (a plain re-add would be ignored because `removeOnFail` keeps the failed job for 7 days under the same `jobId`);
- job waiting / active / delayed → leave it alone.
**Delivery semantics:** at-least-once; safe to repeat (per phase-03-videos/TD-07, TD-13)

---

## Dependency Map

```
SI-03.1 (root)
└── SI-03.2 — depends on SI-03.1 (pacotes antes da config/infra que os usa)
    ├── SI-03.3 — depends on SI-03.2 (spike precisa de storage + storage-init)
    │   └── SI-03.4 — depends on SI-03.3 (StorageService só depois do spike confirmar o servidor)
    └── SI-03.6 — depends on SI-03.2 (Redis + redisConfig)
SI-03.5 (root, independent — entidade Video sobre as entidades da Fase 02)

SI-03.7 — depends on SI-03.4 + SI-03.5 + SI-03.6 (storage, entidade e produtor no VideosModule)
└── SI-03.8 — depends on SI-03.7 (VideosModule, rascunhos e findOwnedByPublicId)
    ├── SI-03.9 — depends on SI-03.8 + SI-03.6 (URLs de parte + produtor de process-video)
    └── SI-03.13 — depends on SI-03.8 + SI-03.7 (leitura do dono + toVideoResponse)

SI-03.10 — depends on SI-03.4 + SI-03.5 + SI-03.6 (WorkerModule usa storage, entidade e fila)
└── SI-03.11 — depends on SI-03.10 + SI-03.9 (worker + vídeos que chegam a processing)
    ├── SI-03.12 — depends on SI-03.11 (VideoProcessingModule completo; retenção de falhas do SI-03.6)
    └── SI-03.14 — depends on SI-03.13 + SI-03.11 (controller do dono + vídeos ready)
        └── SI-03.15 — depends on SI-03.14 + SI-03.12 (fluxo completo exige todos os endpoints e o WorkerModule final)
            └── SI-03.16 — depends on SI-03.15 (documentação descreve o comportamento já entregue; fecha a Definition of Done)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Instalar dependências de fila e storage com versões fixadas
- [ ] SI-03.2 — Infra: Serviços Redis, RustFS e storage-init no Compose + namespaces de config
- [ ] SI-03.3 — Spike de compatibilidade S3 do RustFS (multipart pré-assinado, CORS com ETag, Range → 206)
- [ ] SI-03.4 — Criar StorageModule com clients S3 interno e público
- [ ] SI-03.5 — Criar entidade Video, migration e gerador de public_id
- [ ] SI-03.6 — Configurar a fila BullMQ e o produtor de process-video
- [ ] SI-03.7 — Endpoint POST /videos (início do upload + pré-cadastro como rascunho)
- [ ] SI-03.8 — Endpoints de URLs de parte e retomada (POST part-urls, GET upload/parts)
- [ ] SI-03.9 — Endpoint POST /videos/:publicId/upload/complete (conclusão + enfileiramento)
- [ ] SI-03.10 — Infra: Entrypoint do worker, WorkerModule e serviço video-worker no Compose
- [ ] SI-03.11 — Processar vídeo no worker (ffprobe, thumbnail, status e falhas)
- [ ] SI-03.12 — Job agendado de manutenção (rascunhos abandonados + vídeos presos em processing)
- [ ] SI-03.13 — Endpoint GET /videos/:publicId (status e metadados para o dono)
- [ ] SI-03.14 — Endpoints de streaming e download (302 para GET pré-assinado)
- [ ] SI-03.15 — Teste de fluxo completo: upload multipart direto ao storage até o vídeo pronto
- [ ] SI-03.16 — Documentação e Definition of Done da fase

**Full test suites:**

- [ ] Infrastructure up and ready (`cd nestjs-project && docker compose up -d && docker compose ps && docker compose exec db pg_isready -U streamtube && docker compose exec redis redis-cli ping`) — `storage-init` exited with code 0 and `video-worker` is `running` with the worker started (`docker compose logs video-worker`)
- [ ] Backend unit + integration tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully, including the worker entrypoint (`cd nestjs-project && docker compose exec nestjs-api npm run build && test -f dist/worker.js`)
- [ ] `openapi.json` regenerated and committed with every `/videos` route
- [ ] Test suites run with `QUEUE_PREFIX=test` and do not interfere with the running `video-worker`
- [ ] `CLAUDE.md`, `nestjs-project/CLAUDE.md` and `docs/diagrams/software-arch.mermaid` reflect BullMQ + Redis, RustFS/S3 and the `video-worker`
