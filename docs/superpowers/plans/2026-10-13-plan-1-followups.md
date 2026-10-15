# Plan 1 follow-ups

What the foundation's reviews deferred. Plan 2 settled the first section; the rest remains. Written from the
execution ledger when Plan 1 finished (2026-10-13); the ledger itself was scratch.

## Plan 2 had to decide before the first module (all settled)

- [x] **How a service gets `db`.** Services take a `db: Executor`; `container.ts` builds them in
  `start()` from the resolved `database` and documents the pattern.
- [x] **How module routes are built.** Each module's `<name>.module.ts` builds its services and
  routes; `src/modules/index.ts` lists them and `start()` mounts them.
- [x] **A rollback test harness.** `withRollback` in `@akashic/db/testing`: `db` is a transaction
  rolled back after each test, with savepoint-nesting `inTransaction`.
- [x] **Consumers.** Wired after the outbox, disposed in a chosen order (none start once shutdown
  began); a shutdown abort requeues instead of counting a retry, and `withConsumerSpan` reads it
  as cancelled.
- [x] **Room WebSocket.** `hono/bun`'s websocket handler is wired and `relay.start(deliver)` runs
  with `server.publish`.
- [x] **Realm context middleware.** `http/realm-context.ts`, with `requireModule`,
  `requirePermission` and `requireOn`.
- [x] **Admin routes ran `session` twice.** `platformAdmin` reuses the session lookup already on
  `c.var`.
- [x] **`ApiEnv`.** Removed; routes depend on `http/env.ts` (`AppEnv`, `callerOf`). Lib's test
  helpers are the `@akashic/lib/testing` subpath.
- [x] **`trimmed` measures `maxLength` after trimming.** Decided per field: `trimmedAsSent` keeps
  the old measure (max before trimming, min after) and every ported field uses it.
- [x] **Still to port:** the retention sweep, `admin:grant` and `realm:centroids` are done.
- [x] **Scrub error messages in `traced`.** Row data stays out of exception events, in `traced`
  and in the server span.

## Before the first production deploy

- [x] `observeOutbox` counted the whole `outbox_messages` table every export, and published rows
  were never deleted. Partial indexes (`status = 0`, `status = 3` literals) serve the counts, and
  the dispatcher deletes published rows after `OUTBOX_RETENTION_DAYS`.
- Pin `openfga/openfga` (compose and CI) instead of `latest`.
- Bound `SHUTDOWN_TIMEOUT_MS` against drain + in-flight broker confirms + pool close + flush, or
  cancel publishes on abort.
- Telemetry endpoint with a trailing slash produces `//v1/traces`.
- `deploy/k8s/10-migrate.yaml` still runs the old `src/jobs/migrate.ts` (Plan 3 rewrites
  deployment).

## Can wait

- `lib`: lifecycle tests for the crash path, shutdown rejection and hard deadline; a crash during
  shutdown is logged as "second signal"; `int()` and `queryInt` coerce with `Number()` (accept
  `"0x10"`, `"1e1"`); `traced` marks only `AbortError` as cancelled (`TimeoutError` and shutdown
  aborts show as errors).
- `db`: transaction tests don't assert the same `err` is returned, a throw rolls back, or
  `traceparent` stamping; `insertRow` untested.
- `contracts`: thin tests (PageLimit, params, Problem); Slug's message only on the regex; `oneOf`
  has no options; `Problem` is defined in both `lib/problem` and `contracts`.
- `authz`: spans test covers only `authz.check`.
- `broker`: the claim runs outside a span; `observeOutbox` untested.
- `api`: `mail.send` spans are always OK (delivery swallows failures); the embedder's exception
  event may carry 512 B of provider body; a budget timeout keeps the abandoned handler's headers
  and no longer logs the external warning; every 4xx `HTTPException` maps to validation (only 400
  is reachable today); `/api/auth/*` accepts only GET and POST; unauthenticated `/api/v1` traffic
  isn't rate-limited before `session`; `@inferdi/hono` cleanup errors go to `console.error`;
  scripts hard-code log level, pool size and service names; the module raw-response regex flags
  any `x.json(` and misses split calls.
- CI runs on both push and pull_request.
