# Plan 4: the web app moves in — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `akashic_records_fe` becomes `apps/web` in the monorepo. It parses every API response with the views in `@akashic/contracts`, and chooses its adapter and CSP per build.

**Architecture:** The SvelteKit app is copied in as a workspace package (no git history, as with the API). Its `src/lib/api/*.ts` response schemas are replaced by imports from `@akashic/contracts`, and its enum constants by `@akashic/lib/enums`. A field change that breaks the web app then fails `svelte-check`, so the API's copy of the web schemas (`test/fixtures/web-schemas.ts`) is deleted. `contracts` moves its server-only outbox event schemas to a subpath, so its index stays safe for the browser bundle.

**Tech Stack:** SvelteKit 2, Svelte 5 (runes), Vite 8, Tailwind 4, TypeScript 6 in the web app (svelte-check needs it; the rest stays on 7), Valibot 1.5.0, Bun 1.4 workspaces, `@sveltejs/adapter-node` and `@sveltejs/adapter-vercel`.

**Spec:** `docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md`. The sections that apply are "Layout", "Package rules", "Web on Vercel", "Keeping split deploys compatible" and "Porting order" step 10. Open items come from `docs/superpowers/plans/2026-10-15-plan-2-followups.md`, "Plan 4 must decide".

**Out of this plan (Plan 5, deployment):** the API Dockerfile and deploy workflow, `vercel.json` and the ignored-build step, MinIO in compose and CI, mail payload retention, `deploy/k8s`, `README.md` and `docs/ARCHITECTURE.md`.

## Decisions taken in this plan (rulings for the user to confirm)

- **D1: the web app parses with the contracts views as they are.** It doesn't use looser copies. An enum value the deployed web doesn't know fails its parse, and the helper falls back as it does today on any bad response. The split-deploy rule gains one line: *a new enum value ships in the web app first, then the API sends it.* Looser read views would double the contract and let drift through.
- **D2: Temporal stays in `contracts`.** It is only used in presenter signatures. TypeScript 6 ships `lib.esnext.temporal.d.ts`, so svelte-check can type it, and the browser never calls a presenter.
- **D3: `realmEvents` and `mailRequested` move to `@akashic/contracts/events`.** `RoomFrameLimits` stays in the index: it is plain numbers the room composer uses.
- **D4: the web's Dockerfile comes along, for any host besides Vercel; its separate CI does not.** It builds from the repository root, so the workspace packages resolve, sets `ADAPTER=node`, and runs `build/index.js` with Bun. CI doesn't build the image yet (Plan 5 decides).
- **D5: one formatter per file type.** `oxfmt` formats every `.ts`/`.js` in the repo, the web's included. Prettier, with `prettier-plugin-svelte`, formats only `apps/web/**/*.svelte` (and `app.css`/`app.html`). Both use tabs, single quotes and width 100.

## Global Constraints

- Code style: tabs, single quotes, print width 100, everywhere.
- Valibot is exactly `1.5.0` in every `package.json` that declares it.
- `apps/web` imports only these workspace packages: `@akashic/contracts` and `@akashic/lib/enums`. Never `@akashic/contracts/events` (server-only), nothing else from `@akashic/lib`, and never `db`, `authz` or `broker`.
- `packages/contracts/src/index.ts`'s import graph reaches only `valibot`, `@akashic/lib/enums` and `@akashic/lib/errors`.
- The web app stays on TypeScript 6 (`typescript@^6.0.3`). The root and the other packages stay on 7.
- `akashic_records_fe` is a read-only source: copy from it, never edit it.
- Never commit `.env`, `.superpowers/`, `node_modules`, `.svelte-kit` or `build`.
- Commits end with exactly `Co-Authored-By: Claude <noreply@anthropic.com>`; one commit per step marked Commit.
- `bun run check` is green at the end of every task. It must include the web app's format check, lint, svelte-check and tests.
- Bun is off PATH: `export PATH="$HOME/.bun/bin:$PATH"`.
- Postgres holds real dev data. Tests touch only the rows they create.

## Review Focus

