# Akashic Records monorepo: design

Date: 2026-10-13. Status: approved.

## Why

The current API (`akashic_records_be`) is Elysia with TypeBox, organised as ports, adapters and a
unit of work. Two problems came out of months of work on it:

- Elysia couples too much to itself, down to schema definitions, so the HTTP contract can't be
  shared or reused outside it.
- The ports/adapters layering costs more than it returns at this size. Every query is written
  twice (an interface and an implementation), and every service reaches the database through a
  repository and a unit of work it doesn't need.

The frontend (`akashic_records_fe`, SvelteKit) validates every response with its own Valibot
schemas, kept in sync with the backend by hand. A field the backend dropped went unnoticed until
a manual audit.

## Goal

One repository, `akashic-records`, holding the API and the web app, with:

- Hono and Valibot in place of Elysia and TypeBox.
- Services that call Drizzle directly. No repository layer, no ports, no unit of work.
- InferDI as the composition root: it builds the object graph, owns lifecycle and shutdown, and
  gives each request a scope.
- One set of Valibot contract schemas imported by both the API and the web app.
- Full feature parity with the current API before the old repositories are retired.
- Independent deploys: web on Vercel, API on a VPS.

Success means: every current endpoint, event, job and test behaviour exists in the new repository;
`apps/web` uses the shared contracts, so a response field change that breaks it fails its
typecheck; and either app can be deployed without the other.

## Decisions already made

| Topic | Decision |
| --- | --- |
| HTTP | Hono 4 on Bun (`hono/bun`, including WebSockets) |
| Validation | Valibot 1, through `@hono/standard-validator` |
| ORM | Drizzle **1.0 beta**: `drizzle-orm/valibot` for row schemas, `defineRelations` for relations. Beta risk accepted; upgrade as it moves. |
| Data access | Services call Drizzle directly |
| Composition | InferDI (`@inferdi/inferdi`, `@inferdi/hono`) |
| Repo | New repository with a clean history; old repositories frozen as references |
| Frontend | Moves in as `apps/web` |
| Migrations | One fresh baseline, after a `pg_dump` of the current database |
| Scope | Full parity, ported module by module |
| Commits | Trailer is `Co-Authored-By: Claude <noreply@anthropic.com>` |

## Layout

```
akashic-records/
  apps/
    api/
      src/
        container.ts        the only file that imports InferDI
        main.ts             build the container, start, handle signals, shut down
        app.ts              the Hono app: middleware, then each module's routes
        http/               middleware: request context, problem rendering, security,
                            rate limit, session, realm context; reply() and respond()
        integrations/       api-only third parties: mail (Resend), storage (S3), embedder,
                            Redis counters
        modules/<name>/     <name>.routes.ts, <name>.service.ts, plus domain rules such as
                            governance.rules.ts, room.tickets.ts, postings.fit.ts
      scripts/              import.meta.main jobs: migrate, authz push and backfill, admin
                            grant, realm centroids, events replay
      test/
      Dockerfile
    web/                    SvelteKit, moved from akashic_records_fe
  packages/
    db/          tables, defineRelations, row schemas, createDb(), migrations, drizzle config
    contracts/   Valibot request and response schemas, and the presenters that fill them
    lib/         Result, errors and codes, enums, time, logging, abort and lifecycle helpers,
                 outbox and audit writers
    authz/       createAuthorizer() and the OpenFGA model
    broker/      createBroker(), the outbox dispatcher, the event consumer
  docs/
  compose.yaml   postgres, redis, rabbitmq, openfga for development
```

Module names stay as today: realm, events, postings, comments, governance, room, upload, admin.

### What earns a package

A package exists when a second consumer needs it or a hard boundary is worth having:

- `contracts`: imported by `apps/api` and `apps/web`.
- `db`, `authz`, `broker`: what a second process would need. Running the outbox dispatcher and
  consumers as their own `apps/worker` later should mean a new app, not a refactor.
