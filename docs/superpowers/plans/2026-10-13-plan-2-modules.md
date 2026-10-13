# Plan 2: Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the eight feature modules (realm, events, postings, comments, governance, room, upload, admin) onto the Plan 1 foundation with identical HTTP behaviour, and move verification and reset email onto the outbox.

**Architecture:** Each module is a folder in `apps/api/src/modules/<name>/` with a service (plain factory taking `{ db, ... }`, calling Drizzle directly), routes (a Hono factory taking the resolved services), and, where it has them, rules and event schemas. Views and presenters go to `packages/contracts`. The container registers each service as a singleton; `start()` resolves them once and builds every module's routes and consumers through `src/modules/index.ts`. The outbox carries only database changes whose side effect must not be lost: the OpenFGA sync and mail.

**Tech Stack:** as Plan 1 (Bun 1.4, Hono 4.13.13, Valibot 1.5.0, Drizzle 1.0.0-rc.4, InferDI 6.1.0, RabbitMQ, OpenFGA, better-auth, Resend 6.32 with `idempotencyKey`).

**Spec:** `docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md` (sections "Composition and lifecycle", "Outbox policy", "Mail through the outbox", "Testing" were updated for this plan). Also read `docs/superpowers/plans/2026-10-13-plan-1-followups.md`: this plan settles its "Plan 2 must decide" list.

**Old code:** `OLD=~/Personal/GitProj/akashic_records_be/api` (frozen). Frontend contract: `~/Personal/GitProj/akashic_records_fe/src/lib/api/*.ts` (Valibot schemas the web app parses responses with).

## Global Constraints

- Everything in the repo's `CLAUDE.md` binds (rules and traps). Read it first.
- Bun is off PATH: `export PATH="$HOME/.bun/bin:$PATH"`.
- **HTTP behaviour is unchanged:** same paths, methods, status codes, error codes, response field names and types as the old controllers. The web app's Valibot schemas must parse every response.
- **Stored values are unchanged:** enum numbers, error codes, event type strings (`realm.created`, `realm.member_changed`, `realm.posting_created`, …), queue `akashic.authz-sync`, exchange `akashic.events`.
- **No repository layer, no ports.** Services call Drizzle directly. A service file past ~300 lines may move query helpers into `<name>.queries.ts` as plain functions taking `db: Executor`; never an interface.
- **Services take `db: Executor`** (pool or transaction). Writes that must be atomic go through `inTransaction(db, ...)`; events through `publish(tx, ...)`; audits through `audit(tx, ...)`.
- **Modules never import each other.** Shared needs go into `http/`, a package, or `src/modules/index.ts` (the only file that knows every module).
- **Routes reply only through `reply`/`respond`**; validation only through `validate(target, schema)`.
- **Realm-scoped actions check the realm:** an id in the body or path must belong to the realm in the URL.
- **Outbox only where losing the side effect is a bug** (spec "Outbox policy"). Consumers are idempotent; third-party calls carry the event id as idempotency key.
- **Tests:** rules are unit tests; services and routes are integration tests in a rolled-back transaction (`withRollback`), skipping when Postgres doesn't answer. Postgres holds real dev data: tests only touch rows they create inside the rolled-back transaction.
- Commit trailer exactly `Co-Authored-By: Claude <noreply@anthropic.com>`. Regex-bearing files via the editor tool, not heredocs.

## Module porting recipe

Tasks 3-10 each port one module with these steps. The task names the old files, the routes and anything unusual.

