> Part of the `testing-guide-nestjs-project` skill (see `../SKILL.md`).

# Modules (`*.module.ts`)

## What to test

- **DI compilation** — the module compiles without missing providers or circular dependencies
- **Configured import resolution** — `TypeOrmModule.forFeature()`, `JwtModule.register()`, `BullModule.registerQueue()` resolve correctly with all required config
- **Export availability** — exported providers are accessible to importing modules

## Layer assignment

| Scenario | Layer | Why |
|---|---|---|
| Module with configured imports, compiled **without** real infrastructure (JWT, Mailer, S3 client, BullMQ shared config only, Throttler, etc.) | **Unit** (compilation test, `*.module.spec.ts`) | DI wiring errors are runtime-only; TypeScript cannot catch missing imports |
| Module whose compilation test imports `TypeOrmModule.forRoot`, connects to Redis/BullMQ (registered queues, workers) or any other real service | **Integration** (compilation test, `*.module.integration-spec.ts`) | Same DI concern, but the test opens a real connection — `nestjs-project/CLAUDE.md` forbids real I/O in `*.spec.ts` |
| Simple module with only local providers and no configured imports | **Skip** | If the module only registers plain services/controllers, DI errors will surface in other tests |

**The suffix follows the real I/O, not the artifact type.** A compilation test is Unit only while nothing in it opens a connection; as soon as it needs a real database, Redis or another service, it is an Integration test and must be named `*.module.integration-spec.ts`.

**Critical:** Module compilation tests are NOT wiring tests. They verify that the DI container can resolve all dependencies — a real runtime concern that TypeScript's type system cannot check.

## Setup pattern

**Unit — no real infrastructure** (e.g., `MailModule`, `StorageModule`, `QueueModule`):

```typescript
// mail.module.spec.ts
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import mailConfig from '../config/mail.config';
import { MailModule } from './mail.module';

describe('MailModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [mailConfig] }),
        MailModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
```

**Integration — modules with database dependencies** (TypeORM; same applies to Redis/BullMQ queues):

```typescript
// users.module.integration-spec.ts
import { Test } from '@nestjs/testing';
import { UsersModule } from './users.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';

describe('UsersModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST ?? 'localhost',
          port: Number(process.env.DB_PORT ?? 5432),
          username: process.env.DB_USERNAME ?? 'streamtube',
          password: process.env.DB_PASSWORD ?? 'streamtube',
          database: process.env.DB_DATABASE ?? 'streamtube',
          entities: [User],
          synchronize: true,
        }),
        UsersModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
```

**For modules that import other domain modules:**

If `VideosModule` imports `UsersModule` and `ChannelsModule`, the compilation test must include those dependencies. Use `overrideProvider()` to mock providers from imported modules when a full dependency chain is impractical:

```typescript
describe('VideosModule', () => {
  it('should compile successfully', async () => {
    const module = await Test.createTestingModule({
      imports: [VideosModule],
    })
      .overrideProvider(UsersService)
      .useValue({})
      .overrideProvider(ChannelsService)
      .useValue({})
      .compile();

    expect(module).toBeDefined();
  });
});
```

**Key points:**
- The test only calls `.compile()` and asserts the module is defined — no behavior assertions
- If compilation fails, the error message tells you exactly which provider is missing
- Always call `module.close()` in `afterAll` when the module opens connections (DB, queues)
- For modules with DB dependencies, you need a real or overridden TypeORM root config

## When to skip

- `AppModule` — tested implicitly by every E2E test (E2E tests import `AppModule`)
- Modules with no configured imports — only plain providers and controllers; DI errors will surface in service/E2E tests

## Examples from project

- **Unit** (`*.module.spec.ts`) — no real connection:
  - `MailModule` [MailerModule.forRootAsync] — builds the transport, does not connect
  - `StorageModule` — instantiates the S3 clients only
  - `QueueModule` [BullModule.forRootAsync] — only builds the shared BullMQ config
- **Integration** (`*.module.integration-spec.ts`) — `TypeOrmModule.forRoot` and/or registered BullMQ queues:
  - `UsersModule`, `AuthModule`, `ChannelsModule`
  - `VideosModule`, `VideoProcessingModule` (DB + queues)
  - `WorkerModule` (initializes the `DataSource` and the queues)
- **Skip:** `AppModule` — covered by the E2E suites
