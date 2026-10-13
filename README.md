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

`modules/`, `apps/web` and the Dockerfile arrive in later plans.