1. **Read the old module:** `$OLD/src/modules/<m>/*`, its port `$OLD/src/ports/<m>.ts`, its repository `$OLD/src/adapters/postgres/<m>.repository.ts`, its tests in `$OLD/test/modules/` and its scenarios in `$OLD/test/integration/services.test.ts`, and the web app's schema file named in the task.
2. **Contracts:** create `packages/contracts/src/<m>.ts` from `$OLD/src/modules/<m>/<m>.schema.ts`: request schemas and response views in Valibot (TypeBox `t.Object` → `v.object`, `t.Optional` → `v.optional`, `t.Nullable` → `v.nullable`, `oneOf`/`literals` → `oneOf`/`v.picklist`, `trimmed` → `trimmed`, `Timestamp`/`iso` from `./common.ts`, `t.Composite([A, B])` → `v.object({ ...A.entries, ...B.entries })`), and presenters. A presenter's input type is declared in contracts next to it (for example `RealmSummary`), and the service returns that type, importing it from `@akashic/contracts`: contracts may import only `valibot` and the dependency-free lib subpaths (the boundary test enforces it), never `apps/api`. Export from `packages/contracts/src/index.ts`. Request schemas for query strings use `PageLimit`/`ListLimit`. Where the old schema used `trimmed({ maxLength })`, keep the old semantics (maxLength measured before trimming) by putting `v.maxLength(n)` before `v.trim()` for that field.
3. **Service:** create `apps/api/src/modules/<m>/<m>.service.ts` from the old service. Replace every repository call with the Drizzle query the old repository ran (same SQL semantics: joins, ordering, limits, `FOR UPDATE`, `ON CONFLICT`), and every `uow.run(async (tx) => …)` with `inTransaction(db, async (tx) => …)` where `tx.outbox.publish(events, now)` becomes `publish(tx, events, now)` and `tx.audit.record(...)` becomes `audit(tx, ...)`. Pure decision functions the old repository exported (and `repository-decisions.test.ts` tested) move to `<m>.rules.ts` with their tests. Keep the service's public method names and Result-returning signatures.
4. **Routes:** create `apps/api/src/modules/<m>/<m>.routes.ts` from the old controller: `export function create<M>Routes(deps): ModuleRoutes`. Elysia `params`/`body`/`query` schemas become `validate("param" | "json" | "query", Schema)`; `beforeHandle` guards become the middleware from Task 1 (`realmContext`, `requirePermission`, `requireModule`, `requireOn`); `respond(result, { set }, 201)` becomes `respond(c, result, View, 201)`; a returned value becomes `reply(c, View, value)`. Read the caller from `c.var.user`, the signal from `c.var.signal`, the realm from `c.var.realm`.
5. **Register:** in `apps/api/src/container.ts` register the service as an async factory over its dependencies (`database` → `database.db`, `authorizer`, `clock`, …). In `apps/api/src/modules/index.ts` add the module in the old mount order (realm, events, postings, comments, governance, room, upload, admin).
6. **Tests:** port the old unit tests of rules as-is. Port the old service unit tests (which used fake repositories) to integration tests on real Postgres with `withRollback`, keeping each test's intent and assertions. Port the module's scenarios from `services.test.ts`. Add one route test per route group: the happy path through `app.request` and one refusal (401 without a session, 403 without permission, or 404 for a disabled module), asserting status, error code and that the body parses with the web app's schema (copy the schema into the test if importing the web app isn't possible; Plan 3 replaces it with the shared contract). A concurrency test needs two connections, so it can't run inside one rolled-back transaction: it commits its own uniquely named rows and deletes exactly those in `finally`.
7. **Gate:** `bun test apps/api/test/modules/<m>` then `bun run check`; commit.

## Review Focus

1. **The same action twice at once** (two joins, two RSVPs into the last seat, two votes): the old row locks and `ON CONFLICT` clauses must survive the move from repositories into services. Pinned in Task 3 (concurrent join) and Task 4 (last seat).
2. **An id from another realm** in the path or body: refused as not found, never acted on. Pinned in Tasks 5 and 7 (comment and takedown on a posting from another realm).
3. **Resend down while someone signs up:** the email is retried and eventually parked, never silently lost, and never sent twice. Pinned in Task 2 (a failing send throws; the idempotency key is the event id).
4. **A socket opened with an expired or forged ticket:** refused before the upgrade. Pinned in Task 8.
5. **Writing into an archived realm:** refused below the realm root, allowed at the root for an administrator. Pinned in Task 1.

---

### Task 1: Module infrastructure

**Files:**
- Modify: `packages/db/src/transaction.ts` (`inTransaction` accepts `Executor`), `packages/db/package.json` (export `./testing`)
- Create: `packages/db/src/testing.ts`
- Modify: `packages/lib/package.json` (export `./testing`), move `packages/lib/test/spans.ts` and the pino capture helper to `packages/lib/src/testing.ts`; update every import of the old path
- Modify: `packages/lib/src/tracing.ts` (abort classification, error scrubbing)
- Create: `apps/api/src/http/realm-context.ts`
- Create: `apps/api/src/modules/index.ts`, `apps/api/src/modules/module.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/src/runtime.ts`, `apps/api/src/main.ts`, `apps/api/src/http/env.ts`, `apps/api/src/container.ts`
- Modify: spec "Composition and lifecycle" and "Request path" (request scope removed), CLAUDE.md
- Test: `packages/db/test/testing.integration.test.ts`, `packages/lib/test/tracing.test.ts`, `apps/api/test/http/realm-context.test.ts`, `apps/api/test/modules.test.ts`

