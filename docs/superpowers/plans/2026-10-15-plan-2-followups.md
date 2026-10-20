# Plan 2 follow-ups

What the module port's reviews deferred, and what Plan 4 (web app) and Plan 5 (deployment) must
know. Written from the execution ledger when Plan 2 finished (2026-10-15); updated when Plan 3
(typed errors and hardening) closed (2026-10-17).

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

## Settled by Plan 3 (2026-10-17)

- **Typed errors.** The Result library is in `@akashic/lib/result`; every error is a
  `defineError` class carrying its kind and code; `fail` is gone and `Result`'s error type is
  required. `realm.not_member` became three classes (`MemberNotFound` 404, `NoSeatInRealm` 400,
  `NotBothMembers` 403), each keeping its old wire answer.
- **Shutdown answers 503** `common.request.unavailable` with `Retry-After: 5`, logged at info.
- **Oversized uploads** get a 413 problem response from a route-level body limit, with CORS and
  request-id headers; Bun's `maxRequestBodySize` is a backstop at twice that.
- **Topology preparation** races the abort signal, so shutdown never waits on channel acquisition.
- **`POST /realms`** runs `platformAdmin` before `validate`, as `/admin/*` does.
- **Moderator actions are audited:** fit-review takedowns (only when they change something) and a
  moderator's status change to someone else's job or listing.
- **OpenFGA is pinned** to `v1.21.0` by digest in compose and CI.
- **Lock edges.** `leave` locks `role = admin OR user_id = <self>` in one sorted statement and checks
  the sole admin on the locked role. `removeModerator` re-checks the subject's role under the lock
  and refuses an admin. A recall whose subject no longer holds a seat at the deciding vote resolves
  `refused` (R7); the recall row is locked `FOR NO KEY UPDATE` so vote inserts don't deadlock on it.
- **Polish:** the comment thread-open check runs inside the add, under `FOR SHARE` on the posting;
  the first RSVP's `respondedAt` comes from the injected clock; `SeatStanding.role` and
  `Takedown.subjectKind` are the enum types; room socket tests parse frames with the web schema and
  check one room's messages don't reach another; a test shows refused uploads leave the hourly
  budget unspent; every script loads its environment as `v.pick(Env, ...)`.
- **Structure rules:** a route validates before it guards (a text heuristic over each route's
  argument list; `platformAdmin` isn't a guard to it, so the admin surface passes); scripts pick
  from `Env`.

## Settled by Plan 4

- [x] **Contracts in the web app:** Temporal types check under TypeScript 6; server-only schemas
  moved to `@akashic/contracts/events`; one Valibot version (1.5.0) across the workspace.
- [x] **Split deploys:** the web parses with the contracts views as they are; a new enum value
  ships in the web app first, then the API sends it (spec, "Keeping split deploys compatible").
- [x] Deleted `apps/api/test/fixtures/web-schemas.ts` and the per-module copies; the contract test
  holds every view to one source.

## Settled by Plan 5 (deployment)

- [x] The room page parses every socket frame.
- [x] MinIO in compose and CI, so the storage round-trip test runs.
- [x] Mail retention: dead `mail.requested` rows are pruned after `OUTBOX_RETENTION_DAYS`, and the
  dead queue has a 7-day TTL (policy). Payloads still hold the address and reset link until then.
- [x] CI deploy to the VPS (`api.yml`, gated on `DEPLOY_HOST`); the k8s migrate Job runs
  `apps/api/scripts/migrate.ts`.
- [x] Web hosting moved from Vercel to Cloudflare (Workers with static assets, `adapter-cloudflare`
  7; version 8 needs SvelteKit 3). Still open: confirm the Git-connected build's root directory and
  deploy command in the dashboard, and move the build variables there.
- [x] CI builds the web image (not pushed, D8).

Still open from Plan 5:

- Nothing has run on a real VPS yet: the first deploy will test the certificate, the GHCR login
  and the SSH known-hosts pin.
- Push `ghcr.io/wiormiw/akashic-web` when the Kubernetes path is wanted (`30-web.yaml` needs it).
- WAL archiving (`wal-g`) for point-in-time recovery, when nightly dumps stop being enough.
- Removing the two stray anonymous Docker volumes from Task 3's rehearsal (the user's to do).

## Can wait

- In a members' recall, a non-member passes `mayTakePart` (unchanged).
- Column defaults stay database time everywhere except where a service stamps a value itself.
- In the left-realm recall case, an admin subject's role is read without a lock (the outcome is
  `refused` either way).
- Realm context runs its lookups in parallel (two pool connections per realm request).
- No index serves the outbox prune; the prune runs before the claim once an hour.
- No concurrency test for the approve lock.
- Duplicated helpers across modules (`roleOf`/`isMember`, `person`, `castVote`); two query styles
  (raw `db.execute` rows and the typed builder).
- Room: a blocked user is admitted at upgrade (send refuses); the cross-room test proves silence
  only over 100 ms; swap `hono/bun` for `@hono/bun` before Hono 5.
- Contract test: its guard keys on the `*View` naming; three thin web schemas are labelled
  inventions.
- Structure rules: guards-per-route (no `.use()` on a realm sub-app) isn't enforced; the
  route-order and named-type rules are text heuristics; the comment skip treats a line starting
  with `/*` as wholly comment.
- Tests: the typed-err `inTransaction` test doesn't assert the writes rolled back; some narrowing
  tests' runtime asserts sit under `skipIf(!live)`.
- `DealError` is an alias of `HireError`, slightly broader than a deal can fail.
- Scripts hard-code log level, pool size and service names.
- `/admin/` with a trailing slash no longer matches (the web app calls `/admin`).
- Tests that commit rows (broker outbox integration, race tests) can be claimed by a running
  `bun run dev` dispatcher.