1. **A response carrying an enum value the web doesn't know** (D1). The helper must return its fallback (`null`, `[]`, or the error state it has today) and never throw into a page. Test owner: Task 3.
2. **An API that's down or answers 5xx during SSR.** Pages render their empty or "unavailable" state exactly as before the move. Nothing in the swap may turn a caught failure into a thrown one. Test owner: Task 3 (a helper given a `fetch` that rejects).
3. **A page served over https with the API on another origin.** The room socket (`wss://api…/ws/rooms/:id`) and uploaded images (`S3_PUBLIC_URL` origin) must not be blocked by CSP. Test owner: Task 5.
4. **A Vercel build with no `ADAPTER` set** picks `adapter-vercel`; a local build picks `adapter-node`; `ADAPTER=node` on Vercel forces node. Test owner: Task 5.
5. **Running `bun test` from the root.** It runs each test file exactly once and never resolves `$lib` outside SvelteKit. Test owner: Task 1.

---

### Task 1: Move the web app in

**Files:**
- Create: `apps/web/**`, copied from `../akashic_records_fe`. Copy `src/`, `static/`, `vite.config.ts`, `tsconfig.json`, `.env.example`, `.prettierrc`, `README.md` and `package.json`. Do not copy `Dockerfile` or `.dockerignore` yet (Task 5 brings them), nor `.github/`, `.npmrc`, `.vscode/`, `bun.lock`, `.env`, `node_modules/` or `.svelte-kit/`.
- Modify: `package.json` (root scripts), `.oxlintrc.json`, `.gitignore`, `bun.lock`, `.github/workflows/ci.yml`, `apps/web/package.json`, `apps/web/README.md`, `apps/web/src/lib/config.ts` (its doc comment still says "animerec API").

**Interfaces:**
- Produces: the workspace package `@akashic/web`, with scripts `dev`, `build`, `preview`, `typecheck` (`svelte-kit sync && svelte-check --tsconfig ./tsconfig.json`), `test`, `format` and `format:check` (prettier on `.svelte`, `src/app.css` and `src/app.html` only, per D5).
- Root scripts: `dev:web` (`bun --filter @akashic/web dev`), and a `format`, `format:check`, `lint`, `typecheck` and `test` that cover the web app.

- [ ] **Step 1: Copy the files listed above.** In `apps/web/package.json`:
  - set `valibot` to `1.5.0`;
  - remove `@sveltejs/adapter-auto` and the `lint`/`check` scripts (the root owns those).
- [ ] **Step 2: Wire the root.**
  - Root `.oxlintrc.json` ignores `apps/web/.svelte-kit/**` and `apps/web/build/**`; oxlint still skips `*.svelte`.
  - `oxfmt` covers `apps/web` `.ts` files, but not `.svelte` files. If oxfmt touches them, ignore them in `.oxfmtrc`.
  - Root `format`/`format:check` run oxfmt, then `bun --filter @akashic/web format[:check]`.
  - `.gitignore` gains `apps/web/.svelte-kit` and `apps/web/build`.
  - `bun install` updates the root `bun.lock`.
- [ ] **Step 3: Make root tests run once each (Review Focus 5).**
  - Root `test` runs the API and package tests, then `bun --filter @akashic/web test`. Use whichever mechanism Bun 1.4 supports to keep the root run out of `apps/web`, such as a `bunfig.toml` `[test]` setting or explicit paths.
  - CI runs `bun run test` instead of `bun test`.
  - Check: run `bun run test` and confirm the file count equals the API/package count (89 files today) plus the web's (3 files today: `governance.test.ts`, `messages.test.ts`, `realm-identity.test.ts`). No file may appear twice, and nothing may fail on `$lib`.
- [ ] **Step 4: Reformat the copied `.ts` files with oxfmt.** Commit that formatting separately and add its hash to `.git-blame-ignore-revs`.
- [ ] **Step 5: Verify.**
  - `bun run check` is green, with the web's svelte-check and tests in it.
  - `bun --filter @akashic/web build` produces `apps/web/build/index.js`.
  - `PUBLIC_API_BASE=http://localhost:3000 bun --filter @akashic/web dev`, then `curl -s localhost:5173/ | grep -c Akashic` gives at least 1. Stop the dev server by its port afterwards.
