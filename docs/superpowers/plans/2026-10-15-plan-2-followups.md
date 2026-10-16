# Plan 2 follow-ups

What the module port's reviews deferred, and what Plan 3 (web app, deployment) must know. Written
from the execution ledger when Plan 2 finished (2026-10-15).

## Settled before merging `feat/modules` (2026-10-16)

**Role changes (R14, refined).** Two levels of admin: the platform admin is the app's superadmin,
a realm admin runs one realm. As built in `changeRole`:

- The route decides platform authority (`sessions.isPlatformAdmin`, `Relation.platform.administer`
  on `PLATFORM_ID`) and passes it on the actor; the service makes no authorizer call. A platform
  admin acts as an admin of every realm, member or not. `can_vouch` keeps `admin from platform`.
- An admin changes anyone's role, a fellow admin's included. Below admin, you change only someone
  ranked below you, and grant only a role below your own and below moderator. Nobody changes their
  own role.
- A realm never ends with zero admins (`realm.sole_admin`, 409). One `SELECT ... FOR UPDATE`, in
  user id order, locks the actor's row, the target's and every admin's; the actor's rank and the
  admin count are read under that lock, so two admins demoting each other at once leave exactly
  one (`realm.role-race.test.ts`).

**Also decided:**

- R9 stays as built: a non-member gets 403, by decision.
- Comment removal (R8): the comment's author or a moderator of its realm (`comment#can_delete`);
  a moderator removing someone else's comment is audited, once (removing it again changes
  nothing). The object check runs before the service, so for anyone who isn't a moderator there,
  DELETE answers 403 for an id that doesn't exist and for a comment of another realm (404 only
  once the check passes). An author gets 403 until the consumer has written their `author` tuple:
  eventual consistency, as with postings.
- Money (R12): `budget_cents` and `price_cents` are `bigint`, capped at `Number.MAX_SAFE_INTEGER`
  on the way in.
- Timeouts (R2) are errors in traces (`error.type = "timeout"`); a shutdown abort stays cancelled.
- Code style is the web app's: tabs, single quotes, 100 columns.
- The Result library becomes its own plan.

## Before the first production deploy

- A request cut off by shutdown renders as a 500 today. It should be a 503 with `Retry-After`,
  which needs a new `unavailable` error kind (and keeps the server span from reading as an error).
- The broker-level 413 (`maxRequestBodySize`) is a bare response: no problem+json body, no
  request id, no CORS headers. A browser uploading straight to the API sees a network error.
  Check the size in the web app before sending, or raise the margin.
- Declaring the broker topology can wait on rabbitmq-client's channel acquisition (20 s by default)
  when the broker is unreachable, which outlasts `SHUTDOWN_TIMEOUT_MS`. Tie `prepare` to the
  abort signal.
- `POST /realms` (founding) still validates before `platformAdmin`, so a malformed request from a
  non-admin shows the route exists (R15 covered `/admin/*` only).
- Moderator actions without an audit entry: fit-review takedown, a moderator's job or listing
  status change.
- Mail payloads (address and reset link) sit in `outbox_messages`, RabbitMQ and the dead queue.
- Pin `openfga/openfga` in compose and CI.

## Plan 3 must decide

- **Contracts in the web app:**
  - `common.ts` and `events-api.ts` use the global `Temporal` type; check `svelte-check` early, or
    give presenters a separate subpath.
  - The index exports server-only names (`realmEvents`, `mailRequested`, `RoomFrameLimits`):
    consider a separate `@akashic/contracts/events` export.
  - Use one Valibot version across the workspace (contracts pins 1.5.0, the web declares ^1.4.2).
- **Split deploys:** the web app parses with loose schemas today. Once it parses with contracts'
  enum and picklist views, an API that adds an enum value breaks an older web build. Decide
  whether the web parses with tolerant views.
- Delete `apps/api/test/fixtures/web-schemas.ts` and the per-module web-schema copies once the web
  app imports contracts; the contract test then compares one source.
- Add MinIO to compose and CI so the storage round-trip test runs.

## Can wait

- In a members' recall, a non-member passes `mayTakePart` (unchanged).
- The first RSVP's `respondedAt` comes from the database default, not the injected clock. Column
  defaults stay database time everywhere.
- `leave` trusts the role read at request start: an admin demoted while leaving can be refused as
  the sole admin.
- Realm context runs its lookups in parallel (two pool connections per realm request).
- No index serves the outbox prune; the prune runs before the claim once an hour.
- No concurrency test for the approve lock.
- The comment-thread check runs outside the transaction.
- Duplicated helpers across modules (`roleOf`/`isMember`, `person`, `castVote`); two query styles
  (raw `db.execute` rows and the typed builder).
- Governance enums typed as `number` in contracts (`SeatStanding.role`, `Takedown.subjectKind`).
- Room: the live socket frame isn't parsed with the web schema in tests; no cross-room delivery
  test; a blocked user is admitted at upgrade (send refuses); swap `hono/bun` for `@hono/bun`
  before Hono 5.
- Upload: no test that a refused upload leaves the hourly budget unspent.
- Contract test: its guard keys on the `*View` naming; three thin web schemas are labelled
  inventions.
- Structure rules: validate-before-guards and guards-per-route aren't enforced; the named-type
  rule is a regex heuristic.
- Scripts hard-code log level, pool size and service names.
- `/admin/` with a trailing slash no longer matches (the web app calls `/admin`).
- Tests that commit rows (broker outbox integration, race tests) can be claimed by a running
  `bun run dev` dispatcher.
