# Deploying

The API runs on one VPS under Docker Compose, behind Caddy. The web app runs on Cloudflare. The
Kubernetes manifests are the scale-out path, kept but not applied.

```
Cloudflare (web Worker) --HTTPS--> Caddy :443 --> api --> postgres, openfga, redis, rabbitmq
                                              backup --nightly pg_dump x2--> S3-compatible bucket
```

`compose.prod.yaml` (project `akashic-prod`) holds all of it. Only Caddy publishes ports; the
databases publish nothing. It never collides with the dev `compose.yaml` (project `akashic`).

## 1. The box

- 4 vCPU / 8 GB, Ubuntu LTS, anywhere with a public IPv4 address; the web Worker reaches it by its domain name, so the API needs a DNS name (Workers cannot fetch a bare IP).
- Install Docker Engine with the compose plugin (<https://docs.docker.com/engine/install/>).
- Create the deploy user and the directory:

```sh
sudo adduser --disabled-password deploy && sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy -m 755 /opt/akashic
```

- Allow inbound 22, 80 and 443 only. Caddy needs 80 for the certificate challenge.
- DNS: an `A` record for the domain in `API_SITE_ADDRESS` (say `api.example.com`) pointing at the box. Do it first;
  Caddy asks for the certificate as soon as it starts and rate-limits repeated failures.
- An SSH keypair for CI, with no passphrase: put the public half in
  `~deploy/.ssh/authorized_keys`, keep the private half for `DEPLOY_SSH_KEY`:

```sh
sudo -u deploy sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys \
  && chmod 600 ~/.ssh/authorized_keys' < ci_key.pub
```

- A private S3-compatible bucket for backups, and a key that can read, write and delete in it only.
  Turn on versioning or object lock for it, covering at least `BACKUP_KEEP_DAYS` (section 5).

## 2. GitHub

Create the `production` environment (Settings, Environments). Add required reviewers if you want
a human gate on each deploy, and under Deployment branches restrict it to `main`: otherwise any
branch that names `environment: production` can read `API_ENV`. Set `DEPLOY_SSH_KEY`, `DEPLOY_USER` and `DEPLOY_KNOWN_HOSTS` now;
leave `API_ENV` and `DEPLOY_HOST` until the end of section 3. Setting `DEPLOY_HOST` turns on
deploys for every push to `main`, and a deploy before first boot, or with `API_ENV` lacking the
FGA ids, takes the API down.

| Where | Name | Value |
| --- | --- | --- |
| environment secret | `API_ENV` | the whole `.env`, FGA ids included (set last, section 3) |
| environment secret | `DEPLOY_SSH_KEY` | the private key, whole file |
| **repository** variable | `DEPLOY_HOST` | the box's address (set last, section 3) |
| environment variable | `DEPLOY_USER` | `deploy` |
| environment variable | `DEPLOY_KNOWN_HOSTS` | output of `ssh-keyscan <host>`, run once |

`DEPLOY_HOST` must be a repository variable: the deploy job's `if` runs before the job enters its
environment, so it cannot see environment variables. While it is empty, a push to `main` builds
and pushes the image and the `deploy-skipped` job says why nothing deployed. `DEPLOY_USER` and
`DEPLOY_KNOWN_HOSTS` are read inside the job, so either level works. For a non-default SSH port
the known-hosts entry is `[host]:port ...` (`ssh-keyscan -p 2222 host`).

A push to `main` runs the full check, builds `ghcr.io/wiormiw/akashic-api:<sha>` (and `latest`),
then deploys: copy the stack to `/opt/akashic`, write `.env` (mode 600), pull, migrate, `up -d`,
wait for `/readyz` through Caddy. It refuses to continue if `API_ENV` still contains `CHANGE_ME` or
`replace-me`, and it appends `API_IMAGE=<the deployed image>` and `PREVIOUS_API_IMAGE=<what ran
before>` to `.env`. Only changes to the API's code or the files the deploy uses (`compose.prod.yaml`,
`Caddyfile`, `backup/`) trigger it; README and `k8s/` edits do not.

## 3. First boot

An empty box has no database and no OpenFGA store, and the API refuses to start without
`FGA_STORE_ID`. So the order is: data services, migrate, authz push, then everything. Do this by
hand once, as `deploy` in `/opt/akashic`, before the first CI deploy.