**Interfaces:**
- Produces:
  - `inTransaction(db: Executor, work, attributes?)`: a savepoint when `db` is a transaction.
  - `@akashic/db/testing`: `withRollback(db: Db, work: (tx: Tx) => Promise<void>): Promise<void>`.
  - `@akashic/lib/testing`: `recordSpans()`, `captureLogger()` → `{ logger: Logger; lines: Record<string, unknown>[] }`.
  - `http/realm-context.ts`: `RealmContext { realmId; realmSlug; realmRole: RealmRole | null; realmModules: RealmModule[]; permissions: RealmPermissions }`, `RealmPermissions`, `RealmEnv` (AppEnv plus `realm: RealmContext`), `realmContext({ db, authorizer })`, `requirePermission(name)`, `requireModule(module)`, `requireOn(authorizer, relation, type)`.
  - `modules/module.ts`: `Module { name: string; routes: ModuleRoutes; consumer?: { queue: string; handlers: Record<string, EventHandler> } }` (move `ModuleRoutes` here from `app.ts`).
  - `modules/index.ts`: `buildModules(container: AppContainer, http: HttpKit): Promise<Module[]>` where `HttpKit = { sessions: ReturnType<typeof sessions>; realmContext: MiddlewareHandler<RealmEnv>; limiter: RateLimiter; logger: Logger }`.
  - `start(container, build = buildModules)` returns `{ app, env, logger, lifecycle, consumers: AsyncDisposable }`; `stop` disposes `consumers` before the container.

- [ ] **Step 1: Drop the per-request DI scope (ruling: spec agreed routes close over services; nothing resolves per request)**

Remove `inferdiHono` from `app.ts`, the `di` variable and `ApiEnv`, and the `request` scope input from `container.ts`. Every route group uses `AppEnv`. Remove `@inferdi/hono` from `apps/api/package.json` and the structure test's `@inferdi/hono` rule (keep the `@inferdi/inferdi` rule). Update the spec: in "Composition and lifecycle" replace the "Request scope" bullet with "Per-request values (id, caller, signal) live on the Hono context; services receive them as arguments.", and delete the `di scope` line from "Request path". Update CLAUDE.md's matching rule and trap.

Run: `bun run check`. Expected: pass (no route uses `di` yet besides tests; update those tests to read `c.var` instead).

- [ ] **Step 2: `inTransaction` over an `Executor`, and `withRollback`**

Test first, `packages/db/test/testing.integration.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { err, ok } from "@akashic/lib/result";
import { audit, auditEntries, createDb, inTransaction } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";

const url = Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";
const database = createDb({ url, poolMax: 2, idleTimeoutS: 5, connectTimeoutS: 2, logger: silentLogger() });
const live = await database.ping();

describe.skipIf(!live)("withRollback", () => {
  test("what a test writes is gone afterwards, and inTransaction nests as a savepoint", async () => {
    const entityId = Bun.randomUUIDv7();
    await withRollback(database.db, async (tx) => {
      const inner = await inTransaction(tx, async (t) => {
        await audit(t, { actorId: null, entityType: "test", entityId, action: AuditAction.created });
        return err(fail.conflict(ErrorCode.realm.duplicateSlug, "x"));
      });
      expect(inner.ok).toBe(false);
      // The savepoint rolled back the inner write; the outer transaction is still usable.
      expect(await tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId))).toEqual([]);
      await inTransaction(tx, async (t) => {
        await audit(t, { actorId: null, entityType: "test", entityId, action: AuditAction.created });
        return ok(undefined);
      });
      expect((await tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId))).length).toBe(1);
    });
    expect(await database.db.select().from(auditEntries).where(eq(auditEntries.entityId, entityId))).toEqual([]);
    await database[Symbol.asyncDispose]();
  });
});
```

Then change `inTransaction`'s first parameter to `Executor` (Drizzle's transaction handle has `transaction()`, which opens a savepoint), and write `packages/db/src/testing.ts`:

```ts
import type { Db, Tx } from "./client.ts";

const ROLLBACK = Symbol("rollback");

/** Runs `work` in a transaction that is always rolled back: a test's writes never persist. */
export async function withRollback(db: Db, work: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await work(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}
```

Add `"./testing": "./src/testing.ts"` to `packages/db/package.json` exports. Run the test. Expected: PASS.

