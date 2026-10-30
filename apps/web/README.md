# @akashic/web

The SvelteKit front end for Akashic Records: realms, their jobs, events and marketplace,
governance, encrypted rooms and the platform control panel. The API is `apps/api` in this repository.

```
src/lib/api/      typed clients (valibot-parsed); authenticated calls go through the BFF
src/lib/crypto/   end-to-end encryption for rooms
src/lib/ui/       the primitives: Button, Card, Badge, Input, Select, Field, ...
src/routes/       /, /realms, /realms/[slug]/..., /rooms, /profile, /admin, sign-in pages
src/routes/bff/   proxy to the API, so the session cookie belongs to this origin
src/env.ts        the environment variables, declared and validated (read from $app/env/public)
```

Imports of `src/lib` go through `#lib/...` (the `imports` field of `package.json`) and name the
file: `#lib/config.ts`, `#lib/ui/Button.svelte`.

## Run it

```bash
cp apps/web/.env.example apps/web/.env   # PUBLIC_API_BASE=http://localhost:3000
bun install                              # from the repository root
bun run dev:web                          # http://localhost:5173
```

The API must be running (`bun run dev`). Its `CORS_ORIGINS` must include this origin.

## Check it

```bash
bun run check                       # from the root: format, lint, svelte-check, tests
bun --filter @akashic/web build
```