```sh
# From your machine: the stack, and the env template as the starting .env.
scp -r deploy/compose.prod.yaml deploy/Caddyfile deploy/backup deploy@HOST:/opt/akashic/
scp deploy/env.prod.example deploy@HOST:/opt/akashic/.env
```

On the box, edit `.env` (`chmod 600`). Every `CHANGE_ME` in `env.prod.example` must be replaced:
the API rejects the short secret, and the CI deploy refuses a `.env` that still has one. The three passwords are `openssl rand -hex 32` (hex keeps the connection strings
URL-safe), and the same password goes in `POSTGRES_PASSWORD` and in `DATABASE_URL`, likewise
RabbitMQ. Set `API_SITE_ADDRESS` and `BETTER_AUTH_URL` to the API domain, `CORS_ORIGINS` to the
web app's origin, `TRUST_PROXY=true`, and the `BACKUP_*` values. Leave `FGA_STORE_ID` and
`FGA_MODEL_ID` empty.

The image: CI pushes to GHCR only from `main`, so push to `main` once with `DEPLOY_HOST` still
empty; the build runs, nothing deploys, and `<commit-sha>` below is that commit. Pulling needs a
login (a PAT with `read:packages`; the packages are private by default, or make them public and
skip this). The `dc` alias is for pasting into your shell.

```sh
echo "$PAT" | docker login ghcr.io -u <github-user> --password-stdin
export API_IMAGE=ghcr.io/wiormiw/akashic-api:<commit-sha>   # see "Pinning" below
alias dc='docker compose -p akashic-prod -f compose.prod.yaml'

dc up -d --wait postgres openfga-db openfga redis rabbitmq
dc run --rm api bun apps/api/scripts/migrate.ts
dc run --rm api bun apps/api/scripts/authz-push.ts      # prints FGA_STORE_ID=... FGA_MODEL_ID=...
```

Paste the two ids into `.env`, then bring everything up:

```sh
dc up -d
dc up -d --wait api caddy
curl -fsS https://api.example.com/readyz
```

`up -d` also runs `rabbitmq-policy`, a one-shot that gives the mail dead queue a 7-day message
TTL; it exits 0 and stays exited, which is why the wait names only `api` and `caddy` (`--wait`
treats an exited service as a failure). Caddy fetches its certificate at start, so the first
`curl` can still fail for a few seconds; retry.

Last, enable CI: copy the finished `.env`, ids included, into the `API_ENV` secret, then set
`DEPLOY_HOST`. CI overwrites `/opt/akashic/.env` with that secret on every deploy; if it still has
empty ids, the next deploy takes the API down.

### First admin

Sign up on the web app first. `admin-grant` refuses an account whose address is unverified, and
sign-in does too, so the account needs the verification mail: set `RESEND_API_KEY` and
`MAIL_FROM`, and click the link. Without a mail key nothing is sent; mark the one account
verified in SQL instead (rehearsed locally, where no mail is sent; the local form of these
commands is in section 7):

```sh
dc exec postgres psql -U akashic -d akashic \
  -c "UPDATE \"user\" SET email_verified = true WHERE email = 'you@example.com'"
dc run --rm api bun apps/api/scripts/admin-grant.ts you@example.com
# revoke: ... admin-grant.ts you@example.com --revoke
```

### Pinning the image

CI writes `API_IMAGE=<sha image>` into `.env`, which compose reads, so a manual `dc up` runs what
is deployed, not `:latest`. Before the first CI deploy `.env` has no `API_IMAGE`: the `export`
above does that job. The GHCR login CI leaves on the box uses the job token, which expires. For
manual pulls later, log in again with a PAT that has `read:packages`.

## 4. Day two

```sh
dc ps                          # health of everything
dc logs -f api                 # JSON, one line per event
dc logs caddy                  # one JSON line per request
dc run --rm api bun apps/api/scripts/authz-backfill.ts   # rebuild OpenFGA tuples from Postgres
```

`/livez` answers while the process is up; `/readyz` also checks Postgres, Redis, RabbitMQ and
OpenFGA. A stop (`dc stop api`, a deploy) drains in-flight requests; `stop_grace_period` is
30 s, above `SHUTDOWN_TIMEOUT_MS`.

## 5. Backups and restore