- `lib`: shared helpers with no single owner.

Mail, storage, the embedder and Redis are used only by the API, so they live in
`apps/api/src/integrations/`. Modules stay folders, never packages.

### Package rules

- Packages export factories and pure functions. Nothing connects, reads the environment or
  starts a timer on import.
- A package imports only what its `package.json` declares. `contracts` depends on `valibot` and
  two dependency-free subpaths of `lib`, `@akashic/lib/enums` and `@akashic/lib/errors`, so the
  web app never pulls in Drizzle, OpenFGA, logging or lifecycle code.
- Inside `apps/api`, modules never import each other. Something two modules need goes into a
  package or into `http/`. A small test in `apps/api/test/` checks this.

## Data

`packages/db` holds the Drizzle 1.0 schema, ported table for table. **Table and column names do
not change**, so a data-only dump of the current database restores into the new baseline.

- `defineRelations` declares relations, and the relational query API (`db.query.*`) is available
  to services alongside the query builder.
- `drizzle-orm/valibot` generates `createSelectSchema` and `createInsertSchema` for each table.
  These describe rows, not the API; response views in `contracts` pick from them or are written
  out, never the raw row.
- Array and vector binding keep their helpers (`pgArray`, `pgVector`) if Drizzle 1.0 on `bun:sql`
  still expands a JS array into a parameter list. This is checked during the port, not assumed.
- Enum values stored as numbers and string codes on the wire never change.

### Migration of data

1. `pg_dump` the current development database (schema and data) to a file outside the
   repository, and record where it is.
2. Generate one baseline migration from the new schema.
3. Recreate the database from the baseline.
4. Restore data with a data-only dump. If restore fails because a table changed during the port,
   that's a sign the "names do not change" rule was broken, and gets fixed in the schema.

## Composition and lifecycle

`apps/api/src/container.ts` registers everything with its lifetime:

- **Singletons:** config, telemetry (right after config, disposed last), logger, the root `AbortController`, db, redis, broker, authorizer,
  mailer, storage, embedder, and the services.
- **Request scope** (through `@inferdi/hono`, at `c.var.di`): request id, the session user, and
  the request's abort signal. A service that needs these can only be resolved once the scope
  supplies them, and the compiler checks it.

Services receive their dependencies as arguments: a plain function or a factory taking `{ db,
authz, ... }`. No service imports InferDI, so swapping the container later touches one file.

### Abort signals

One root `AbortController` is a singleton. Each request's signal is
`AbortSignal.any([root.signal, request.signal, AbortSignal.timeout(deadline)])`. Passing it to
OpenFGA, fetch calls, the broker and the embedder works as it does today. Drizzle still takes no
signal; Postgres statement timeouts stay the backstop.

### Startup

Order: config, telemetry, logger, db (ping), redis, broker (connect, declare topology), authorizer, services,
outbox dispatcher, consumers, HTTP server. InferDI's async initialisation runs these as the graph is
built. If any step fails, everything already created is disposed and the process exits non-zero.

### Shutdown

Triggered once by SIGTERM or SIGINT:

1. Readiness returns 503, so a load balancer stops sending traffic.
2. The server stops accepting connections. In-flight requests get a drain window.
3. The root controller aborts. Requests still running, the dispatcher and the consumers see it.
4. Consumers finish or requeue the message in hand. The dispatcher's lease expires naturally.
5. The container is disposed with `await using`: InferDI releases resources in reverse creation
   order (broker, redis, db), then telemetry is flushed.

A hard-exit timer bounds the whole sequence. A second signal exits at once.

## Request path

```
request
  request context   request id, deadline signal, access log
  security          CORS, headers, body size, Origin check on writes
  rate limit        per user once known, else per IP (Redis counters)
  session           better-auth session and ban check
  di scope          @inferdi/hono: a request scope with id, user, signal
  realm context     realm, modules, role, permissions -> requireModule, requirePermission
  validator         sValidator(target, schema from contracts)
  route             calls the service, then reply() or respond()
```

