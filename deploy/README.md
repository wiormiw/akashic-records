# Deploying

The API runs on one VPS under Docker Compose, behind Caddy. The web app runs on Vercel. The
Kubernetes manifests are the scale-out path, kept but not applied.

```
Vercel (web, sin1) --HTTPS--> Caddy :443 --> api --> postgres, openfga, redis, rabbitmq
                                              backup --nightly pg_dump--> S3-compatible bucket
```

`compose.prod.yaml` (project `akashic-prod`) holds all of it. Only Caddy publishes ports; the
databases publish nothing. It never collides with the dev `compose.yaml` (project `akashic`).

## 1. The box

- 4 vCPU / 8 GB, Ubuntu LTS, in the region you set in `apps/web/vercel.json` (`sin1` today).
- Install Docker Engine with the compose plugin (<https://docs.docker.com/engine/install/>).
- Create the deploy user and the directory:

```sh
sudo adduser --disabled-password deploy && sudo usermod -aG docker deploy
sudo install -d -o deploy -g deploy -m 755 /opt/akashic
```

- Allow inbound 22, 80 and 443 only. Caddy needs 80 for the certificate challenge.
- DNS: an `A` record for `API_DOMAIN` (say `api.example.com`) pointing at the box. Do it first;
  Caddy asks for the certificate as soon as it starts and rate-limits repeated failures.
- An SSH keypair for CI, with no passphrase: put the public half in
  `~deploy/.ssh/authorized_keys`, keep the private half for `DEPLOY_SSH_KEY`:

```sh
sudo -u deploy sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys \
  && chmod 600 ~/.ssh/authorized_keys' < ci_key.pub
```

- A private S3-compatible bucket for backups, and a key that can read, write and delete in it only.

## 2. GitHub

Create the `production` environment (Settings, Environments). Add required reviewers if you want
a human gate on each deploy. Set `DEPLOY_SSH_KEY`, `DEPLOY_USER` and `DEPLOY_KNOWN_HOSTS` now;
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
wait for `/readyz` through Caddy.

## 3. First boot

An empty box has no database and no OpenFGA store, and the API refuses to start without
`FGA_STORE_ID`. So the order is: data services, migrate, authz push, then everything. Do this by
hand once, as `deploy` in `/opt/akashic`, before the first CI deploy.

```sh
# From your machine: the stack, and the env template as the starting .env.
scp -r deploy/compose.prod.yaml deploy/Caddyfile deploy/backup deploy@HOST:/opt/akashic/
scp deploy/env.prod.example deploy@HOST:/opt/akashic/.env
```

On the box, edit `.env` (`chmod 600`). Every placeholder in `env.prod.example` fails validation
on purpose. The three passwords are `openssl rand -hex 32` (hex keeps the connection strings
URL-safe), and the same password goes in `POSTGRES_PASSWORD` and in `DATABASE_URL`, likewise
RabbitMQ. Set `API_SITE_ADDRESS` and `BETTER_AUTH_URL` to the API domain, `CORS_ORIGINS` to the
Vercel origin, `TRUST_PROXY=true`, and the `BACKUP_*` values. Leave `FGA_STORE_ID` and
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

`API_IMAGE` is set per deploy by CI. A manual `dc up` without it falls back to `:latest`, which
may not be what is running. Pin it to what is deployed:

```sh
docker inspect "$(dc ps -q api)" --format '{{.Config.Image}}'
export API_IMAGE=ghcr.io/wiormiw/akashic-api:<that-sha>
```

The GHCR login CI leaves on the box uses the job token, which expires. For manual pulls later,
log in again with a PAT that has `read:packages`.

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

The `backup` service dumps the app database (`pg_dump -Fc`, verified with `pg_restore -l`) at
02:00 Asia/Jakarta to `s3://$BACKUP_BUCKET/postgres/<UTC stamp>.dump` and deletes dumps older than
`BACKUP_KEEP_DAYS`. Run one now, or list them:

```sh
dc run --rm backup /backup/backup.sh
dc run --rm backup sh -c 'mc alias set b "$BACKUP_S3_ENDPOINT" "$BACKUP_S3_ACCESS_KEY_ID" \
  "$BACKUP_S3_SECRET_ACCESS_KEY" >/dev/null && mc ls b/$BACKUP_BUCKET/postgres/'
```

Restore replaces the app database. It needs the API stopped: `restore.sh` refuses while any other
session is connected.

```sh
dc stop api
dc run --rm backup /backup/restore.sh postgres/20261017T190000Z.dump
dc run --rm api bun apps/api/scripts/authz-backfill.ts
dc up -d api
```

Only the app database is dumped. OpenFGA's tuples are derived from it, so after a restore (or on a
fresh OpenFGA volume, after `authz-push` and new ids) `authz-backfill` rebuilds them. Restore into
a scratch database first if you are unsure: the script uses `PGDATABASE`.

## 6. Vercel

Import the repository as a project, then:

- Root Directory: `apps/web`.
- Enable "Include source files outside of the Root Directory in the Build Step", or
  `packages/contracts` does not resolve.
- Environment variables, for Production and Preview: `PUBLIC_API_BASE` (the API's HTTPS origin, no
  trailing slash; a build fails without it), `PUBLIC_MEDIA_ORIGIN` (the origin serving uploads,
  which shapes the CSP `img-src`) and `PUBLIC_SITE_URL` (the web's own origin).
- Node version is irrelevant: the function runtime is pinned to `nodejs24.x` in `vite.config.ts`.

`vercel.json` pins region `sin1` and skips builds that touch nothing the web depends on
(`scripts/vercel-ignore.sh`). The API's `CORS_ORIGINS` and `BETTER_AUTH_URL` must match the
domains you give the project. `PUBLIC_*` values are baked in at build time: change one, redeploy.

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
