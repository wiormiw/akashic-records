# Plan 2 follow-ups

What the module port's reviews deferred, and what Plan 3 (web app, deployment) must know. Written
from the execution ledger when Plan 2 finished (2026-10-15).

## Open decision before merging `feat/modules`

**Role changes after ruling R14.** The fix that stops a moderator demoting an admin also made two
legitimate actions impossible:

- **A realm admin can no longer demote another admin.** The old API allowed it, and it never left
  a realm without an admin, since an admin can't change their own role. There is also no
  platform route that removes a realm admin. Recommended fix: allow an admin to change another
  admin's role, locking both `realm_member` rows `FOR UPDATE` in id order and re-checking that
  the actor is still an admin, so two admins demoting each other at once can't leave none.
- **A platform admin who isn't a realm member gets 403 on role changes.** `model.fga` still gives
  them `can_vouch` (`admin from platform`), so the route guard lets them through and the service
  refuses. Pick one: treat a platform admin as an admin in `changeRole`, or drop
  `admin from platform` from `can_vouch`.

## Before the first production deploy

- The broker-level 413 (`maxRequestBodySize`) is a bare response: no problem+json body, no
  request id, no CORS headers. A browser uploading straight to the API sees a network error.
  Check the size in the web app before sending, or raise the margin.
- Declaring the broker topology can wait on rabbitmq-client's channel acquisition (20 s by default)
  when the broker is unreachable, which outlasts `SHUTDOWN_TIMEOUT_MS`. Tie `prepare` to the
  abort signal.
- `POST /realms` (founding) still validates before `platformAdmin`, so a malformed request from a
  non-admin shows the route exists (R15 covered `/admin/*` only).
- Moderator actions without an audit entry: comment removal, fit-review takedown, a moderator's
  job or listing status change.
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

- `changeRole` trusts the actor's role as read at request start; only the target row is locked.
- In a members' recall, a non-member passes `mayTakePart` (unchanged).
- The first RSVP's `respondedAt` comes from the database default, not the injected clock. Column
  defaults stay database time everywhere.
- Realm context runs its lookups in parallel (two pool connections per realm request).
- No index serves the outbox prune; the prune runs before the claim once an hour.
- No concurrency tests for the approve and sole-admin row locks.
- The comment-thread check runs outside the transaction, and removing twice overwrites
  `removedAt`.
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