- [ ] **Step 3: `@akashic/lib/testing`**

Move `recordSpans` from `packages/lib/test/spans.ts` into `packages/lib/src/testing.ts`, add `captureLogger()` (a real pino logger writing parsed JSON lines into an array, level `trace`), export `"./testing"`, and replace every relative import of `../../lib/test/spans.ts` (and any local pino-capture helper in `apps/api/test`) with `@akashic/lib/testing`. The OTel test SDK packages move from lib's devDependencies to dependencies (the subpath is only imported by tests, so production never loads it).

- [ ] **Step 4: Tracing: aborts are cancelled, errors don't leak data**

Tests first, in `packages/lib/test/tracing.test.ts`:

```ts
test("a TimeoutError or a shutdown abort is cancelled, not an error", async () => {
  for (const reason of [new DOMException("late", "TimeoutError"), new Error("shutting down: SIGTERM")]) {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(traced("x", {}, async () => { throw controller.signal.reason; }, { signal: controller.signal })).rejects.toBe(reason);
  }
  for (const span of recorder.spans()) {
    expect(span.attributes["akashic.cancelled"]).toBe(true);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  }
});

test("an unexpected error's message is not recorded, only its name and code", async () => {
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint "user_email_key": (email)=(ann@example.test)'), { code: "23505" });
  await expect(traced("x", {}, async () => { throw pgError; })).rejects.toBe(pgError);
  const [span] = recorder.spans();
  expect(JSON.stringify(span)).not.toContain("ann@example.test");
  expect(span?.attributes["error.type"]).toBe("23505");
});
```

Then in `traced`: add an optional `signal` option, and treat a throw as cancelled when it is an `AbortError`, or when `options.signal?.aborted` and the thrown value is `options.signal.reason`. For other errors, record an exception whose message is the error's name (`AppError` keeps its message: those are written for clients), set `error.type` to the error's `code` property when it is a string, else its name, and set the span status message to the same. Apply the same classification in `withConsumerSpan` (it takes the handler's signal). Run the tracing tests. Expected: PASS.

- [ ] **Step 5: Realm context middleware**

Port `$OLD/src/http/realm.ts` to `apps/api/src/http/realm-context.ts` on Hono: `realmContext({ db, authorizer })` reads `:slug` from `c.req.param("slug")`, loads the realm (`findBySlug`: id, slug, name, archivedAt), its modules and the caller's role with Drizzle directly (the old `realm.repository.ts` `findBySlug`, `modulesOf`, `roleOf`), asks the authorizer for the seven permissions with `checkMany` and `c.var.signal`, applies the archived rule (read-only except at the realm root, administrators keep `administer`), and sets `c.set("realm", context)`. `requirePermission`, `requireModule` and `requireOn` become `createMiddleware<RealmEnv>` guards throwing the same `fail.*` errors with the same codes and messages.

Test `apps/api/test/http/realm-context.test.ts`: port `$OLD/test/http/realm-context.test.ts` cases (unknown slug 404 `realm.not_found`; archived realm refuses a POST below the root with 409 `realm.archived` and allows it at the root; permissions are all false without a caller; `requireModule` 404 `realm.module_disabled`; `requirePermission` 403 `realm.forbidden`). Use `withRollback` to create the realm rows the tests need, and a fake `authorizer` whose `checkMany` returns a set answer.

- [ ] **Step 6: Module wiring and consumers**

`apps/api/src/modules/module.ts`:

```ts
import type { Hono } from "hono";
import type { EventHandler } from "@akashic/broker";
import type { AppEnv } from "@/http/env.ts";

/** Where a module's routes are mounted. */
export interface ModuleRoutes {
  /** Under /api/public/v1: anonymous reads, no session lookup. */
  readonly public?: Hono<AppEnv>;
  /** Under /api/v1, behind the session. */
  readonly private?: Hono<AppEnv>;
  /** At the app root, for routes that own their path, such as a socket. */
  readonly root?: Hono<AppEnv>;
}

/** One feature: its routes, and the events it consumes from its own queue. */
export interface Module {
  readonly name: string;
  readonly routes: ModuleRoutes;
  readonly consumer?: { readonly queue: string; readonly handlers: Readonly<Record<string, EventHandler>> };
}
```

`apps/api/src/modules/index.ts` starts as:

```ts
import type { AppContainer } from "@/container.ts";
import type { Module } from "./module.ts";
// HttpKit: see Interfaces.

/** Every module, in mount order. The one file that knows them all. */
export async function buildModules(_container: AppContainer, _http: HttpKit): Promise<Module[]> {
  return [];
}
```

`start()`: after the infrastructure is resolved, build `HttpKit` (sessions, realm context, limiter, logger), call `build(container, http)`, mount each module's routes (moving the mount loop from `createApp`'s `modules` dependency to `Module.routes`), and for every module with a `consumer` create an event consumer (`createEventConsumer` with the old composition's options: exchange `EVENTS_EXCHANGE`, the module's queue and handlers, `prefetch: env.OUTBOX_CONCURRENCY`, `handlerTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS`, `retryDelayMs: env.RABBITMQ_RETRY_DELAY_MS`, `maxAttempts: env.RABBITMQ_MAX_ATTEMPTS`, the lifecycle and logger) and start it. Return them as one `consumers` disposable (`owned({}, () => dispose each in reverse)`). `stop()` disposes `consumers` right after `lifecycle.abort` and before `container.dispose()`, so consumers stop before the outbox and the broker connection close.