## Errors

- `Result`, `ok`, `err` and `fail.<kind>(code, message)` move to `packages/lib` unchanged. Error
  codes never change.
- `app.onError` renders anything thrown as `application/problem+json`, as `http/problem.ts` does
  today.
- `respond(c, result, view, status)` renders an `err` the same way, and an `ok` through `reply`.
- A validation failure from `sValidator` renders as the same `common.validation` problem.
- `throw` stays for bugs and infrastructure failing.

## Responses

Hono doesn't check outgoing responses, so every route sends through
`reply(c, View, value, status)`. It parses the value with the view's Valibot schema:

- `v.object` drops keys the view doesn't declare, so a column added to a query never reaches the
  wire by accident.
- A stored enum outside its range, or a value of the wrong type, throws instead of being sent.

Presenters live in `contracts` next to their views and turn service results into view input
(instants to ISO strings, stored numbers to enum members). A test in `apps/api` checks that no
route calls `c.json` directly.

## Transactions, outbox and audit

- `inTransaction(db, async (tx) => ...)` in `lib` wraps `db.transaction`. Returning an `err`
  rolls back and hands the `err` back, as `uow.run` does today.
- `publish(tx, events)` and `audit(tx, entry)` accept only the transaction type, so writing an
  event or an audit entry outside a transaction is a type error.
- Every membership change still publishes `realm.member_changed`, or OpenFGA drifts from Postgres.
- Outbox statuses (PENDING, PUBLISHED, DEAD), leases and retries carry over unchanged in
  `packages/broker`. Handlers stay idempotent.
- Realm-scoped actions still check that an id in the body or path belongs to the realm in the URL.

## Testing

- **Pure rules** (governance thresholds, ticket parsing, posting fit, retention agreement): plain
  unit tests.
- **Services and routes:** against real Postgres. Each test builds the container with InferDI's
  typed overrides: `db` becomes a transaction that's rolled back afterwards. Tests are isolated
  and may run in parallel. Routes are exercised with `app.request(...)`.
- **Third parties** (OpenFGA, RabbitMQ, S3, mail, embedder) are overridden with fakes in service
  and route tests. Their own integration tests hit the real service and skip when it isn't
  running.
- **Contracts:** `apps/web` typechecks against `packages/contracts`. Drift is a type error.
- **Structure:** one test in `apps/api` checks modules don't import each other and routes don't
  call `c.json` directly. Package boundaries are enforced by each `package.json`.
- `bun run check` at the root runs format, lint, typecheck and tests for every workspace, as CI
  does.

## Deployment

The two apps deploy independently from the same repository.

### API on a VPS

- `apps/api/Dockerfile` builds from the repository root (so workspace packages resolve) and
  installs only the API's dependency tree.
- The image runs `bun apps/api/src/main.ts`. Migrations run as a release step
  (`bun apps/api/scripts/migrate.ts`) before the new container takes traffic.
- Postgres, Redis, RabbitMQ and OpenFGA run beside it with compose, as now.
- Graceful shutdown makes `docker stop` and rolling restarts safe.
- A GitHub Actions workflow builds and ships the image only when `apps/api/**`,
  `packages/{db,lib,authz,broker,contracts}/**` or the lockfile change.

### Web on Vercel

- The adapter is chosen per build, not fixed: `adapter-vercel` when `process.env.VERCEL` is set
  (Vercel sets it during its builds), `adapter-node` otherwise, so local runs, a container, a VPS
  or Kubernetes get a Node server. An explicit `ADAPTER` variable overrides the choice, so another
  host later is a config change, not a code change.
- The Vercel project's root directory is `apps/web`. Vercel installs the workspace, so
  `packages/contracts` resolves.
- An ignored-build-step command skips a deploy unless `apps/web/**`, `packages/contracts/**`,
  `packages/lib/**` or the lockfile changed.
