---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId — Test Plan

## Application Overview

`GET /videos/:publicId` permite ao dono acompanhar o processamento e ler os metadados extraídos pelo worker (duração, dimensões, codecs, bitrate, frame rate) ou o `failure_reason` quando o processamento falhou. Nada é público nesta fase: sem token → `401`; outro usuário, `publicId` inexistente ou malformado → mesmo `404 VIDEO_NOT_FOUND` (a existência não é revelada). A resposta é o `VideoResponse`, sem campos internos.

## Test Scenarios

### 1. Ler o vídeo como dono

**Setup:** `beforeAll`: `Test.createTestingModule({ imports: [AppModule] }).compile()` com os globais de `main.ts`; `QUEUE_PREFIX=test`. `beforeEach`: `cleanAllTables(dataSource)`; dois usuários confirmados e logados (dono e outro); o dono cria um rascunho via POST /videos. Arrange de estados por update direto na linha (`status`, metadados, `failure_reason`, `thumbnail_key`). `afterAll`: `app.close()`.

#### 1.1. dono-le-video-ready-ou-failed

**Covers AC:** #1, #2, #5
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. Arrange: atualizar a linha para `status = 'ready'`, `size_bytes = 6291456`, `duration_seconds = 2`, `width = 320`, `height = 240`, `mime_type = 'mov,mp4,m4a,3gp,3g2,mj2'`, `video_codec = 'h264'`, `audio_codec = 'aac'`, `bitrate = 250000`, `frame_rate = 25`, `thumbnail_key = 'videos/{id}/thumbnail.jpg'`
  2. GET /videos/{publicId} como dono
    - expect: status `200` com `status: "ready"`, `failure_reason: null` e os metadados com os valores do arrange (numéricos como `number`)
    - expect: o body não contém as chaves `id`, `channel_id`, `upload_id`, `declared_size_bytes` nem `thumbnail_key`
  3. Arrange: atualizar a linha para `status = 'failed'`, `failure_reason = 'invalid_media'`
  4. GET /videos/{publicId} como dono
    - expect: status `200` com `status: "failed"` e `failure_reason: "invalid_media"`

#### 1.2. outro-usuario-ou-inexistente-retorna-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET /videos/{publicId} com o token do **outro** usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/AAAAAAAAAAA e GET /videos/abc com o token do dono
    - expect: ambos `404` com `error: "VIDEO_NOT_FOUND"` e o mesmo `message` do passo 1

#### 1.3. sem-autenticacao-retorna-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET /videos/{publicId} sem header `Authorization`
    - expect: status `401`
