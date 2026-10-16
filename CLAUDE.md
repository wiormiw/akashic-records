# Akashic Records

A TypeScript API in a Bun monorepo: Bun 1.4, Hono, Valibot, Drizzle 1.0 rc, Postgres 17, OpenFGA,
InferDI. The design is in
[docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md](docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md);
read it once. Layout: `apps/api` (src, scripts, test) and `packages/{lib,db,contracts,authz,broker}`.

Bun is usually off PATH here: `export PATH="$HOME/.bun/bin:$PATH"`.

## Commands (from the repository root)

```
bun run dev            API with reload (needs postgres, redis, rabbitmq, openfga from compose)
bun run check          format:check, lint, typecheck, test: what CI runs
bun run format         oxfmt apps packages
bun run db:generate    migration from a schema change; never hand-edit packages/db/migrations/
bun run db:migrate / authz:push / authz:backfill / events:replay
bun run admin:grant <email> [--revoke]   make (or stop) someone a platform admin
bun run realm:centroids                  recompute each realm's fit centroid from its postings
```

## Rules

- **Nothing runs on import.** Files export factories; `container.ts` constructs everything and
  `main.ts` alone starts the process (`Bun.serve`, `handleSignals`).
- **Only `container.ts` imports InferDI** (`@inferdi/inferdi`, any subpath, in `src`, `scripts` and
  `test`). Nothing is resolved per request: routes close over services built at startup, and
  read the request id, caller and signal from `c.var`. A module never imports another module, by alias,
  relative path, side-effect or dynamic import. Code under `src/modules/` never builds a raw
  response (`x.json(`, `.body(`, `new Response(`). Only `main.ts` calls `Bun.serve` or
  `handleSignals` (also checked in `scripts` and `packages/*/src`).
  `apps/api/test/structure.test.ts` enforces all of this.
- **A module folder holds role files only**: `<m>.module.ts`, `<m>.service.ts` (or
  `<m>.<area>.service.ts` when one passes ~350 lines), `<m>.routes.ts`, `<m>.consumer.ts`,
  `<m>.types.ts`, and later `<m>.grpc.ts` / `<m>.graphql.ts` for other transports. Queries and pure
  rules live in the service that uses them, exported, tested in its test file. Every exported
  function names its parameter and result types (in `<m>.types.ts`, or `@akashic/contracts` for
  wire shapes); inline object types only for local, unexported shapes. Tests mirror the files.
  `structure.test.ts` enforces the file names and the named types (a text heuristic). Spec:
  "Inside a module" in `docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md`.
- **Routes validate first, then guard, per route.** `validate(...)` comes before `realmContext`,
  `requireModule` and `requirePermission`, so a malformed request is a 400 for everyone. The
  exception is the admin surface (`/admin/*`, `/admin/proposals`): `platformAdmin` runs first
  there, so anyone else gets the router's own 404, malformed request or not. Guards go on each route, never `use`d on a shared prefix. Transports (routes,
  consumers, later grpc/graphql) call services and hold no business logic.
- **Shared test support lives in `test/support/`** (`fixtures.ts`: `person`, `uniqueSlug`,
  `outbox`; `app.ts`: the fake-authorizer route scaffold). A module's own `world()` stays in its
  `test/modules/<m>/fixtures.ts`. `test/contract.test.ts` holds every response view to the web
  app's schemas (`test/fixtures/web-schemas.ts`, deleted in Plan 3): add a new view there.
- **One error funnel.** Services return `err(...)` Results; routes hand them to `reply` (success,
  through a view) or `respond`, and `http/problem.ts` renders errors.
  `throw` is for bugs and infrastructure failing. Inside `inTransaction`, return the `err`: it
  rolls back.
- **Events and audits only inside `inTransaction`**, via `publish(tx, ...)` and `audit(tx, ...)`.
  Every membership change publishes `realm.member_changed`, or OpenFGA drifts from Postgres.
- **Outbox handlers are idempotent.** Write the complete answer, don't apply a delta. The outbox
  is only for a database change whose lost side effect would be a bug (authz sync, mail); not for
  background work in general (spec "Outbox policy").
- **Realm-scoped actions check the realm.** An id in the body or path must belong to the realm in
  the URL; otherwise a member of one realm can act in another.
- **Comments say why, briefly.**
- **One code style, the web app's:** tabs, single quotes, 100 columns (`.oxfmtrc.json`);
  `bun run format` applies it.

## Testing

`bun test`. Unit tests use in-memory fakes. Integration tests run against the real database,
OpenFGA and RabbitMQ; each skips when nothing answers. The database holds real dev data: a test
writes inside `withRollback` (`@akashic/db/testing`), so nothing it creates persists. The exception
is race tests, which need several connections: they commit uniquely named rows and delete exactly
those. Migrations are generated with `cd packages/db && bunx drizzle-kit generate`; CI fails if
they differ from the schema.

## Traps already hit

1. **Stored values are the data's.** Enum numbers and code strings are on the wire and in rows;
   check before renumbering or renaming. Codes are never renamed.
2. **Drizzle on bun:sql expands a JS array into a parameter list.** Bind arrays with `pgArray()`
   and vectors with `pgVector()`.
3. **Backslashes don't survive this shell's heredocs.** Write regex-bearing files with an editor
   tool, not `cat <<EOF`.
4. **A GitHub Actions service can't be given a command**, so CI starts OpenFGA with `docker run`.
5. **Cookies are scoped by host, not port.** The cookie prefix is `akashic`, distinct from
   animerec's, or the two apps sign each other out on localhost.
6. **Windows Bun can't see Git Bash's `/tmp`**, and a killed dev server can linger on its port:
   stop it by port with PowerShell.
7. **`v.object` strips undeclared keys on parse**; that's what `reply` relies on. Don't switch
   views to `looseObject`. The one exception is `ReadinessView` in `http/meta.ts`: readiness
   reports a variable set of checks, so it keeps the extra keys.
8. **Bun SQL queries are lazy thenables**: `expect(query).rejects` hangs. Wrap it in
   `Promise.resolve(query)`.
9. **OTel ignores a second global registration in one process.** Tests use `recordSpans()` from
   `@akashic/lib/testing`, which registers once; reset it in `beforeEach`.
10. **`owned()` composes with an existing disposer.** Wrap only the extra release; never re-call
    the inner disposer.
11. **Hono drops headers set with `c.header` when a bare `new Response` is returned.** Problem
    responses use `c.newResponse`.
12. **Drizzle 1.0 names constraints `_pkey` / `_fkey`.**
13. **There is no request scope.** Every route group uses `AppEnv`; per-request values are on
    `c.var` and go to services as arguments.