- The web app is a backend-for-frontend: the browser talks only to SvelteKit, which calls the API
  server to server with `PUBLIC_API_BASE`. Session cookies live on the web domain, so no
  cross-site cookie setup is needed.
- The room WebSocket connects to the API directly with a ticket. The CSP `connect-src` gains the
  API's `wss://` origin.
- Put the Vercel functions' region close to the VPS, since every page load makes server-to-server
  calls.

### Keeping split deploys compatible

Because the two apps ship at different times, the API must stay compatible with the web app
already running:

- Add fields before the web app reads them. Remove a field only after the deployed web app no
  longer reads it.
- Valibot's `v.object` ignores keys it doesn't declare, so an API that sends more is always safe.
- For an additive change, deploy the API first. For a removal, deploy the web app first.

## Configuration and secrets

- Each app validates its environment at startup and refuses to start when a required variable is
  missing or malformed, as `config.ts` does today. A bad secret fails the deploy, not a request.
- **Web:** variables live in the Vercel project, separately for Production and Preview. The app
  reads `$env/dynamic/public`, so changing `PUBLIC_API_BASE` needs no rebuild.
- **API:** secrets live in a GitHub Environment named `production`, which can require approval
  before a deploy. The deploy workflow builds the image, pushes it to GHCR, writes
  `/opt/akashic/.env` on the VPS over SSH with mode 600, and restarts the stack with compose.
- Non-secret defaults are committed in `.env.example` files. Real values never are.
- When there are several environments or several people, secrets move to Infisical or Doppler,
  which sync to GitHub, Vercel and Kubernetes. Nothing in the apps changes for that.
- No Jenkins: GitHub Actions covers building, testing and deploying both apps.

## Telemetry

- `@hono/otel`'s `httpInstrumentationMiddleware` creates a span per request.
- The OpenTelemetry SDK (traces and metrics over OTLP) is created right after config, before
  anything that records spans, and is the **last** thing the container disposes, so spans recorded during shutdown are flushed. It is not
  started at module top level.
- Node auto-instrumentation is not used: on Bun it is partial and nothing instruments `bun:sql`.
  Custom spans cover what it would have, through one helper, `traced(name, attributes, fn)` in
  `packages/lib`. It starts an active span, records an exception and sets error status when `fn`
  throws, marks an `err` Result as an error with its code as an attribute, and always ends the
  span. Spans are created for:
  - each transaction (`db.transaction`), with the module and operation as attributes;
  - OpenFGA checks, writes and deletes (`authz.check`, `authz.write`);
  - the outbox: claiming a batch, publishing one event (a `PRODUCER` span that injects
    `traceparent` into the message headers), and marking it published or failed;
  - RabbitMQ consumption: a `CONSUMER` span continuing the incoming `traceparent`;
  - outgoing calls: mail send, storage put and delete, embedder requests;
  - service operations that span several steps (approving a proposal, carrying a recall), so a
    trace shows the business step and not only the queries under it.
- Span names and attributes follow OpenTelemetry semantic conventions where one exists
  (`messaging.*`, `db.*`, `http.*`); otherwise `akashic.*` (for example `akashic.realm.id`).
  Personal data (emails, message bodies, names) never goes into an attribute.
- Metrics alongside: outbox backlog and dead count, consumer retries and parks, and HTTP
  request duration from `@hono/otel`.
- Logs are pino JSON on stdout with the trace id attached, for whatever collects them.
- The exporter endpoint is configuration: Grafana Cloud's OTLP endpoint in production, a local
  `grafana/otel-lgtm` container in development.

## Infrastructure

At launch, one VPS (about 4 vCPU and 8 GB) runs the API, Postgres, Redis, RabbitMQ and OpenFGA
with compose. Two things stay off it:

- **Backups:** a nightly `pg_dump` plus WAL archiving (`wal-g`) to S3-compatible storage. A
  restore is rehearsed once before launch.
- **Observability:** telemetry goes to Grafana Cloud's free tier, or to `grafana/otel-lgtm` on a
  second small VPS, so the box that fails isn't the box you'd use to see why.