In `packages/broker/src/consumer.ts`, a delivery whose handler failed because the lifecycle is shutting down (`lifecycle.signal.aborted`) is requeued without counting an attempt (`ConsumerStatus.REQUEUE`), as the spec says ("finish or requeue the message in hand"). Add a unit test next to the existing delivery tests.

Test `apps/api/test/modules.test.ts`: `start(container, build)` with a fake `build` returning one module with `private`, `public` and `root` routes and a consumer on a throwaway queue; assert the routes answer at `/api/v1/...`, `/api/public/v1/...` and `/...`, and that `stop` disposes the consumer before the container (record order with fakes as `runtime.test.ts` does).

- [ ] **Step 7: Gate and commit**

Run: `bun run check`. Expected: all pass.

```bash
git add -A && git commit -m "feat(api): module wiring, realm context, rollback harness, consumers, honest spans

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Mail through the outbox, and outbox retention

**Files:**
- Create: `apps/api/src/modules/mail/{mail.events.ts,mail.consumer.ts,mail.module.ts}`
- Modify: `apps/api/src/integrations/mail.ts`, `apps/api/src/auth/auth.ts`, `apps/api/src/container.ts`, `apps/api/src/modules/index.ts`, `apps/api/src/config.ts`, `.env.example`
- Modify: `packages/broker/src/{store.ts,dispatcher.ts,queues.ts,metrics.ts}`
- Test: `apps/api/test/modules/mail.test.ts`, `packages/broker/test/outbox.integration.test.ts`, `packages/broker/test/delivery.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Module`, `buildModules`, `inTransaction` on `Executor`)
- Produces: `Queues.mail = "akashic.mail"`; event `mail.requested` with payload `{ to: string; subject: string; html: string; link: string | null }`; `Mailer.send(message, { idempotencyKey })` throws on failure; `OUTBOX_RETENTION_DAYS` (int, min 1, default 7); `OutboxStore.prune(before: Temporal.Instant, limit: number): Promise<number>`.

- [ ] **Step 1: Retention, test first**

In `packages/broker/test/outbox.integration.test.ts` add: insert (in the test's own 1970-dated rows, as the file already does) one published row with `published_at` 30 days before a fixed `now` and one 1 day before, plus one dead row 30 days old; `store.prune(now.subtract({ hours: 24 * 7 }), 100)` returns 1 and leaves the recent published row and the dead row. Then implement `prune` in `store.ts` (delete published rows with `published_at < before`, oldest first, at most `limit`, via a `ctid`/`id IN (SELECT … LIMIT n)` subquery so one call is bounded) and call it from the dispatcher at most once per hour (track the last prune instant; use `clock.now()`), with the cutoff from a new `retentionDays` option. Log the count at info when non-zero. Change `observeOutbox`'s dead count to use the partial index the way pending does: add a partial index `ix_outbox_messages_dead ON outbox_messages (id) WHERE status = 3` in `packages/db/src/schema/outbox.ts`, generate the migration (`bun run db:generate`), and make both counts `WHERE status = <literal>` queries so the planner uses the partial indexes.

- [ ] **Step 2: Mailer that can be retried**

`integrations/mail.ts`: `send(message, options: { idempotencyKey?: string } = {})` passes `idempotencyKey` to `resend.emails.send(payload, { idempotencyKey })`, records health exactly as today, and then **throws** on failure (an `AppError` `external` with code `external.resend.delivery_failed`) instead of swallowing it, so the consumer retries. Without an API key it logs the link (non-production) and returns, as today. Update its tests.

- [ ] **Step 3: The mail module**

`mail.events.ts`: a Valibot schema for the `mail.requested` payload, and `mailRequested(message): DomainEvent`.

`mail.consumer.ts`: handlers `{ "mail.requested": async (payload, signal, meta) => … }` parsing the payload (a malformed payload throws, so it ends up parked) and calling `mailer.send(message, { idempotencyKey: meta.messageId })`. If the broker's `EventHandler` type doesn't pass the message id to handlers yet, extend it in `packages/broker/src/consumer.ts` to `(payload, signal, meta: { messageId: string; attempt: number })`, keeping existing handlers working (they ignore the third argument), and set `messageId` from the delivery's `messageId` (the publisher sets it to the outbox event id).

`mail.module.ts`: `createMailModule({ mailer, logger }): Module` with no routes and `consumer: { queue: Queues.mail, handlers }`. Register it in `buildModules`.

- [ ] **Step 4: better-auth publishes instead of sending**

In `auth.ts`, `sendVerificationEmail` and `sendResetPassword` build the same subject, html and link as today, then `await inTransaction(db, async (tx) => { await publish(tx, [mailRequested({ to, subject, html, link })], clock.now()); return ok(undefined); })`. Add `clock` to `createAuth`'s options. Keep a short comment: better-auth owns the transaction that creates the user, so this event is written right after it; a crash between the two loses that one email, and the person can ask for another.

- [ ] **Step 5: Tests**

`apps/api/test/modules/mail.test.ts`:
- with a fake mailer, the `mail.requested` handler sends once with `idempotencyKey` equal to the delivery's message id; a malformed payload throws;
- with `withRollback` and the real auth, signing up writes one pending `mail.requested` outbox row whose payload `to` is the new address (read the row in the same transaction), and nothing is sent synchronously (the fake mailer saw nothing);
- `/mail-status` still reports a failure recorded by a failing send;
- (Review Focus 3) a failing send makes the handler throw, so the delivery is retried, not acknowledged.

- [ ] **Step 6: Gate and commit**

Run: `bun run check`. Expected: all pass.

```bash
git add -A && git commit -m "feat: verification and reset email through the outbox, outbox retention

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Realm module