- [ ] **Step 6: Commit.** Use `feat(web): move the web app in as apps/web`; the formatting commit from Step 4 is separate.

### Task 2: Contracts are safe for the browser

**Files:**
- Create: `packages/contracts/src/outbox-events.ts`, holding `realmEvents` and `mailRequested` with their types, moved out of `events.ts` and wherever `mailRequested` lives.
- Modify:
  - `packages/contracts/package.json`: exports `"./events": "./src/outbox-events.ts"`;
  - `packages/contracts/src/index.ts`;
  - every API, broker and test import of the moved names, which now import from `@akashic/contracts/events`;
  - `apps/web/package.json`: add `@akashic/contracts` and `@akashic/lib` as `workspace:*`.
- Test: `apps/api/test/structure.test.ts`, `apps/web/src/lib/contracts.test.ts`.

**Interfaces:**
- Produces: `@akashic/contracts/events` (`realmEvents`, `mailRequested` and their types), plus a web app that resolves `@akashic/contracts` and `@akashic/lib/enums`.

- [ ] **Step 1: Write the failing structure tests** in `apps/api/test/structure.test.ts`:
  - `'the contracts index reaches only valibot and lib/enums|errors'`: walk relative imports from `packages/contracts/src/index.ts` and collect every bare specifier. The set must be a subset of `['valibot', '@akashic/lib/enums', '@akashic/lib/errors']`.
  - `'the web app imports only contracts and lib/enums from the workspace'`: every `@akashic/…` specifier in `apps/web/src/**/*.{ts,svelte}` is `@akashic/contracts` or `@akashic/lib/enums`.

  Run them. The first fails if the moved names pull in anything else, and passes once they are moved; the second passes vacuously until Task 3, which is fine. Show the first one failing by temporarily adding `import '@akashic/lib/log'` to `common.ts`, then revert that line.
- [ ] **Step 2: Move the event schemas** and update the imports.
- [ ] **Step 3: Write the web smoke test** `apps/web/src/lib/contracts.test.ts`: it parses a realm summary sample with `RealmSummaryView` (or whatever the contracts export for `GET /api/public/v1/realms` is named), and asserts `RealmModule.events === 1`. Then confirm svelte-check types `Temporal` in the contracts files (D2). If it can't, add `"lib": ["esnext", "DOM", "DOM.Iterable"]` to `apps/web/tsconfig.json` and say so in the report.
- [ ] **Step 4: Verify** `bun run check`, then commit `feat(contracts): server-only event schemas move to a subpath; the web app depends on contracts`.

### Task 3: The web parses responses with the contracts views (everything but rooms)

**Files:**
- Modify: `apps/web/src/lib/api/{realms,proposals,platform,governance,auth,mail,uploads,guard}.ts` and their callers in `apps/web/src/routes/**` and `apps/web/src/lib/**` where a type name changes.
- Test: `apps/web/src/lib/api/governance.test.ts` (existing), plus the new `apps/web/src/lib/api/realms.test.ts`.

**Interfaces:**
- Consumes: the `*View` schemas and enums from Task 2.
- Produces: each web schema name now refers to a contracts view, for example `export const RealmSummary = RealmSummaryView; export type RealmSummary = v.InferOutput<typeof RealmSummaryView>;`. The exported function names and signatures in `src/lib/api/*.ts` stay unchanged, so routes keep compiling. The one exception is a field type that narrows from `number` to an enum union.

- [ ] **Step 1: Write the failing tests** in `apps/web/src/lib/api/realms.test.ts`:
  - `'a realm with an unknown module drops to the fallback, never throws'`: call `listRealms({ fetch })` with a `fetch` that answers 200 with `[{ …a valid summary…, modules: [9] }]`. Expect `[]` (D1, Review Focus 1).
  - `'an unreachable API renders the empty directory'`: a `fetch` that rejects gives `[]` (Review Focus 2).
  - `'a valid summary parses with the contract view'`: the result's `modules` is typed `RealmModule[]`. Check with `expectTypeOf`-style `Equal`, written inline because the web app can't import `@akashic/lib/testing`.

  The first test fails today, because the web's loose schema accepts 9.
