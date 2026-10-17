# Plan 5: deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything needed to run Akashic Records in production exists and has been run end to end on this machine:
- an API image;
- a VPS compose stack with TLS and backups;
- CI that builds, pushes and (once a VPS exists) deploys the API;
- the Vercel configuration for the web app.

**Architecture:**
- **One API image** (`ghcr.io/wiormiw/akashic-api`) runs the server and every release script (migrate, authz push, admin grant).
- **`deploy/compose.prod.yaml`** runs it beside Postgres, Redis, RabbitMQ, OpenFGA, Caddy (TLS for the API) and a nightly backup job. The same file runs locally, with a local env file and an optional `web` profile, so the stack is rehearsed before any VPS is bought.
- **GitHub Actions** build the image on every PR, and push it on `main`. The deploy job runs over SSH only once the `DEPLOY_HOST` variable is set.
- **The web app** deploys on Vercel from `apps/web`, with an ignored-build step.

**Tech Stack:** Docker and Compose v2, Caddy 2, Bun 1.4, GitHub Actions (GHCR, SSH deploy), Vercel (`adapter-vercel` 6, `nodejs24.x`), Postgres 17 `pg_dump`, MinIO for S3 locally.

**Spec:** `docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md`. The sections that apply are "Deployment", "Configuration and secrets", "Infrastructure", "Scaling out" and "Porting order" steps 11-12. Open items come from `docs/superpowers/plans/2026-10-15-plan-2-followups.md`, "Plan 5 (deployment)".

## Decisions taken in this plan (rulings for the user to confirm)

- **D1: the VPS stack is `deploy/compose.prod.yaml`, project name `akashic-prod`.**
  - Only Caddy publishes ports. On the VPS that is 80 and 443, with automatic TLS for `API_DOMAIN`. Locally it is `127.0.0.1:8300`, plain HTTP.
  - The databases publish nothing.
  - It never collides with the dev `compose.yaml`, so both can run at once.
- **D2: one image, every release step.** `ghcr.io/wiormiw/akashic-api`, tagged with the commit SHA and `latest`. Migrations run as `docker compose run --rm api bun apps/api/scripts/migrate.ts` before `up -d`, never on container start.
- **D3: the whole API `.env` is one GitHub secret, `API_ENV`, in the `production` environment.**
  - The deploy job writes it to `/opt/akashic/.env` with mode 600.
  - It runs only when the repository variable `DEPLOY_HOST` is non-empty. Until the VPS exists, it skips and says why.
- **D4: deploys wait for the full check.** `ci.yml` becomes callable (`workflow_call`), and the API workflow calls it before building on `main`. The tests run twice on a `main` push; that is the price of not deploying an unchecked commit.
- **D5: Vercel functions run in `sin1` (Singapore),** near Jakarta and the likely VPS region. Change it in `apps/web/vercel.json` when the VPS region is known.
- **D6: backups are a nightly `pg_dump` to S3-compatible storage**, with a restore script, rehearsed against local MinIO. WAL archiving (`wal-g`) waits until point-in-time recovery is needed.
- **D7: mail payloads don't outlive their usefulness.**
  - Dead `mail.requested` outbox rows are deleted after `OUTBOX_RETENTION_DAYS`, like published ones.
  - The RabbitMQ mail dead queue gets a 7-day message TTL through a policy. A policy, not queue arguments, because redeclaring an existing queue with new arguments fails.
- **D8: CI builds the web image without pushing it,** only when `apps/web/**` changes, so the spare Dockerfile can't rot.
- **D9: the `deploy/k8s` manifests stay, corrected** to the new image, paths and probes. They are the scale-out path the spec's table describes; nothing applies them yet.

## Global Constraints

