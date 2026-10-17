# Akashic Records

A Bun monorepo: a Hono API (`apps/api`) over Postgres, OpenFGA, Redis and RabbitMQ, with shared
packages for the database, contracts, authorization and messaging. The design and rationale are in
[docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md](docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md).

## Start

```
docker compose up -d
cp .env.example .env
bun install
bun run db:migrate
bun run authz:push
bun run dev
```

`bun run check` runs format, lint, typecheck and tests, as CI does.

## Scripts

All run from the repository root; the `.env` is read for you.

```
bun run dev              the API on :3000 with reload
bun run check            format:check, lint, typecheck, test
bun run format           oxfmt apps packages
bun run db:generate      a migration from a schema change
bun run db:migrate       apply migrations
bun run authz:push       write the OpenFGA model
bun run authz:backfill   rewrite every tuple from Postgres
bun run events:replay    republish dead outbox events
bun run admin:grant <email> [--revoke]   grant or revoke platform admin
bun run realm:centroids  recompute each realm's fit centroid
```

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
        modules/<name>/     role files only: <name>.module.ts, .service.ts (or .<area>.service.ts),
                            .routes.ts, .consumer.ts, .types.ts. Modules: realm, events,
                            postings, comments, governance, room, upload, admin, mail
      scripts/              import.meta.main jobs: migrate, authz push and backfill, events
                            replay, admin grant, realm centroids
      test/                 mirrors src; support/ (shared fixtures), contract.test.ts (the web
                            app's schemas), integration tests that skip without services
      Dockerfile
    web/                    SvelteKit, moved from akashic_records_fe
  packages/
    db/          tables, defineRelations, row schemas, createDb(), migrations, drizzle config,
                 inTransaction, and the outbox and audit writers
    contracts/   Valibot request and response schemas, and the presenters that fill them
    lib/         Result, errors and codes, enums, time, logging, config, abort and lifecycle
                 helpers, tracing and telemetry
    authz/       createAuthorizer() and the OpenFGA model
    broker/      createBroker(), the outbox dispatcher, the event consumer
  docs/
  compose.yaml   postgres, redis, rabbitmq, openfga for development
```

## Web and deployment

`apps/web` is the SvelteKit front end (see [apps/web/README.md](apps/web/README.md)); it deploys to
Vercel. The API deploys to a VPS with `deploy/compose.prod.yaml` behind Caddy, from the image CI
pushes to GHCR. [deploy/README.md](deploy/README.md) is the runbook: the box, the GitHub
environment, first boot, backups and restore, Vercel, and the Kubernetes scale-out path.
`deploy/up-local.sh [--web]` runs the same production stack on this machine to rehearse it.
