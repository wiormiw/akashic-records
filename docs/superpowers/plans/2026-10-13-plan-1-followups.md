# Plan 1 follow-ups

What the foundation's reviews deferred, and what Plan 2 must decide first. Written from the
execution ledger when Plan 1 finished (2026-10-13); the ledger itself was scratch.

## Plan 2 must decide before the first module

1. **How a service gets `db`.** `database` is an async registration, so anything depending on it
   is async too. Pick one: resolve every service in `start()`; register a sync `db` derived from
   the resolved `database`; or build module routes inside `start()` from resolved services.
   Document it in `container.ts`.
2. **How module routes are built.** `start(container, modules)` takes prebuilt `ModuleRoutes`;
   `main.ts` passes none yet.
3. **A rollback test harness.** Override `database` so `db` is a transaction rolled back after each
   test. `Tx` is deliberately not a `Db`, so the harness needs an `Executor`-typed path or a cast.
4. **Consumers.** Wire them as owned registrations after the outbox; choose their disposal order
   deliberately (the old code stopped publishing before consuming). On a shutdown abort, requeue
   instead of counting a retry, and make `withConsumerSpan` treat an abort as cancelled.
5. **Room WebSocket.** `listen()`/`main.ts` need `hono/bun`'s websocket handler, and
   `relay.start(deliver)` must be called with `server.publish`.
6. **Realm context middleware** (old `http/realm.ts`: realm, modules, role, permissions,
   `requireModule`, `requirePermission`) moves into `http/` before the first realm-scoped module.
7. **Admin routes** would run `session` twice (group middleware plus `platformAdmin`). Give admin
   its own mount group, or have `platformAdmin` reuse `c.get("user")`.
8. **Move `ApiEnv`** from `app.ts` to `http/env.ts` with a structural `di` type, so module routes
   depend only on `http/`. Export lib's test helpers as `@akashic/lib/testing`.
9. **`trimmed` measures `maxLength` after trimming**; the old TypeBox schemas measured before.
   Decide per field when porting each request schema.
10. **Still to port:** the retention sweep, `admin:grant`, `realm:centroids`.
11. **Scrub error messages in `traced`** before services write user data: Postgres unique-violation
    messages contain values (emails) and would land in exception events.

## Before the first production deploy

- `observeOutbox` counts the whole `outbox_messages` table every export, and published rows are
  never deleted. Use the partial index (`status = 0` literal), count dead rows differently, or add
  retention for published rows.
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
