# The API, and every release step that runs against it (migrate, authz push, backfills).
#
# Build from the repository root: `docker build -f apps/api/Dockerfile .`. The workspace packages
# (@akashic/db, @akashic/authz, ...) resolve through the root install, so the context has to be the
# root, not apps/api.
#
# Bun runs the TypeScript directly, so there is no build stage: the image is the production
# dependencies plus the source. The one image serves the server and the scripts under
# apps/api/scripts, so a release runs the exact code it is releasing.

# --- dependencies ------------------------------------------------------------------------------
FROM oven/bun:1.4-alpine AS deps

WORKDIR /app

# The manifests alone, so this layer survives source edits. Every workspace manifest is needed,
# the web's included, or the frozen lockfile no longer matches the workspace.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/authz/package.json packages/authz/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/lib/package.json packages/lib/package.json

# --frozen-lockfile so a build fails rather than quietly resolving versions nobody tested. The
# filter keeps the web's dependency tree (SvelteKit, vite, ...) out of this image.
RUN bun install --frozen-lockfile --production --filter @akashic/api

# --- run ---------------------------------------------------------------------------------------
FROM oven/bun:1.4-alpine

# The workspace layout is kept: bun links each workspace's dependencies with relative symlinks,
# which break if the directories move.
WORKDIR /app

# Curl for the container healthcheck. The base image has none.
RUN apk add --no-cache curl

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=deps /app/packages packages

# packages/ brings the SQL migrations (@akashic/db) and the OpenFGA model (@akashic/authz), which
# the release scripts read from disk. tsconfig.base.json is for the `@/` path alias the API uses.
COPY package.json tsconfig.base.json ./
COPY apps/api apps/api
COPY packages packages

ARG VERSION=dev
ENV APP_VERSION=${VERSION} NODE_ENV=production PORT=3000

EXPOSE 3000

# The bun image ships a `bun` user at uid 1000; nothing here needs to write to disk.
USER bun

# /livez, not /readyz: a down dependency should take the instance out of rotation, not get it
# restarted. The shell form reads $PORT, which deployments override.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT}/livez" >/dev/null || exit 1

# Bun forwards SIGTERM to the app, which drains and exits 0 within SHUTDOWN_TIMEOUT_MS.
STOPSIGNAL SIGTERM

CMD ["bun", "apps/api/src/main.ts"]