- [ ] **Step 2: Swap the schemas file by file.**
  - Map each web schema to its contracts view by matching the API route it reads. `apps/api/test/fixtures/web-schemas.ts` already pairs them under `Web.<name>` ↔ `contracts.<name>View` in `apps/api/test/contract.test.ts`; use that table.
  - Replace the web's enum constants (`REALM_MODULE` etc.) with `@akashic/lib/enums`, and keep the label maps.
  - A web schema with no view is a request-body or ad-hoc shape: leave it, and list it in the report.
- [ ] **Step 3: Verify.**
  - `bun run check` is green; svelte-check is the real test of this task.
  - Grep: no `v.object(` remains in `apps/web/src/lib/api/*.ts` except the shapes listed in the report.
  - Commit `feat(web): responses parse with the contracts views`.

### Task 4: Rooms use the contracts views

**Files:**
- Modify: `apps/web/src/lib/api/rooms.ts`, `apps/web/src/lib/crypto/messages.ts` (if it names message types), `apps/web/src/routes/rooms/**`.
- Modify: `apps/api/test/modules/room/room.socket.test.ts` and `apps/api/test/modules/room/fixtures.ts`. The live-frame test parses with the contracts view the web now uses, not with `Web.StoredMessage`.

**Interfaces:**
- Consumes: the room views (`StoredMessageView`, the ticket view and the transcript view, under whatever names contracts gives them) and `RoomFrameLimits`.
- Produces: `rooms.ts` keeps its exported function names (`connect`, `call` and the others). The composer's length limit comes from `RoomFrameLimits` rather than a web constant, if the web has one.

- [ ] **Step 1: Write the failing test.** In `apps/web/src/lib/crypto/messages.test.ts`, or a new `rooms.test.ts`, add `'a live frame the API sends parses with the contract view'`. Take the frame shape from the room socket test's `LiveFrame`, built from a contracts sample. It fails until `rooms.ts` exports the contracts-based schema.
- [ ] **Step 2: Swap the schemas.** Keep the end-to-end crypto logic untouched; only the schema sources change.
- [ ] **Step 3: Point `room.socket.test.ts`'s `LiveFrame`** at the contracts view, and remove the `Web` re-export from the room fixtures.
- [ ] **Step 4: Verify** `bun run check`, then commit `feat(web): rooms parse with the contracts views`.

### Task 5: Adapter and CSP chosen per build

**Files:**
- Create: `apps/web/build-config.ts` and `apps/web/build-config.test.ts`.
- Create: `apps/web/Dockerfile`, adapted from `../akashic_records_fe/Dockerfile`, and a root `.dockerignore` (or extend one if it exists) that keeps `node_modules`, `.svelte-kit`, `build`, `.env*` and `.superpowers` out of the context.
- Modify: `apps/web/vite.config.ts`, `apps/web/package.json` (add `@sveltejs/adapter-vercel`), `apps/web/.env.example`.

**Interfaces:**
- Produces, in `apps/web/build-config.ts`:
  - `type AdapterName = 'node' | 'vercel'`;
  - `chooseAdapter(env: BuildEnv): AdapterName`;
  - `cspOrigins(env: BuildEnv): CspOrigins`, where `CspOrigins` is `{ connect: string[]; img: string[] }`;
  - `interface BuildEnv { VERCEL?: string; ADAPTER?: string; PUBLIC_API_BASE?: string; PUBLIC_MEDIA_ORIGIN?: string }`.

  `vite.config.ts` calls both with `process.env` and builds the adapter and the `connect-src`/`img-src` lists from them.