- Style: tabs, single quotes, width 100 for TS. YAML uses two spaces. Comments say why, briefly.
- Pin every third-party image by tag. Pin by tag and digest where `compose.yaml` already does (OpenFGA `v1.21.0@sha256:2113c664…`, copied exactly). Never `latest`, except our own image's `latest` tag.
- Pin GitHub Actions to a major version tag (`actions/checkout@v4` and the like).
- No secret in any committed file. `.env.example`-style files hold placeholders only, and the local prod env file is gitignored.
- Postgres in the dev stack holds the user's real data. The local prod rehearsal uses its own volumes (project `akashic-prod`) and never touches the dev stack's.
- `akashic_records_fe` and `akashic_records_be` are read-only.
- Commits end with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`.
- `bun run check` is green after every task. Bun is off PATH: `export PATH="$HOME/.bun/bin:$PATH"`.
- Any container, image or volume a task creates for verification is removed by that task, except the rehearsal stack, which Task 8 leaves down with its volumes removed.
- Don't push to GitHub; the controller handles pushing.

## Review Focus

1. **A container stopped mid-request** (`docker stop`, a deploy). The API drains and exits 0 within its grace period. Compose's `stop_grace_period` must exceed `SHUTDOWN_TIMEOUT_MS`. Test owner: Task 1.
2. **First boot on an empty VPS:** no database, no OpenFGA store. The documented order is migrate, then authz push (which prints `FGA_STORE_ID`/`FGA_MODEL_ID` into the env), then `up`. The local rehearsal follows that same runbook. Test owner: Task 8.
3. **A restore from a backup into a fresh database** yields the same row counts. Test owner: Task 3.
4. **A Vercel build of a commit that touches only `apps/api`** is skipped, and one touching `packages/contracts` is built. Test owner: Task 5.
5. **A real client IP behind Caddy.** Rate limits must key on the client, not on Caddy: `TRUST_PROXY=true` in the prod env, and Caddy sets `X-Forwarded-For`. Test owner: Task 2.

---

### Task 1: The API image

**Files:**
- Create: `apps/api/Dockerfile`.
- Modify: the root `.dockerignore`, if anything is missing (`.env*`, `.superpowers`, `node_modules`, `**/.svelte-kit`, `**/build`, `logs`, `.git`).

**Interfaces:**
- Produces: an image that runs `bun apps/api/src/main.ts` from `/app`, listening on `PORT` (default 3000). `WORKDIR /app` and the full workspace layout are kept, so `bun apps/api/scripts/<x>.ts` works for every script.
  - The image includes `apps/api`, `packages/*`, `packages/db/migrations` and the authz model file.
  - It excludes `apps/web` source and its dependencies.

- [ ] **Step 1: Write the Dockerfile.**
  - Use `oven/bun:1.4-alpine`, the same base as the web image.
  - **Deps stage:** copy the root `package.json`, `bun.lock` and every workspace `package.json` (the web's included, so the lockfile resolves), then `bun install --frozen-lockfile --production --filter @akashic/api`. Use whichever filter syntax Bun 1.4 supports to install only the API's tree; if it has none, install production deps for all and say so.
  - **Runtime stage:** copy the deps, `apps/api`, `packages`, `tsconfig.base.json` and `package.json`.
  - Run as a non-root user.
  - Add a `HEALTHCHECK` that curls `/livez`.
  - Set `STOPSIGNAL SIGTERM`.
- [ ] **Step 2: Verify against the dev stack's infrastructure.**
  - `docker build -f apps/api/Dockerfile -t akashic-api:plan5 .`
  - Run it with `--network host --env-file .env -e PORT=3999`.
  - `curl -sf localhost:3999/readyz` answers 200.
  - `docker stop` exits it with code 0 inside 15 s (Review Focus 1). Record `docker inspect -f '{{.State.ExitCode}}'`.
  - `docker run --rm --network host --env-file .env akashic-api:plan5 bun apps/api/scripts/migrate.ts` exits 0. It is a no-op on the current schema.
  - Record the image size.
  - Remove the container and the image.
- [ ] **Step 3: Commit** `build(api): the API image builds from the workspace root`.

### Task 2: The VPS compose stack

**Files:**
- Create:
  - `deploy/compose.prod.yaml`;
  - `deploy/Caddyfile`;
  - `deploy/env.prod.example`: every variable the API needs, with placeholders and a comment each; `TRUST_PROXY=true`;
  - `deploy/env.local.example`: the local rehearsal values, with real local secrets generated by the script, not committed;
  - `deploy/up-local.sh`.
- Modify: `.gitignore` (`deploy/.env.local`, `deploy/.env.prod`).

**Interfaces:**
- **Services:**
  - `postgres` (pgvector pg17), `openfga-db`, `openfga-migrate` and `openfga`, pinned as `compose.yaml` pins them. OpenFGA keeps `OPENFGA_AUTHN_METHOD: none` because the API has no token setting; that is safe only because OpenFGA publishes no port and sits on the stack's internal network. Say so in a comment.
  - `redis` and `rabbitmq`.
  - `api`: `image: ${API_IMAGE:-ghcr.io/wiormiw/akashic-api:latest}`, `env_file`, `stop_grace_period: 30s`, and `depends_on` with health conditions.
  - `caddy` (`caddy:2-alpine`).
  - `web`: profile `web`, built from `apps/web/Dockerfile`, local rehearsal only.
- No data service publishes a port. Named volumes are prefixed by the project name.
- **Caddy:**
  - It serves `{$API_SITE_ADDRESS}`: on the VPS `api.example.com`, so Caddy's automatic HTTPS applies; locally `http://localhost:8300`.
  - It `reverse_proxy api:3000`, including WebSocket upgrades for `/ws/*`, which are automatic in Caddy 2.
  - Ports: `${CADDY_HTTP:-80}:80` and `${CADDY_HTTPS:-443}:443` on the VPS. Locally, `127.0.0.1:8300:8300` through the env file.
- **`deploy/up-local.sh`:** runs the first-boot runbook against the local env (Review Focus 2) and is idempotent on a second run. Its steps:
  1. generate `deploy/.env.local` from the example if it is absent, with random secrets;
  2. build the images;
  3. `up -d` the data services and wait for health;
  4. migrate;
  5. authz push, writing the printed `FGA_STORE_ID`/`FGA_MODEL_ID` into `deploy/.env.local` if they are empty;
  6. `up -d api caddy`, plus `web` if `--web` is passed;
  7. wait for `http://localhost:8300/readyz`.

- [ ] **Step 1: Write the files.**
- [ ] **Step 2: Rehearse.**
  - `deploy/up-local.sh --web`.
  - `curl -sf localhost:8300/readyz` answers 200.
  - `curl -s localhost:8300/api/public/v1/realms` answers a JSON array (empty on a fresh database).
  - The web container on `127.0.0.1:8301`, built with `PUBLIC_API_BASE=http://localhost:8300`, returns 200 on `/`.
  - Review Focus 5: send a request with `X-Forwarded-For: 203.0.113.9` through Caddy and confirm the API logs that IP (Caddy appends; `TRUST_PROXY` reads the left-most value or the last hop, whichever the API's code does). Record the log line.
  - Run `up-local.sh` a second time: no error, and no FGA store duplicated.
- [ ] **Step 3: Tear down** with `docker compose -p akashic-prod -f deploy/compose.prod.yaml --profile web down -v`. The dev stack's containers and volumes must be untouched; compare `docker volume ls` before and after.
- [ ] **Step 4: Commit** `feat(deploy): the VPS compose stack, rehearsed locally`.

### Task 3: Backups

**Files:**
- Create:
  - `deploy/backup/backup.sh`: `pg_dump -Fc`, then upload to `s3://$BACKUP_BUCKET/postgres/<UTC timestamp>.dump`, then delete objects older than `BACKUP_KEEP_DAYS` (default 14);
  - `deploy/backup/restore.sh <object-key>`: download, then `pg_restore --clean --if-exists` into the target database;
  - a `backup` service in `deploy/compose.prod.yaml`, running the script nightly at 02:00 Asia/Jakarta with whatever scheduler fits an alpine image (e.g. `crond`). It runs on the `postgres:17-alpine` client plus the MinIO client `mc`, pinned.
- Modify: `deploy/env.prod.example` and `deploy/env.local.example`, adding `BACKUP_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` and `BACKUP_KEEP_DAYS`. The local values point at a `minio` service in the prod compose, in profile `local`.

- [ ] **Step 1: Write the scripts and services.**
- [ ] **Step 2: Rehearse the restore (Review Focus 3).**
  1. Bring up the local stack with the `local` profile, then migrate.
  2. Insert one marker row through the API: sign up a user with an `@example.test` address.
  3. Run `docker compose … run --rm backup /backup/backup.sh` and confirm the object exists.
  4. Drop and recreate the `akashic` database in the prod-local postgres, restore that object, and compare `SELECT count(*) FROM "user"` before and after; they must be equal.
  5. Tear down with `-v`.
- [ ] **Step 3: Commit** `feat(deploy): nightly Postgres backups to S3, with a rehearsed restore`.

### Task 4: CI: MinIO, reusable checks, the API workflow, the web image

**Files:**
- Modify: `.github/workflows/ci.yml`.
  - Add `workflow_call` to its triggers.
  - Start MinIO with `docker run`, pinned as `compose.yaml` pins it, plus the bucket init `compose.yaml` does. Set the `S3_*` env so the storage round-trip test runs instead of skipping.
- Create: `.github/workflows/api.yml`.
  - Triggers: `pull_request` and `push` to `main`, both with paths `apps/api/**`, `packages/{db,lib,authz,broker,contracts}/**`, `bun.lock`, `deploy/**`, `.github/workflows/api.yml`.
  - Jobs:
    - `check` (`uses: ./.github/workflows/ci.yml`);
    - `image`: needs check. Uses buildx with the GHA cache. Pushes to GHCR on `main` only (`permissions: packages: write`), tagged `${{ github.sha }}` and `latest`.
    - `deploy`: needs image, `main` only, `environment: production`, `if: vars.DEPLOY_HOST != ''`. Over SSH with `secrets.DEPLOY_SSH_KEY` to `vars.DEPLOY_USER@vars.DEPLOY_HOST`, it:
      1. copies `deploy/compose.prod.yaml`, `deploy/Caddyfile` and `deploy/backup/` to `/opt/akashic/`;
      2. writes `secrets.API_ENV` to `/opt/akashic/.env` with mode 600;
      3. runs `docker login ghcr.io` with the job's token;
      4. runs `API_IMAGE=…:${sha} docker compose pull api`;
      5. runs migrate;
      6. runs `up -d`;
      7. waits for `/readyz` through Caddy, failing the job if it never answers.
    - A step summary saying "deploy skipped: set DEPLOY_HOST" when the variable is unset.
- Create: `.github/workflows/web-image.yml`, which builds `apps/web/Dockerfile` without pushing, on PR and push, with paths `apps/web/**`, `packages/contracts/**`, `packages/lib/src/enums.ts`, `bun.lock`.

- [ ] **Step 1: Write the workflows.**
- [ ] **Step 2: Validate** with `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.7` (or the newest pinned tag that exists). It reports no errors. Remove the image afterwards.
- [ ] **Step 3: Check that the MinIO bootstrap commands work locally,** in a throwaway container on a free port. Then run the storage test against it (`bun test apps/api/test/integrations/storage.test.ts` with the same `S3_*` env) and confirm it runs rather than skips.
- [ ] **Step 4: Commit** `ci: MinIO in CI; the API image is built, pushed and deployed`.

### Task 5: Vercel

**Files:**
- Create: `apps/web/vercel.json`, holding `regions: ["sin1"]`, the framework `sveltekit`, and `ignoreCommand: "bash scripts/vercel-ignore.sh"`.
- Create: `apps/web/scripts/vercel-ignore.sh`. It exits 0 to skip when nothing under `apps/web`, `packages/contracts`, `packages/lib/src/enums.ts` or `bun.lock` changed between `${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}` and `HEAD`, and exits 1 to build otherwise. It always builds when the previous SHA is unknown to git.
- Create: `apps/web/scripts/vercel-ignore.test.ts`. It runs the script inside a temporary git repository built by the test: commit a change under `apps/api`, expect exit 0 (skip); commit one under `packages/contracts`, expect exit 1 (build); set an unknown previous SHA, expect exit 1. This covers Review Focus 4.
- Modify: the web `test` script, so the new test runs.

- [ ] **Step 1: Write the failing test,** then the script, then GREEN.
- [ ] **Step 2: Verify** that `bun run check` is green.
- [ ] **Step 3: Commit** `feat(web): Vercel config and the ignored-build step`.

### Task 6: Mail payload retention (D7)

**Files:**
- Modify: `packages/broker/src/store.ts` (and `dispatcher.ts` if the prune lives there). The prune also deletes `DEAD` rows whose topic is `mail.requested` and whose `created_at` is older than the cutoff.
- Modify: `deploy/compose.prod.yaml` and `compose.yaml`. A one-shot `rabbitmq-policy` service sets the policy `mail-dead-ttl` with pattern `^mail\..*\.dead$`, definition `{"message-ttl": 604800000}` and apply-to `queues`, through the management API or `rabbitmqctl` after rabbitmq is healthy. Check the real dead-queue name with `Queues` and `deadQueueOf` and fit the pattern to it.
- Test: the broker store's integration test, which commits uniquely named rows and deletes exactly those.

- [ ] **Step 1: Write the failing tests:**
  - `'the prune deletes a dead mail event past retention'`;
  - `'the prune keeps a dead non-mail event'`: other topics stay replayable;
  - `'the prune keeps a dead mail event inside retention'`.
- [ ] **Step 2: Implement it, then GREEN.**
- [ ] **Step 3: Verify the policy.** Start the dev rabbitmq; it's already running. Run the one-shot, then confirm with `rabbitmqctl list_policies` that the policy exists and applies to the mail dead queue. Leave the policy in place; it is idempotent.
- [ ] **Step 4: Commit** `feat(broker): mail payloads leave the outbox and the dead queue after retention`.

### Task 7: The room page parses every socket frame

**Files:**
- Modify: `apps/web/src/lib/api/rooms.ts`, which exports `ServerFrame = v.variant('type', [MessageFrameView, StaleDevicesFrameView, ErrorFrameView])`, using the views' real names in contracts. Modify `apps/web/src/routes/rooms/[id]/+page.svelte` so the socket handler parses with it. An unparseable frame is ignored with a `console.warn`, never thrown.
- Test: `apps/web/src/lib/api/rooms.test.ts`. Each of the three frame kinds parses. An unknown `type` fails the parse.

- [ ] **Step 1: Write the failing tests,** implement, then GREEN.
- [ ] **Step 2: Commit** `fix(web): the room page parses every socket frame`.

### Task 8: Docs, the k8s manifests, and the full rehearsal

**Files:**
- Modify:
  - `deploy/README.md`: rewrite it around the VPS. It covers:
    - buying the box (4 vCPU / 8 GB, as in the spec), installing Docker, DNS for `API_DOMAIN`, and the GitHub `production` environment;
    - the secrets (`API_ENV`, `DEPLOY_SSH_KEY`) and variables (`DEPLOY_HOST`, `DEPLOY_USER`);
    - the first-boot runbook (Review Focus 2) and the first admin grant (`docker compose run --rm api bun apps/api/scripts/admin-grant.ts <email>`);
    - backups and restore;
    - Vercel project setup: root `apps/web`; env `PUBLIC_API_BASE`, `PUBLIC_MEDIA_ORIGIN` and `PUBLIC_SITE_URL` for Production and Preview; Node is irrelevant because the runtime is pinned;
    - "Run the production stack locally" (`deploy/up-local.sh`).

    Keep the k8s section, shortened to "the scale-out path".
  - `deploy/k8s/*.yaml`: the image becomes `ghcr.io/wiormiw/akashic-api`; the migrate Job runs `bun apps/api/scripts/migrate.ts`; the probes are `/livez` and `/readyz`; `30-web.yaml` uses a web image named `ghcr.io/wiormiw/akashic-web` with a comment that it isn't pushed yet (D8).
  - `README.md`: the web app and the deploy pointers.
  - `CLAUDE.md`: the `deploy/` commands, and a trap for anything this plan hit.
  - `docs/superpowers/plans/2026-10-15-plan-2-followups.md`: tick the Plan 5 items, and leave only what is still open.
- [ ] **Step 1: Write the docs and fix the manifests.** Validate the manifests with `docker run --rm -v "$PWD/deploy/k8s:/k" ghcr.io/yannh/kubeconform:v0.6.7 -strict -summary /k` (or the newest pinned tag that exists), then remove the image.
- [ ] **Step 2: Rehearse in full,** following the README exactly as a new reader would:
  1. `deploy/up-local.sh --web`;
  2. sign up through the web container's `/register` with `curl`, or through the BFF endpoint the page posts to;
  3. grant admin with the documented command;
  4. confirm `/api/auth/get-session` through the BFF returns the user;
  5. tear down with `-v`.

  Record every command and its output.
- [ ] **Step 3: Verify, then commit.** Run `bun run check`, then commit `docs: deployment runbook; plan 5 close-out`.