The `backup` service dumps two databases as a pair (`pg_dump -Fc`, each verified with
`pg_restore -l`) at 02:00 Asia/Jakarta, under one UTC timestamp:

```
s3://$BACKUP_BUCKET/postgres/<stamp>.dump   the app database
s3://$BACKUP_BUCKET/openfga/<stamp>.dump    OpenFGA's database
```

Dumps older than `BACKUP_KEEP_DAYS` are deleted from both prefixes. Run one now, or list them:

```sh
dc run --rm backup /backup/backup.sh
dc run --rm backup sh -c 'mc alias set b "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
  "$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null && mc ls b/$BACKUP_BUCKET/postgres/'
```

Why OpenFGA is dumped too: `authz-backfill` rebuilds realm and membership tuples from Postgres,
but not the posting tuples (written from events the outbox prunes after 7 days) or the platform
admin (stored only in OpenFGA). A restore needs the pair from one timestamp, so they agree.

**Alerting.** Set `BACKUP_HEARTBEAT_URL` (a healthchecks.io-style ping URL) and a successful run
pings it after the uploads and the prune. Configure the monitor to alert when pings stop; a
failed night is otherwise visible only in `dc logs backup`. A failed ping never fails the backup.

**Bucket settings (required).** The API's container reads the same `.env` as the backup, so it
holds the bucket's delete key. Turn on versioning or object lock at the provider, covering at
least `BACKUP_KEEP_DAYS`, so deleted or overwritten dumps stay recoverable.

**Encryption.** The dumps are not encrypted by this stack: they rely on the provider's
server-side encryption at rest. Encrypting with `age` before upload is the upgrade path if that
is not enough.

### Restore

`restore.sh <stamp>` takes the timestamp (`20261017T190000Z`), fetches and checks both dumps
first, then drops and recreates the app database and OpenFGA's, and restores each. Dropping
matters: `pg_restore --clean` removes only what the dump holds, so over a newer schema it leaves
the extra tables behind and migrate fails with "already exists". It refuses while any client
session is connected (autovacuum is ignored), so stop the API and OpenFGA first. Migrate then
brings the old schema forward, and `up -d` restarts the rest, running OpenFGA's own migration.

```sh
dc stop api openfga
dc run --rm backup /backup/restore.sh 20261017T190000Z
dc run --rm api bun apps/api/scripts/migrate.ts
dc up -d
```

`authz-backfill` is not needed afterwards: the OpenFGA dump carries the
tuples and the store ids in `.env` stay valid. If you restore only an app dump into a fresh
OpenFGA, run `authz-push` and `authz-backfill`; posting tuples and the platform admin are then
lost until re-granted (`admin-grant`). To rehearse, point `PGDATABASE` at a scratch database.

### Roll back

If a deploy fails (`/readyz` never answers) or misbehaves, run the previous image:

```sh
API_IMAGE=$(sed -n 's/^PREVIOUS_API_IMAGE=//p' .env) dc up -d api
```

Rollback does not undo migrations, so every migration must stay backward-compatible with the
previous release (add columns and tables first; drop or rename only in a later release, once
nothing running reads them). A migration that breaks the old image cannot be rolled back this
way; restore from a backup instead. To make the rollback stick, put the old value in `API_IMAGE`
in `.env`; the next CI deploy rewrites both lines anyway.

## 6. Cloudflare (the web app)

The web app is a SvelteKit server rendered on a Cloudflare Worker, with its assets served by
Cloudflare. In the dashboard: Workers & Pages, Create, Import a repository, then:

- Root directory: `/` (the repository root, so the workspace packages resolve).
- Build command: `bun run --filter @akashic/web build`.
- Deploy command: `cd apps/web && bunx wrangler deploy`. The Worker is `akashic-web`, named in
  `apps/web/wrangler.jsonc`, and the project name must match it. Do not use `wrangler pages
  deploy`: a Git-connected Workers build holds a Workers-scoped token and it fails with an
  authentication error.
- Build watch paths, so API-only commits do not redeploy it: include `apps/web/**`,
  `packages/contracts/**`, `packages/lib/src/enums.ts` and `bun.lock`.
