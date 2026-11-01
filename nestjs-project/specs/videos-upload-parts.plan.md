---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-parts.e2e-spec.ts
---

# POST /videos/:publicId/upload/part-urls + GET /videos/:publicId/upload/parts — Test Plan

## Application Overview

Durante o upload, o dono de um vídeo em `draft` pede URLs pré-assinadas de `UploadPart` (`POST /videos/:publicId/upload/part-urls`, até 100 partes por chamada). Cada URL é assinada para o host público do storage, vale 1 h e fixa o `Content-Length` exato da parte, então o navegador envia os bytes direto ao storage. Para retomar um upload interrompido, `GET /videos/:publicId/upload/parts` lista as partes já gravadas (via `ListParts`). Ambos respondem `404 VIDEO_NOT_FOUND` para vídeo inexistente ou de outro dono, e `409 VIDEO_UPLOAD_NOT_ACTIVE` quando o vídeo não está mais em `draft`.

## Test Scenarios

### 1. Emitir URLs de parte e retomar upload

**Setup:** `beforeAll`: env `S3_PUBLIC_ENDPOINT=http://storage:9000` (a assinatura fixa o host e `localhost:9000` não é alcançável de dentro do container) e `UPLOAD_PART_SIZE_BYTES=5242880`, definidos antes de compilar; `Test.createTestingModule({ imports: [AppModule] }).compile()` com os globais de `main.ts`; `QUEUE_PREFIX=test`. `beforeEach`: `cleanAllTables(dataSource)` e `deletePrefix('videos/')`; dois usuários confirmados e logados (dono e outro); o dono cria um rascunho via POST /videos com `size_bytes: 6291456` (5 MiB + 1 MiB → `part_count: 2`). `afterAll`: `app.close()`.

#### 1.1. emitir-urls-de-parte-para-o-dono

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. POST /videos/{publicId}/upload/part-urls como dono, body `{ part_numbers: [1, 2] }`
    - expect: status `200`
    - expect: `parts` com 2 itens, `part_number` 1 e 2
    - expect: cada `url` tem host igual ao de `S3_PUBLIC_ENDPOINT` e query string com `partNumber` e `uploadId`
    - expect: `content_length` = `5242880` na parte 1 e `1048576` na parte 2
    - expect: `expires_in: 3600`

#### 1.2. enviar-parte-direto-ao-storage-e-retomar

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET /videos/{publicId}/upload/parts como dono, antes de enviar qualquer parte
    - expect: status `200` com `part_size: 5242880`, `part_count: 2` e `uploaded_parts: []`
  2. Pedir a URL da parte 1 e fazer `fetch` `PUT` (fora do supertest) com exatamente `5242880` bytes
    - expect: o storage responde `200` com header `ETag`
  3. GET /videos/{publicId}/upload/parts como dono
    - expect: status `200` com `uploaded_parts` igual a `[{ part_number: 1, size: 5242880 }]`

#### 1.3. numeros-de-parte-invalidos

**Covers AC:** #3, #4
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. POST part-urls como dono com `{ part_numbers: [3] }` (maior que `part_count: 2`)
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`
  2. POST part-urls como dono com 101 números (`1..101`)
    - expect: status `400` com `error: "VALIDATION_ERROR"`
  3. POST part-urls como dono com `{ part_numbers: [1, 1] }`
    - expect: status `400` com `error: "VALIDATION_ERROR"`

#### 1.4. outro-usuario-ou-inexistente-retorna-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. POST part-urls e GET upload/parts com o token do **outro** usuário sobre o `publicId` do dono
    - expect: ambos `404` com `error: "VIDEO_NOT_FOUND"`
  2. POST part-urls e GET upload/parts com o token do dono e um `publicId` bem formado inexistente (`AAAAAAAAAAA`) e um malformado (`abc`)
    - expect: todos `404` com `error: "VIDEO_NOT_FOUND"` e o mesmo `message` do passo 1

#### 1.5. upload-nao-ativo-retorna-409

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. Arrange: atualizar no banco o vídeo do dono para `status = 'processing'`
  2. POST part-urls (`{ part_numbers: [1] }`) e GET upload/parts como dono
    - expect: ambos `409` com `error: "VIDEO_UPLOAD_NOT_ACTIVE"`
