# The web front end.
#
# Build from the repository root: `docker build -f apps/web/Dockerfile .`. The workspace packages
# (@akashic/contracts, @akashic/lib) resolve through the root install, so the context has to be
# the root, not apps/web.
#
# Four stages, and the split is about layer invalidation rather than tidiness: dependencies
# change rarely, source changes constantly, and the runtime needs neither the toolchain nor the
# dev dependencies that built it.
#
# The output is SvelteKit's node adapter -- a plain server listening on PORT. It is run with Bun
# rather than Node, which the adapter's output supports, so one runtime covers the whole estate
# and there is one less base image to keep patched.

# --- dependencies ------------------------------------------------------------------------------
FROM oven/bun:1.4-alpine AS deps

WORKDIR /app

# The manifests alone. Copying the tree here would invalidate this layer on every source edit,
# which is the difference between a fast rebuild and a full reinstall each time. Every workspace
# manifest is needed, or the frozen lockfile no longer matches the workspace.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/authz/package.json packages/authz/package.json
COPY packages/broker/package.json packages/broker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/lib/package.json packages/lib/package.json

# --frozen-lockfile so a build fails rather than quietly resolving versions nobody tested. A
# lockfile the manifest has outgrown is a bug to fix, not something to route around at deploy time.
RUN bun install --frozen-lockfile

# The runtime's dependencies, installed apart from the full set so dev dependencies never reach it.
FROM deps AS prod-deps
RUN bun install --frozen-lockfile --production --filter @akashic/web

# --- build -------------------------------------------------------------------------------------
FROM oven/bun:1.4-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules node_modules
# Each workspace links its own dependencies, so the contracts package finds valibot from its own
# directory; the root node_modules alone is not enough.
COPY --from=deps /app/apps apps
COPY --from=deps /app/packages packages
COPY . .

# The CSP is baked at build time from these, so an image is built for the origins it will serve.
# The app reads them at run time through $app/env/public (src/env.ts, not inlined), which is why the
# runtime stage sets them again. Getting this wrong is invisible until the browser calls the
# wrong API and CORS or CSP refuses it.
ARG PUBLIC_API_BASE=""
ARG PUBLIC_MEDIA_ORIGIN=""
ENV PUBLIC_API_BASE=${PUBLIC_API_BASE} PUBLIC_MEDIA_ORIGIN=${PUBLIC_MEDIA_ORIGIN}

# The node adapter, whatever the host environment says: this image runs a server.
ENV ADAPTER=node

RUN bun --filter @akashic/web build

# --- run ---------------------------------------------------------------------------------------
FROM oven/bun:1.4-alpine

# The workspace layout is kept: bun links the web app's dependencies from apps/web/node_modules
# into the root store with relative symlinks, which break if the directories move.
WORKDIR /app/apps/web

# Curl for the container healthcheck. The base image has none, and an image whose health can only
# be judged from outside is one the orchestrator cannot restart on its own.
RUN apk add --no-cache curl

# Only what the server needs: the build output and the production dependencies. The source, the
# toolchain and every dev dependency stay in the build stage.
COPY --from=build /app/apps/web/build build
COPY --from=build /app/apps/web/package.json package.json
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=prod-deps /app/apps/web/node_modules node_modules

# The origins the CSP above was built for, as the run-time defaults for $app/env/public.
ARG PUBLIC_API_BASE=""
ARG PUBLIC_MEDIA_ORIGIN=""
ENV PUBLIC_API_BASE=${PUBLIC_API_BASE} PUBLIC_MEDIA_ORIGIN=${PUBLIC_MEDIA_ORIGIN}

ARG VERSION=dev
ENV APP_VERSION=${VERSION} NODE_ENV=production PORT=3000

EXPOSE 3000

# The bun image ships a `bun` user at uid 1000. Running as it is free and removes the most boring
# class of container escape.
USER bun

# The root page, because the node adapter serves no dedicated health route and adding one would
# mean a route that exists only for this. It is a server-rendered page, so it answers from the
# same code path a reader hits.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:3000/ >/dev/null || exit 1

CMD ["bun", "build/index.js"]