**Files:**
- Create: `apps/api/src/modules/realm/{realm.service.ts,realm.proposals.ts,realm.routes.ts,realm.consumer.ts,realm.rules.ts}`, `packages/contracts/src/{realm.ts,events.ts}`
- Create: `apps/api/scripts/{admin-grant.ts,realm-centroids.ts}`; root scripts `admin:grant`, `realm:centroids`
- Test: `apps/api/test/modules/realm/*.test.ts`

**Old files:** `$OLD/src/modules/realm/*` (service 278 lines, controller 156, consumer 109, schema 151), `$OLD/src/ports/realm.ts` (event types and payload schemas, `RealmPermissions` wire names), `$OLD/src/adapters/postgres/{realm,proposal}.repository.ts`, `$OLD/src/jobs/{grant-admin,seed-centroids}.ts`. Web schemas: `akashic_records_fe/src/lib/api/{realms,proposals}.ts`.

**Routes (15):** public `/realms` (list), `/realms/:slug` (summary); private founding, `/proposals` (create, mine), `/realms/:slug/{me,members,members/:userId,join,leave,…}`, archive and edit at the realm root, `/admin/proposals` (pending, `:id/approve`, `:id/reject`). Read the old controller for the exact list, guards and statuses.

**Unusual:**
- The consumer (`realm.consumer.ts`) is the OpenFGA sync on queue `Queues.authzSync` for `realm.created`, `realm.member_changed`, `realm.posting_created`. Port the event types, payload schemas (TypeBox to Valibot) and event builders from `$OLD/src/ports/realm.ts` into `packages/contracts/src/events.ts`, so every publisher (realm, events, postings, governance, admin) uses them without importing the realm module, and the consumer parses with the same schemas. Its tests (`$OLD/test/modules/realm.consumer.test.ts`) port as unit tests with a fake authorizer.
- `/admin/proposals` requires platform authority: mount it in the private group with `sessions.platformAdmin`, and make `platformAdmin` reuse `c.var.user` when the session middleware already set it (one session lookup, not two).
- **The old `approve` ran two transactions** (a known bug the old repo never fixed: approving creates the realm in one and marks the proposal in another, so a crash in between leaves a realm whose proposal is still pending). Do both in one `inTransaction`.
- `centroidFrom` from the old realm repository moves to `realm.rules.ts`.
- Test (Review Focus 1): two concurrent `join` calls by the same user on the same realm produce one membership and one `realm.member_changed` event, and the second answers 409 `realm.already_member`.
- `admin-grant.ts` and `realm-centroids.ts` port `$OLD/src/jobs/grant-admin.ts` and `seed-centroids.ts` the way Plan 1 ported the other scripts (`if (import.meta.main)`, own env, own resources, release in `finally`), calling the realm service built directly from its factory.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(realm): realms, membership, proposals and the OpenFGA sync`.

---

### Task 4: Events module

**Old files:** `$OLD/src/modules/events/*`, `$OLD/src/ports/events.ts`, `$OLD/src/adapters/postgres/event.repository.ts`. Web schema: `akashic_records_fe/src/lib/api/realms.ts` (`EventTeaser`, `EventDetail`).

**Routes (5):** under `/realms/:slug`: list events (public read), read one, post, RSVP, withdraw RSVP. Guarded by `requireModule(RealmModule.events)` and the old permissions.

**Unusual:** `hasRoomFor` (capacity decision) moves to `events.rules.ts` with its test. RSVP capacity must be checked under the same row lock the old repository took. Posting an event publishes `realm.posting_created` through the shared event builders in `@akashic/contracts`. Test (Review Focus 1): two concurrent RSVPs `going` for the last place: exactly one succeeds, the other is 409 `event.at_capacity`.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(events): realm events and RSVPs`.

---

### Task 5: Comments module

**Old files:** `$OLD/src/modules/comments/*`, `$OLD/src/ports/comments.ts`, `$OLD/src/adapters/postgres/comment.repository.ts`. Web schema: `realms.ts` (`Comment`).

**Routes (3):** `/realms/:slug/:kind/:id/comments` (thread, add) and `/realms/:slug/comments/:id` (remove), with `SubjectParam`/`subjectOf` from contracts.

**Unusual:** the subject (event, listing or job) must belong to the realm in the URL. Test (Review Focus 2): commenting on, or removing a comment of, a posting from another realm answers 404 and writes nothing. Removing a comment uses `requireOn(authorizer, Relation.comment.delete, FgaType.comment)` as before.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(comments): threads on postings`.

---

### Task 6: Postings module

**Old files:** `$OLD/src/modules/postings/*` (service 287, controller 221, `postings.fit.ts`), `$OLD/src/ports/postings.ts`, `$OLD/src/adapters/postgres/posting.repository.ts` (303). Web schema: `realms.ts` (`JobTeaser`, `JobDetail`, `ListingTeaser`, `ListingDetail`, `Interest`, `Review`).

**Routes (15):** jobs and listings (browse, read, post, set status, hire, deal), interest (show, drop, list), the fit review queue (list, decide). Exact list in the old controller.

**Unusual:** the realm fit check calls the embedder (`integrations/embedder.ts`) and updates the realm centroid (`setCentroid` from the old realm repository: inline the query here; it touches the `realm` table, which is allowed: modules share tables, not code). Port `fit-review.test.ts` and `postings.service.test.ts`. `postings.fit.ts` stays a pure rules file.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(postings): jobs, listings, interest and realm fit`.

---

### Task 7: Governance module

**Old files:** `$OLD/src/modules/governance/*` (service 336, `governance.rules.ts`), `$OLD/src/ports/governance.ts`, `$OLD/src/adapters/postgres/governance.repository.ts` (313). Web schema: `akashic_records_fe/src/lib/api/governance.ts`.

**Routes (10):** standings, upvote and withdraw, remove seat, recalls (list, propose, vote), takedowns (list, propose, vote).

**Unusual:** recalls and takedowns carry `realmId`, and takedowns carry `needed` (the fixes from the old repo's last commits: keep them). `sizeFrom` moves to rules. Carrying a recall changes roles: publish `realm.member_changed` for every role change, in the same transaction. Port `governance.rules.test.ts` and `governance.service.test.ts`. Test (Review Focus 2): proposing a takedown of a comment from another realm, or voting on another realm's recall, answers 404 `realm.not_found` and changes nothing.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(governance): elections, recalls and takedowns`.

---

### Task 8: Room module

**Old files:** `$OLD/src/modules/room/*` (service 247, controller 186 with the WebSocket, `room.tickets.ts`), `$OLD/src/ports/rooms.ts`, `$OLD/src/adapters/postgres/room.repository.ts` (267). Web schema: `akashic_records_fe/src/lib/api/rooms.ts`.

**Routes (10):** device keys (put mine, get a user's), rooms (start, list, transcript, ticket, block/unblock, report, retention) and the socket `GET /ws/rooms/:id` (root route).

**Unusual:**
- The socket uses `upgradeWebSocket` from `hono/bun`. `main.ts`/`runtime.listen` must pass Hono's `websocket` handler to `Bun.serve` (`Bun.serve({ port, fetch: app.fetch, websocket })`): add it to `listen()`'s serve callback.
- Messages are published to Bun's server pub/sub (`server.publish(topic, data)`) and to the relay, so other instances deliver them too; `relay.start(deliver)` must be called once the server exists, with `deliver = (topic, payload) => server.publish(topic, payload)`. Put that call in `runtime.listen` after a successful serve.
- The ticket is read from the query string (`searchParams.get("ticket")`), since a WebSocket upgrade can't carry the cookie.
- The retention sweep (`sweepExpired`) runs hourly: register it in the container as an owned interval timer, resolved in `start()` after the room service, so disposal clears it.
- Test (Review Focus 4): a socket request with an expired ticket, a ticket for another room, or a forged signature is refused with no upgrade.
- `agreeOn` (retention agreement) moves to `room.rules.ts`. Port `room-send.test.ts`, `room-socket.test.ts` (adapted to Hono's socket), `room.service.test.ts`.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(room): encrypted rooms, the socket and retention`.

---

### Task 9: Upload module

**Old files:** `$OLD/src/modules/upload/*`. Web schema: `akashic_records_fe/src/lib/api/uploads.ts`.

**Routes (2):** `GET /uploads` (limits, the `LimitsView`), `POST /uploads/:purpose` (multipart).

**Unusual:** multipart parsing with `c.req.parseBody()` and a Valibot check on the file (type in `policy.uploads.imageTypes`, size ≤ `policy.uploads.maxBytes`); the body-size middleware already exempts `/api/v1/uploads/`. The per-hour limit is `rateLimit(limiter, { bucket: "upload", limit: policy.uploads.perHour, windowSeconds: 3600 }, { trustProxy, logger })` on that route. Port `upload.test.ts`.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(upload): image uploads`.

---

### Task 10: Admin module

**Old files:** `$OLD/src/modules/admin/*`, `$OLD/src/ports/admin.ts`, `$OLD/src/adapters/postgres/admin.repository.ts` (206). Web schema: `akashic_records_fe/src/lib/api/platform.ts`.

**Routes (8):** `/admin` overview, realms, audit, reports (list, review), accounts (list, ban), grant realm admin.

**Unusual:** every route is behind `sessions.platformAdmin` (404 to everyone else). Granting realm admin publishes `realm.member_changed` and writes an audit entry in one transaction. Banning writes an audit entry. Port `admin.test.ts`.

- [ ] Follow the Module porting recipe steps 1-7. Commit: `feat(admin): the platform admin surface`.

---

### Task 11: Close out

**Files:** `docs/superpowers/plans/2026-10-13-plan-1-followups.md`, `CLAUDE.md`, `README.md`, `apps/api/test/contract.test.ts`

- [ ] **Step 1: Contract check against the web app.** `apps/api/test/contract.test.ts`: for every response view in `packages/contracts`, build a representative value with its presenter, `v.parse` it with the view, and `v.parse` the same JSON with the corresponding schema copied from `akashic_records_fe/src/lib/api/*.ts` (copied into `apps/api/test/fixtures/web-schemas.ts`, with a comment that Plan 3 deletes the copy when the web app imports contracts). Every pair must parse. List any mismatch found and fix the backend side when the old backend sent the field.
- [ ] **Step 2:** Update the follow-ups file: tick what this plan settled, keep what remains. Update CLAUDE.md's commands (`admin:grant`, `realm:centroids`) and the module rules. Update README's layout and scripts.
- [ ] **Step 3:** Manual check: `bun run dev`, then sign up and verify through the API (`curl` against `/api/auth/sign-up/email`), see one `mail.requested` row published and the dev log printing the verification link from the consumer; create a realm proposal, approve it as a platform admin (`bun run admin:grant <email>`), join it with a second account, and see the OpenFGA tuple written (`/api/v1/realms/:slug/me` shows the permissions). Paste the commands and responses into the commit body.
- [ ] **Step 4:** `bun run check`, commit `chore: plan 2 close-out`.
