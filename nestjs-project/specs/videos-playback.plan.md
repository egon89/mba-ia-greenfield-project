---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-playback.e2e-spec.ts
---

# GET /videos/:publicId/stream + GET /videos/:publicId/download — Test Plan

## Application Overview

Streaming e download usam o mesmo mecanismo: a API checa o acesso (autenticado e dono) e responde `302` para uma URL pré-assinada de `GetObject` no storage público, com `Cache-Control: no-store`. O storage serve `Range`/`206`, então nenhum byte de vídeo passa pela API. O stream vale ~6 h (`X-Amz-Expires=21600`); o download vale ~15 min (`X-Amz-Expires=900`) e força `Content-Disposition: attachment` com o nome original. Vídeo que não está `ready` → `409 VIDEO_NOT_READY`; outro dono ou inexistente → `404 VIDEO_NOT_FOUND`; sem token → `401`.

## Test Scenarios

### 1. Redirecionar para o storage

**Setup:** `beforeAll`: env `S3_PUBLIC_ENDPOINT=http://storage:9000` antes de compilar (a URL do `Location` precisa ser alcançável de dentro do container); `Test.createTestingModule({ imports: [AppModule] }).compile()` com os globais de `main.ts`; `QUEUE_PREFIX=test`. `beforeEach`: `cleanAllTables(dataSource)`, `deletePrefix('videos/')`; dois usuários confirmados e logados (dono e outro); o dono cria um rascunho via POST /videos com `filename: "Férias \"2026\".mp4"`; Arrange: `StorageService.putObject('videos/{id}/original', <4096 bytes conhecidos>, 'video/mp4')` e update da linha para `status = 'ready'`, `size_bytes = 4096`. Requisições com supertest **sem** seguir redirects. `afterAll`: `app.close()`.

#### 1.1. stream-redireciona-para-url-pre-assinada

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET /videos/{publicId}/stream como dono
    - expect: status `302` e header `Cache-Control: no-store`
    - expect: header `Location` com host igual ao de `S3_PUBLIC_ENDPOINT`, path terminando em `videos/{id}/original` e `X-Amz-Expires=21600` na query string
  2. `fetch` do `Location` com header `Range: bytes=0-1023` (direto no storage, sem nova chamada à API)
    - expect: status `206`, `Content-Range: bytes 0-1023/4096` e corpo igual aos 1024 primeiros bytes gravados no arrange

#### 1.2. download-redireciona-com-attachment

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET /videos/{publicId}/download como dono
    - expect: status `302`, header `Cache-Control: no-store`
    - expect: `Location` com `X-Amz-Expires=900` e `response-content-disposition` contendo `attachment`
  2. `fetch` do `Location`
    - expect: status `200`, corpo com os 4096 bytes gravados
    - expect: header `Content-Disposition` começa com `attachment` e identifica o nome original `Férias "2026".mp4` (forma `filename*=UTF-8''...` decodificada)

#### 1.3. video-nao-pronto-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. Arrange: atualizar a linha para `status = 'processing'`
  2. GET /videos/{publicId}/stream e GET /videos/{publicId}/download como dono
    - expect: ambos `409` com `error: "VIDEO_NOT_READY"` e sem header `Location`

#### 1.4. outro-usuario-ou-inexistente-retorna-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET stream e GET download com o token do **outro** usuário sobre o `publicId` do dono
    - expect: ambos `404` com `error: "VIDEO_NOT_FOUND"` e sem header `Location`
  2. GET stream e GET download com o token do dono e `publicId` inexistente (`AAAAAAAAAAA`)
    - expect: ambos `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.5. sem-autenticacao-retorna-401

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-01T21:43:23Z

**Steps:**
  1. GET /videos/{publicId}/stream e GET /videos/{publicId}/download sem header `Authorization`
    - expect: ambos `401` e sem header `Location`
