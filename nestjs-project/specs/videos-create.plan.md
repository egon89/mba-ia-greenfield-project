---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` inicia o upload de um vídeo: numa única chamada pré-cadastra o vídeo como rascunho (`status: "draft"`) no canal do usuário autenticado e abre o multipart upload no object storage. A resposta traz o `VideoResponse` (sem campos internos) mais `upload: { part_size, part_count }` para o cliente fatiar o arquivo. O endpoint exige access token, valida o corpo (`filename`, `size_bytes` ≤ 10 GiB, `content_type` começando com `video/`) e fica fora do throttler de auth (`@SkipThrottle()`).

## Test Scenarios

### 1. Iniciar upload e pré-cadastrar rascunho

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()`, reproduzindo os globais de `main.ts` (`ValidationPipe` com `whitelist`/`forbidNonWhitelisted`/`transform`, `DomainExceptionFilter`, `ValidationExceptionFilter`); `QUEUE_PREFIX=test` (via `src/test/jest-env.setup.ts`). `beforeEach`: `cleanAllTables(dataSource)` e `deletePrefix('videos/')` no bucket de teste; usuário registrado, confirmado e logado (helper `registerConfirmAndLogin`, mesmo padrão de `test/auth.e2e-spec.ts`). `afterAll`: `app.close()`.

#### 1.1. iniciar-upload-cria-rascunho-no-canal-do-usuario

**Covers AC:** #1, #2, #6
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <access_token>` e body `{ filename: "Minha viagem.mp4", size_bytes: 150000000, content_type: "video/mp4" }`
    - expect: status `201`
    - expect: body com `status: "draft"`, `title: "Minha viagem"`, `description: null`, `failure_reason: null`, `original_filename: "Minha viagem.mp4"`, `content_type: "video/mp4"`, `size_bytes: null` e todos os metadados (`duration_seconds`, `width`, `height`, `mime_type`, `video_codec`, `audio_codec`, `bitrate`, `frame_rate`) `null`
    - expect: `public_id` com 11 caracteres em `[A-Za-z0-9_-]`
    - expect: `upload` igual a `{ part_size: 67108864, part_count: 3 }`
    - expect: o body não contém as chaves `id`, `channel_id`, `upload_id`, `declared_size_bytes` nem `thumbnail_key`
  2. Consultar no banco a linha de `videos` com o `public_id` retornado
    - expect: `channel_id` igual ao id do canal cujo `user_id` é o `sub` do token usado
    - expect: `upload_id` preenchido e `declared_size_bytes = 150000000`

#### 1.2. corpo-invalido-retorna-validation-error

**Covers AC:** #3, #4
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. POST /videos autenticado com `{ filename: "big.mp4", size_bytes: 10737418241, content_type: "video/mp4" }`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` (array) citando `size_bytes`
  2. POST /videos autenticado com `{ filename: "foto.png", size_bytes: 1000, content_type: "image/png" }`
    - expect: status `400` com `error: "VALIDATION_ERROR"` e `message` citando `content_type`
  3. Contar linhas em `videos`
    - expect: nenhuma linha criada pelas duas requisições

#### 1.3. sem-autenticacao-retorna-401

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. POST /videos sem header `Authorization`, com body válido
    - expect: status `401`
    - expect: nenhuma linha criada em `videos`

#### 1.4. endpoint-fora-do-throttler-de-auth

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. Disparar 11 POST /videos seguidos, autenticados com o mesmo token e body válido, em menos de 1 minuto
    - expect: as 11 respostas têm status `201` (nenhum `429`)
    - expect: os 11 `public_id` retornados são distintos