- [ ] **Step 1: Write the failing tests** in `build-config.test.ts`:
  - `chooseAdapter({})` is `'node'`;
  - `chooseAdapter({ VERCEL: '1' })` is `'vercel'`;
  - `chooseAdapter({ VERCEL: '1', ADAPTER: 'node' })` is `'node'`;
  - `chooseAdapter({ ADAPTER: 'bogus' })` throws `'ADAPTER must be node or vercel'`.
  - `cspOrigins({ PUBLIC_API_BASE: 'https://api.example.com' })` gives `connect: ['self', 'wss://api.example.com']` and `img: ['self', 'data:']`.
  - With `PUBLIC_API_BASE: 'http://localhost:3000'`, connect is `['self', 'ws://localhost:3000']`.
  - With `PUBLIC_MEDIA_ORIGIN: 'https://media.example.com/bucket/'`, img gains `'https://media.example.com'` (the origin only).
  - With no API base, connect is `['self']`.

  Run them; they fail because the module doesn't exist yet.
- [ ] **Step 2: Implement `build-config.ts`.** Origins come from `new URL(x).origin`. Then wire it into `vite.config.ts`:
  - drop the AniList `IMAGE_HOSTS`, since it was an animerec leftover;
  - add `PUBLIC_MEDIA_ORIGIN` to `.env.example`, with a comment that it must match the API's `S3_PUBLIC_URL`;
  - keep the CSP's long rationale comment, and update its `connect-src` paragraph: the room socket is the one direct connection.
- [ ] **Step 3: Verify.**
  - `bun run check` passes.
  - `bun --filter @akashic/web build` gives node output.
  - `VERCEL=1 bun --filter @akashic/web build` gives `.vercel/output`; delete it afterwards and add `apps/web/.vercel` to `.gitignore`.
  - Commit `feat(web): adapter and CSP origins chosen per build`.
- [ ] **Step 4: Bring the Dockerfile (D4).**
  - Keep its three stages and comments.
  - The context is the repository root (`docker build -f apps/web/Dockerfile .`). The deps stage copies the root `package.json` and `bun.lock` plus every workspace `package.json`, so the install layer stays cached.
  - The build stage sets `ENV ADAPTER=node` and runs `bun --filter @akashic/web build`.
  - The runtime stage copies `apps/web/build` and the production dependencies only.
  - `PUBLIC_API_BASE` and `PUBLIC_MEDIA_ORIGIN` are build args, because they shape the CSP.
  - Verify: `docker build -f apps/web/Dockerfile -t akashic-web:plan4 .` succeeds. Run the image with `-p 3001:3000`; `curl -sf localhost:3001/` answers 200. Then stop and remove the container and the image.
  - Commit `build(web): the Dockerfile builds from the workspace root`.

### Task 6: One source of truth, and close-out

**Files:**
- Delete: `apps/api/test/fixtures/web-schemas.ts`, and every per-module `Web` copy under `apps/api/test/modules/**/fixtures.ts`.
- Modify:
  - `apps/api/test/contract.test.ts`: each view's sample is parsed by the view, serialized with `JSON.stringify`, then parsed again by the same view. The test asserts that every `*View` export is covered, and that the `pairs` map has no `web` field any more;
  - `apps/api/test/modules/*/…routes.test.ts`, wherever they used `Web.*`: use the contracts view instead;
  - `CLAUDE.md`;
  - the spec's "Keeping split deploys compatible" section;
  - `docs/superpowers/plans/2026-10-15-plan-2-followups.md`.

- [ ] **Step 1: Rewrite the contract test** and remove the fixtures. Show the coverage guard working once: export a dummy `ZzzView` from contracts and watch the test fail, then remove it.
- [ ] **Step 2: Update the docs.**
  - `CLAUDE.md`:
    - the web commands (`bun run dev:web`, the web's `build`);
    - the rule "`apps/web` imports only `@akashic/contracts` and `@akashic/lib/enums`; the browser talks only to the BFF, except the room socket";
    - the formatter split (D5).
  - The spec gains D1's enum line under "Keeping split deploys compatible".
  - The follow-ups doc ticks "Contracts in the web app" and "Split deploys", and moves the rest to a "Plan 5" heading.
- [ ] **Step 3: Verify** `bun run check`, then commit `chore: plan 4 close-out`.