Uploaded images already go to S3-compatible storage, not the VPS disk.

## Scaling out

The same image runs on the VPS and on Kubernetes with several pods. What makes that safe:

| Concern | How several pods stay correct |
| --- | --- |
| Sessions | In Postgres through better-auth; any pod serves any user |
| Rate limits | Redis counters, shared by all pods |
| Room WebSocket | Messages go through the Redis pub/sub relay, so they reach sockets on other pods. The in-process relay is for development only. |
| Outbox dispatcher | Safe on every pod: leases are claimed with `SKIP LOCKED` |
| Consumers | Competing consumers on one queue; handlers are idempotent |
| Migrations | A Job before the rollout, never on pod start |
| Shutdown | A `preStop` sleep of a few seconds so endpoints are removed, then our SIGTERM sequence; `terminationGracePeriodSeconds` exceeds drain plus hard-exit time |
| Probes | `/health` for liveness, `/ready` for readiness, 503 while draining |
| Config | ConfigMap and Secret, the Secret synced from the secret manager by External Secrets |
| Database connections | Pods times pool size stays under `max_connections`; PgBouncer in front of Postgres |
| Scaling | API on CPU or request rate; `apps/worker` split out and scaled on queue depth (KEDA) |
| Data services | Managed, or CloudNativePG; not hand-written StatefulSets |

Kubernetes manifests are not written now; this table is what the code must keep true so that
adding them later needs no code changes.

## Porting order

Each step is its own commit, with its tests, and leaves `bun run check` green.

1. Workspace: Bun workspaces, TypeScript config per package, oxlint and oxfmt, root `check`,
   compose file, CI skeleton.
2. `packages/lib`: Result, errors, enums, time, logging, abort and lifecycle helpers.
3. `packages/db`: schema on Drizzle 1.0, relations, row schemas, `createDb`. Back up the current
   database, generate the baseline, restore data.
4. `packages/contracts`: shared building blocks (timestamps, ids, pagination, problem shape).
   Module views arrive with their modules.
5. `apps/api` skeleton: container, `main.ts` lifecycle, HTTP middleware, better-auth, meta routes
   (health, readiness, mail status), `reply` and `respond`.
6. `packages/authz`: authorizer and model, plus the push and backfill scripts.
7. `packages/broker`: broker, outbox writer and dispatcher, consumer, the replay script.
8. Modules, one commit each: realm, events, postings, comments, governance, room (including the
   WebSocket), upload, admin. Each brings its views and presenters into `contracts`.
9. Remaining scripts: admin grant, realm centroids.
10. `apps/web`: moved in, its `src/lib/api/*` schemas replaced by imports from `contracts`,
    adapter chosen per build.
11. Deployment: API Dockerfile and workflow, Vercel configuration, ignored-build step.
12. Docs: `README.md`, `docs/ARCHITECTURE.md` and `CLAUDE.md` for the new layout.

The old repositories stay untouched throughout. Nothing is pushed until the user has created the
empty `wiormiw/akashic-records` repository on GitHub.

## Out of scope

- New features or behaviour changes, apart from the switch to Hono and the frontend's adapter
  selection.
- Kubernetes manifests, PgBouncer and the secret manager. The design keeps them possible.
- Splitting out `apps/worker`. The layout allows it; it isn't done now.
- Hono RPC (`hc`). The shared Valibot contracts cover type-safe calls for now.

## Risks

- **Drizzle 1.0 beta** may change APIs between betas. Pin the exact version, upgrade on purpose.
- **InferDI** is young (first release May 2026, now on major version 6). Pin it. Only
  `container.ts` imports it, which keeps a replacement cheap.
- **Integration tests need Docker.** Service and route tests run against real Postgres, so they
  can't run while Docker is down. Pure unit tests still run.
- **Vercel to VPS latency** adds to every server-rendered page. Mitigated by choosing the region.