- Build variables: `PUBLIC_API_BASE` (the API's HTTPS origin, no trailing slash; the build fails
  without it), `PUBLIC_MEDIA_ORIGIN` (the origin serving uploads, which shapes the CSP
  `img-src`) and `PUBLIC_SITE_URL` (the web's own origin). The build bakes `PUBLIC_API_BASE` into
  the Worker as its fallback, so you do not have to repeat it as a runtime variable; set the other
  two as runtime variables too if you change them.

`ADAPTER` is chosen per build: `adapter-cloudflare` when Cloudflare's build marks itself
(`WORKERS_CI=1`, or `CF_PAGES=1` for a Pages project), `adapter-node` for everything else, so
local runs and the container stay on Node. `ADAPTER=node|cloudflare` forces one. The API's
`CORS_ORIGINS` and `BETTER_AUTH_URL` must match the domains you give the project. The API origin
and media origin are fixed per build (the CSP is baked in): change one, redeploy.

Cloudflare's `fetch` only reaches hostnames, not bare IP addresses, so `PUBLIC_API_BASE` must be a
domain such as `https://api.example.com`, which Caddy already serves.

## 7. Run the production stack locally

The same compose file and the same order as section 3, on this machine, plain HTTP on loopback.
It uses its own volumes (project `akashic-prod`) and never touches the dev stack.

```sh
deploy/up-local.sh --web      # without --web: the API only
```

It writes `deploy/.env.local` (gitignored, generated secrets), builds `akashic-api:local` and
`akashic-web:local`, migrates, pushes the authz model, and starts api and caddy on
`127.0.0.1:8300` and web on `127.0.0.1:8301`. Run it again and it reuses everything. Local MinIO
stands in for the backup bucket, and no mail is sent, so a new account is verified by SQL before
it can sign in. From the repository root, paste this once per shell (it uses the same file and
variables as `up-local.sh`):

```sh
dcl() {
  API_ENV_FILE=.env.local API_IMAGE=akashic-api:local WEB_IMAGE=akashic-web:local \
    docker compose -p akashic-prod --profile local --profile web \
    --env-file deploy/.env.local -f deploy/compose.prod.yaml "$@"
}
# After signing up at http://localhost:8301/register:
dcl exec -T postgres psql -U akashic -d akashic \
  -c "UPDATE \"user\" SET email_verified = true WHERE email = 'you@example.test'"
dcl run --rm -T api bun apps/api/scripts/admin-grant.ts you@example.test
dcl down -v && rm deploy/.env.local     # tear down, volumes included
```

## Kubernetes: the scale-out path

`deploy/k8s/` holds corrected manifests for two API pods, two web pods, a migrate Job and a log
agent. Nothing applies them yet; the VPS is the plan until one box is not enough. They validate
with kubeconform (`docker run --rm -v "$PWD/deploy/k8s:/k" ghcr.io/yannh/kubeconform:v0.6.7
-strict -summary /k`). What differs from the VPS:

- The migrate Job runs `bun apps/api/scripts/migrate.ts` and must finish before the API rolls:

  ```sh
  kubectl apply -f deploy/k8s/00-config.yaml
  kubectl -n akashic apply -f deploy/k8s/10-migrate.yaml
  kubectl -n akashic wait --for=condition=complete job/migrate --timeout=5m
  kubectl -n akashic apply -f deploy/k8s/20-api.yaml -f deploy/k8s/30-web.yaml
  kubectl -n akashic apply -f deploy/k8s/40-log-agent.yaml
  ```

- The image is `ghcr.io/wiormiw/akashic-api`. The web image `ghcr.io/wiormiw/akashic-web` is built
  in CI but not pushed, so `30-web.yaml` cannot pull it yet.
- Probes are `/livez` (liveness, startup) and `/readyz` (readiness). `00-config.yaml` declares
  `api-secrets` with every value empty; fill it from a secret manager, never with placeholders.
- Infrastructure (Postgres, Redis, RabbitMQ, OpenFGA, the telemetry Collector) is not in there:
  use managed services. There is no ingress or registry login either.
- Two API replicas are safe: sessions live in Postgres, rate limits in Redis (per-process while
  Redis is down), outbox claiming is a guarded `UPDATE`, and room messages cross pods over a Redis
  channel (`platform/relay.ts`).
- `CORS_ORIGINS` is comma-separated; `AI_TIMEOUT_MS` must be below `REQUEST_TIMEOUT_MS`;
  `TRUST_PROXY` must be true behind an ingress; `PUBLIC_API_BASE` is a build argument.
