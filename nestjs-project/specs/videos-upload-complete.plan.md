---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:publicId/upload/complete — Test Plan

## Application Overview

O cliente avisa que terminou de enviar as partes; a API conclui o multipart a partir do próprio `ListParts` (não confia em ETags do cliente), confere o tamanho final com `HeadObject` e move o vídeo `draft → processing` com update condicional, enfileirando `process-video` com `jobId` igual ao id interno do vídeo. A chamada é idempotente: repetir sobre um vídeo em `processing` reenfileira o mesmo `jobId` (no-op) e devolve `200`. Parte faltando → `409 UPLOAD_INCOMPLETE`; tamanho divergente → `422 UPLOAD_SIZE_MISMATCH`, com a linha mantida como `failed`/`upload_size_mismatch` e os objetos do prefixo apagados; vídeo `ready`/`failed` → `409 VIDEO_UPLOAD_NOT_ACTIVE`; outro dono → `404 VIDEO_NOT_FOUND`.

## Test Scenarios

### 1. Concluir upload e enfileirar processamento

**Setup:** `beforeAll`: env `S3_PUBLIC_ENDPOINT=http://storage:9000` e `UPLOAD_PART_SIZE_BYTES=5242880` antes de compilar; `Test.createTestingModule({ imports: [AppModule] }).compile()` com os globais de `main.ts`; `QUEUE_PREFIX=test`; `Queue` de `video-processing` obtida via `getQueueToken('video-processing')`. `beforeEach`: `cleanAllTables(dataSource)`, `deletePrefix('videos/')`, `queue.obliterate({ force: true })`; dois usuários confirmados e logados (dono e outro); o dono cria um rascunho via POST /videos com `size_bytes: 6291456` (`part_count: 2`). Helper `uploadParts(publicId, partNumbers)`: pede as URLs e faz `fetch` `PUT` de cada fatia com o `content_length` indicado. `afterAll`: `queue.obliterate({ force: true })`, `app.close()`.

#### 1.1. concluir-upload-move-para-processing-e-enfileira

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. `uploadParts(publicId, [1, 2])`
  2. POST /videos/{publicId}/upload/complete como dono, sem body
    - expect: status `200` com `status: "processing"`, `size_bytes: 6291456` e `failure_reason: null`
  3. Consultar a fila `video-processing` (prefixo `test`) e a linha do vídeo
    - expect: existe exatamente um job `process-video` com `id` igual ao `id` interno do vídeo e `data` igual a `{ videoId: <id> }`
    - expect: a linha tem `upload_id = null`
    - expect: `HeadObject` de `videos/{id}/original` retorna `ContentLength: 6291456`

#### 1.2. repetir-complete-e-idempotente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. `uploadParts(publicId, [1, 2])` e POST complete como dono
    - expect: status `200` com `status: "processing"`
  2. POST complete de novo como dono
    - expect: status `200` com `status: "processing"` e o mesmo `size_bytes`
  3. Consultar a fila `video-processing`
    - expect: continua havendo exatamente um job para o vídeo

#### 1.3. parte-faltando-retorna-upload-incomplete

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. `uploadParts(publicId, [1])` (só a primeira de duas partes)
  2. POST complete como dono
    - expect: status `409` com `error: "UPLOAD_INCOMPLETE"`
  3. Consultar a linha do vídeo e a fila
    - expect: `status = 'draft'`, `upload_id` inalterado e nenhum job enfileirado

#### 1.4. tamanho-divergente-marca-failed-e-apaga-objetos

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. `uploadParts(publicId, [1, 2])`; Arrange: atualizar no banco `declared_size_bytes` do vídeo para `6291457` (mantendo `part_count` em 2)
  2. POST complete como dono
    - expect: status `422` com `error: "UPLOAD_SIZE_MISMATCH"`
  3. Consultar a linha do vídeo, o storage e a fila
    - expect: a linha existe com `status = 'failed'`, `failure_reason = 'upload_size_mismatch'` e `upload_id = null`
    - expect: `ListObjectsV2` com prefixo `videos/{id}/` não retorna nenhum objeto
    - expect: nenhum job enfileirado para o vídeo

#### 1.5. estado-final-ou-outro-dono-e-rejeitado

**Covers AC:** #5, #6
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. Arrange: atualizar no banco o vídeo para `status = 'ready'`; POST complete como dono
    - expect: status `409` com `error: "VIDEO_UPLOAD_NOT_ACTIVE"`
  2. Arrange: atualizar para `status = 'failed'`, `failure_reason = 'processing_failed'`; POST complete como dono
    - expect: status `409` com `error: "VIDEO_UPLOAD_NOT_ACTIVE"`
  3. Com um novo rascunho do dono com as 2 partes enviadas, POST complete com o token do **outro** usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua `draft` e nenhum job foi enfileirado
