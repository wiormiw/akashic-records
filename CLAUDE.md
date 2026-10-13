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
```

## Rules

- **Nothing runs on import.** Files export factories; `container.ts` constructs everything and
  `main.ts` alone starts the process (`Bun.serve`, `handleSignals`).
- **Only `container.ts` imports InferDI** (`@inferdi/inferdi`, any subpath, in `src`, `scripts` and
  `test`); only `app.ts` imports `@inferdi/hono`. A module never imports another module, by alias,
  relative path, side-effect or dynamic import. Code under `src/modules/` never builds a raw
  response (`x.json(`, `.body(`, `new Response(`). Only `main.ts` calls `Bun.serve` or
  `handleSignals` (also checked in `scripts` and `packages/*/src`).
  `apps/api/test/structure.test.ts` enforces all of this.
- **One error funnel.** Services return `err(...)` Results; routes hand them to `reply` (success,
  through a view) or `respond`, and `http/problem.ts` renders errors.
  `throw` is for bugs and infrastructure failing. Inside `inTransaction`, return the `err`: it
  rolls back.
- **Events and audits only inside `inTransaction`**, via `publish(tx, ...)` and `audit(tx, ...)`.
  Every membership change publishes `realm.member_changed`, or OpenFGA drifts from Postgres.
- **Outbox handlers are idempotent.** Write the complete answer, don't apply a delta.
- **Realm-scoped actions check the realm.** An id in the body or path must belong to the realm in
  the URL; otherwise a member of one realm can act in another.
- **Comments say why, briefly.**

## Testing

`bun test`. Unit tests use in-memory fakes. Integration tests run against the real database,
OpenFGA and RabbitMQ; each skips when nothing answers. Migrations are generated with
`cd packages/db && bunx drizzle-kit generate`; CI fails if they differ from the schema.

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
   views to `looseObject`.
8. **Bun SQL queries are lazy thenables**: `expect(query).rejects` hangs. Wrap it in
   `Promise.resolve(query)`.
9. **OTel ignores a second global registration in one process.** Tests use `recordSpans()` from
   `packages/lib/test/spans.ts`, which registers once; reset it in `beforeEach`.
10. **`owned()` composes with an existing disposer.** Wrap only the extra release; never re-call
    the inner disposer.
11. **Hono drops headers set with `c.header` when a bare `new Response` is returned.** Problem
    responses use `c.newResponse`.
12. **Drizzle 1.0 names constraints `_pkey` / `_fkey`.**
13. **Module routes use `ApiEnv`** (request scope at `c.var.di`); root routes use `AppEnv` and
    have no scope.
