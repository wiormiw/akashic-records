# Plan 1: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running `akashic-records` monorepo whose API boots on Hono with InferDI, serves health, meta and better-auth routes, writes outbox events and audit entries inside transactions, publishes them to RabbitMQ, traces everything, and shuts down in order. No feature modules yet.

**Architecture:** Bun workspaces. `packages/lib` (pure helpers plus server runtime), `packages/db` (Drizzle 1.0 schema, relations, client, transaction writers), `packages/contracts` (shared Valibot schemas), `packages/authz` (OpenFGA), `packages/broker` (RabbitMQ and the outbox). `apps/api` composes them in one InferDI container (`src/container.ts`) and runs them from `src/main.ts`. Packages export factories only; nothing runs on import.

**Tech Stack:** Bun 1.4, TypeScript 7, Hono 4.13.13, Valibot 1.5.0, Drizzle ORM and drizzle-kit 1.0.0-rc.4, InferDI 6.1.0 (`@inferdi/inferdi`, `@inferdi/hono`), `@hono/otel` 1.2.0, `@hono/standard-validator` 0.4.0, OpenTelemetry, pino, better-auth, `@openfga/sdk`, `rabbitmq-client`, oxlint, oxfmt.

**Spec:** `docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md`

**Old code:** `OLD=~/Personal/GitProj/akashic_records_be` (frozen). "Copy" steps take a file from there. Read the old file before copying it; the plan names the edits, the file supplies the rest.

**This plan is 1 of 3.** Plan 2 ports the eight modules (each adds its views to `contracts`, its relations to `db`, its routes and services to `apps/api`). Plan 3 moves the web app in, sets up deployment and writes the docs. Both are written once this plan has landed, against the names it establishes.

## Global Constraints

- Bun is off PATH: run `export PATH="$HOME/.bun/bin:$PATH"` in every shell.
- Pin exact versions: `hono@4.13.13`, `valibot@1.5.0`, `drizzle-orm@1.0.0-rc.4`, `drizzle-kit@1.0.0-rc.4`, `@inferdi/inferdi@6.1.0`, `@inferdi/hono@6.1.0`, `@hono/otel@1.2.0`, `@hono/standard-validator@0.4.0`. Other dependencies keep the old repo's ranges.
- **Nothing runs on import.** No connection, timer, env read or `sdk.start()` at module top level, outside `apps/api/src/main.ts` and `if (import.meta.main)` blocks.
- **Only `apps/api/src/container.ts` imports `@inferdi/inferdi`.** `apps/api/src/app.ts` may import `@inferdi/hono`. Nothing else.
- **Stored values never change:** enum numbers, error code strings, table and column names, the cookie prefix `akashic`, the queue name `akashic.authz-sync`, the exchange `akashic.events`.
- **Error codes are never renamed.** `ErrorCode` is copied, not rewritten.
- Services return `err(fail.<kind>(code, message))`; `throw` is for bugs and infrastructure.
- Outbox events and audit entries are written only with a transaction handle (`Tx`), never the pool.
- Every outgoing response body goes through `reply()` or `respond()`. No `c.json` in routes.
- Comments say why, briefly. Match the old code's comment density.
- File names inside a package: `kebab-case.ts`. Tests: `<package>/test/<name>.test.ts`.
- Commits end with `Co-Authored-By: Claude <noreply@anthropic.com>`. No model name.
- Backslashes don't survive this shell's heredocs: write regex-bearing files with the editor tool, not `cat <<EOF`.
- Drizzle on bun:sql expands a JS array into a parameter list: bind arrays with `pgArray()` and vectors with `pgVector()`.

## Review Focus

1. **A second SIGTERM during shutdown** should exit at once, not queue a second shutdown. Pinned in Task 3 (`handleSignals` test).
2. **A request whose client disconnects mid-handler** should end as 499 with no 5xx logged and no span marked error. Pinned in Task 11 (problem handler test).
3. **A returned `err` inside `inTransaction`** must roll back rows *and* outbox events written before it. Pinned in Task 6 (integration test).
4. **A response containing a field its view doesn't declare** must not send it, and a value of the wrong type must fail as a 500, not be sent. Pinned in Task 11 (`reply` test).
5. **An environment with several bad variables** should report all of them in one error, so an operator fixes the `.env` once. Pinned in Task 3 (`loadEnv` test).

---

### Task 1: Workspace scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.oxfmtrc.json`, `.oxlintrc.json`, `.env.example`, `compose.yaml`, `deploy/` (copied), `packages/lib/package.json`, `packages/lib/tsconfig.json`, `packages/lib/test/smoke.test.ts`
- Test: `packages/lib/test/smoke.test.ts`

**Interfaces:**
- Produces: root scripts `check`, `format`, `format:check`, `lint`, `typecheck`, `test`; workspace globs `apps/*`, `packages/*`; package name scheme `@akashic/<name>`.

- [ ] **Step 1: Root files**

`package.json`:

```json
{
  "name": "akashic-records",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "format": "oxfmt apps packages",
    "format:check": "oxfmt --check apps packages",
    "lint": "oxlint --deny-warnings apps packages",
    "typecheck": "bun run --filter '*' typecheck",
    "test": "bun test",
    "check": "bun run format:check && bun run lint && bun run typecheck && bun run test"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "oxfmt": "^0.65.0",
    "oxlint": "^1.86.0",
    "typescript": "^7.0.2"
  }
}
```

`tsconfig.base.json`: copy `$OLD/tsconfig.base.json` and replace its leading comment block with `// Compiler settings every package extends.`

`.oxfmtrc.json`: `{ "printWidth": 100 }`

`.oxlintrc.json`: `{ "ignorePatterns": ["**/migrations/**", "**/node_modules/**"] }`

`.gitignore`:

```
node_modules/
.env
logs/
*.log
.svelte-kit/
build/
```

- [ ] **Step 2: Compose and its config**

```bash
cp $OLD/compose.yaml compose.yaml
cp -r $OLD/deploy deploy
cp $OLD/.env.example .env.example
```

Then delete the `migrate:` and `app:` services from `compose.yaml` (the API runs from source in development; Plan 3 adds deployment). Check every `./deploy/...` path `compose.yaml` mounts exists.

- [ ] **Step 3: First package and a smoke test**

`packages/lib/package.json`:

```json
{
  "name": "@akashic/lib",
  "private": true,
  "type": "module",
  "exports": {},
  "scripts": { "typecheck": "tsc --noEmit -p ." }
}
```

`packages/lib/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src/**/*.ts", "test/**/*.ts"] }
```

`packages/lib/test/smoke.test.ts`:

```ts
import { expect, test } from "bun:test";

test("the workspace runs tests", () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 4: Install and run the gate**

Run: `bun install && bun run check`
Expected: format, lint and typecheck pass; `1 pass`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: workspace, tooling and local services

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `@akashic/lib`, the pure part

Everything here has no dependencies, so `contracts` (and through it the web app) may import it.

**Files:**
- Create: `packages/lib/src/{result,errors,enums,time,abort,problem,json}.ts`
- Modify: `packages/lib/package.json` (exports)
- Create: `packages/lib/test/{result,abort,problem,time}.test.ts`, `packages/lib/test/expect-result.ts`
- Delete: `packages/lib/test/smoke.test.ts`

**Interfaces:**
- Produces:
  - `@akashic/lib/result`: `Result<T, E = AppError>`, `Ok<T>`, `Err<E>`, `ok`, `err`, `mapOk`
  - `@akashic/lib/errors`: `AppError`, `ErrorKind`, `fail.<kind>(code, message, options?)`, `ErrorCode` (every code the old API has)
  - `@akashic/lib/enums`: every enum from `$OLD/api/src/enums.ts`, plus `narrow`
  - `@akashic/lib/time`: `Clock`, `systemClock`, `fixedClock`, `mutableClock`, `toDate`, `fromDate`, `isBefore`
  - `@akashic/lib/abort`: `untilAborted`, `isAbortOf`
  - `@akashic/lib/problem`: `ProblemBody`, `PROBLEM_CONTENT_TYPE`, `httpStatusByKind`, `toProblem(error, traceId)`
  - `@akashic/lib/json`: `JsonValue`

- [ ] **Step 1: Copy the files that need no change**

```bash
L=packages/lib/src; mkdir -p $L
cp $OLD/api/src/platform/result.ts $L/result.ts
cp $OLD/api/src/enums.ts $L/enums.ts
cp $OLD/api/src/platform/time.ts $L/time.ts
cp $OLD/api/src/platform/abort.ts $L/abort.ts
```

In `result.ts`, change `from "./errors.ts"` to stay `./errors.ts` (same folder now). In `enums.ts`, change the comment reference `authz/model.ts` to `@akashic/authz`.

- [ ] **Step 2: Merge the error vocabulary into one file**

Create `packages/lib/src/errors.ts` from `$OLD/api/src/platform/errors.ts`, then:
- rename `PlatformErrorCode` to a non-exported `base` constant;
- append the merged `ErrorCode` from `$OLD/api/src/errors.ts` (spread `base`, then `external`, `realm`, `event` exactly as there, with their comments);
- drop the re-exports at the bottom of the old `errors.ts`.

Every code string must be identical to the old files. Verify:

```bash
diff <(grep -ohE '"[a-z_]+(\.[a-z_]+)+"' $OLD/api/src/errors.ts $OLD/api/src/platform/errors.ts | sort -u) \
     <(grep -ohE '"[a-z_]+(\.[a-z_]+)+"' packages/lib/src/errors.ts | sort -u)
```

Expected: no output.

- [ ] **Step 3: Problem rendering in one file**

Create `packages/lib/src/problem.ts` by concatenating `$OLD/api/src/platform/problem/status.ts` and `$OLD/api/src/platform/problem/render.ts`, importing `AppError`, `ErrorKind` from `./errors.ts` and dropping the cross-file import between them.

Create `packages/lib/src/json.ts`:

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
```

- [ ] **Step 4: Exports**

In `packages/lib/package.json`, set:

```json
"exports": {
  "./result": "./src/result.ts",
  "./errors": "./src/errors.ts",
  "./enums": "./src/enums.ts",
  "./time": "./src/time.ts",
  "./abort": "./src/abort.ts",
  "./problem": "./src/problem.ts",
  "./json": "./src/json.ts"
}
```

- [ ] **Step 5: Tests**

Copy `$OLD/api/test/platform/abort.test.ts` to `packages/lib/test/abort.test.ts` and `$OLD/api/test/http/result.test.ts`'s Result-only cases (any case not using Elysia) to `packages/lib/test/result.test.ts`, rewriting imports to `@akashic/lib/...`.

`packages/lib/test/expect-result.ts` (copy of `$OLD/api/test/result.ts` with imports from `@akashic/lib/errors` and `@akashic/lib/result`). Every package's tests import it by relative path from here, or from their own copy; it is test-only.

`packages/lib/test/problem.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { toProblem } from "@akashic/lib/problem";

describe("problem", () => {
  test("a kind decides the status, and the code is on the body", () => {
    const { status, body } = toProblem(fail.conflict(ErrorCode.realm.duplicateSlug, "Taken."), "t1");
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "realm.duplicate_slug", detail: "Taken.", traceId: "t1" });
  });

  test("an internal error never shows its message", () => {
    const { status, body } = toProblem(
      fail.internal(ErrorCode.common.unexpected, "password=hunter2"),
      "t1",
    );
    expect(status).toBe(500);
    expect(body.detail).not.toContain("hunter2");
  });
});
```

`packages/lib/test/time.test.ts`:

```ts
import { expect, test } from "bun:test";
import { fixedClock, fromDate, isBefore, toDate } from "@akashic/lib/time";

test("instants round-trip through Date at millisecond precision", () => {
  const at = fixedClock("2026-06-01T12:00:00.123Z").now();
  expect(fromDate(toDate(at)).equals(at)).toBe(true);
  expect(isBefore(at, at.add({ seconds: 1 }))).toBe(true);
});
```

Delete `packages/lib/test/smoke.test.ts`.

- [ ] **Step 6: Run**

Run: `bun run check`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(lib): result, errors, enums, time, abort and problem rendering

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `@akashic/lib`, the runtime part

**Files:**
- Create: `packages/lib/src/{log,config,lifecycle,concurrency,retry,circuit-breaker}.ts`
- Modify: `packages/lib/package.json` (dependencies, exports)
- Test: `packages/lib/test/{config,lifecycle,concurrency,circuit-breaker}.test.ts`

**Interfaces:**
- Consumes: `@akashic/lib/errors`
- Produces:
  - `@akashic/lib/log`: `Logger`, `createLogger(options)`, `silentLogger()`
  - `@akashic/lib/config`: `str`, `int`, `bool`, `url`, `optionalUrl`, `oneOfEnv`, `baseEnv`, `loadEnv(schema, raw)`, `assertNestedBudget(name, innerMs, outerMs)`
  - `@akashic/lib/lifecycle`: `Phase`, `Lifecycle`, `createLifecycle(logger)`, `handleSignals(options)`, `owned(value, release)`
  - `@akashic/lib/concurrency`, `@akashic/lib/retry`, `@akashic/lib/circuit-breaker`: as in the old files

- [ ] **Step 1: Dependencies**

```bash
cd packages/lib && bun add pino@^10.3.1 valibot@1.5.0 p-limit@^7.3.1 @opentelemetry/api@^1.9.1 && cd ../..
```

Add to `exports`: `"./log"`, `"./config"`, `"./lifecycle"`, `"./concurrency"`, `"./retry"`, `"./circuit-breaker"`, each to `./src/<name>.ts`.

- [ ] **Step 2: Copy the unchanged helpers**

```bash
L=packages/lib/src
cp $OLD/api/src/platform/log.ts $L/log.ts
cp $OLD/api/src/platform/concurrency.ts $L/concurrency.ts
cp $OLD/api/src/platform/retry.ts $L/retry.ts
cp $OLD/api/src/platform/circuit-breaker.ts $L/circuit-breaker.ts
cp $OLD/api/test/platform/concurrency.test.ts packages/lib/test/
cp $OLD/api/test/platform/circuit-breaker.test.ts packages/lib/test/
```

Rewrite their relative imports of old platform files to the new siblings, and test imports to `@akashic/lib/<name>`.

- [ ] **Step 3: Write the failing config test**

`packages/lib/test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { bool, int, loadEnv, str, url } from "@akashic/lib/config";

const Schema = v.object({
  PORT: int({ min: 1, default: 3000 }),
  DATABASE_URL: url(),
  TRUST_PROXY: bool(false),
  FGA_STORE_ID: str({ minLength: 1 }),
});

describe("loadEnv", () => {
  test("coerces strings and applies defaults", () => {
    const env = loadEnv(Schema, {
      DATABASE_URL: "postgres://localhost/x",
      FGA_STORE_ID: "s1",
      TRUST_PROXY: "true",
    });
    expect(env).toEqual({
      PORT: 3000,
      DATABASE_URL: "postgres://localhost/x",
      TRUST_PROXY: true,
      FGA_STORE_ID: "s1",
    });
  });

  test("an empty value means unset, so the default applies", () => {
    expect(loadEnv(Schema, { PORT: "", DATABASE_URL: "postgres://x/y", FGA_STORE_ID: "s" }).PORT)
      .toBe(3000);
  });

  test("reports every bad key at once", () => {
    expect(() => loadEnv(Schema, { PORT: "zero", DATABASE_URL: "not a url" })).toThrow(
      /PORT[\s\S]*DATABASE_URL[\s\S]*FGA_STORE_ID|PORT[\s\S]*FGA_STORE_ID[\s\S]*DATABASE_URL/,
    );
  });
});
```

Run: `bun test packages/lib/test/config.test.ts`
Expected: FAIL, cannot resolve `@akashic/lib/config`.

- [ ] **Step 4: Write `config.ts`**

`packages/lib/src/config.ts`. Use the editor tool (it contains a regex-free but backslash-free body; still, keep heredocs out of it):

```ts
import * as v from "valibot";

// Every variable arrives as a string. These builders coerce one, apply its default (given as the
// string an operator would write), and validate the result.

export const str = (options: { minLength?: number; default?: string } = {}) =>
  v.optional(
    v.pipe(v.string(), v.minLength(options.minLength ?? 0, "must not be empty")),
    options.default,
  );

export const int = (options: { min?: number; max?: number; default?: number } = {}) =>
  v.pipe(
    v.optional(v.string(), options.default === undefined ? undefined : String(options.default)),
    v.string("is required"),
    v.transform(Number),
    v.integer("must be an integer"),
    v.minValue(options.min ?? Number.MIN_SAFE_INTEGER, `must be at least ${options.min}`),
    v.maxValue(options.max ?? Number.MAX_SAFE_INTEGER, `must be at most ${options.max}`),
  );

export const bool = (fallback: boolean) =>
  v.pipe(
    v.optional(v.picklist(["true", "false", "1", "0"], "must be true or false"), String(fallback)),
    v.transform((value) => value === "true" || value === "1"),
  );

export const url = (fallback?: string) =>
  v.optional(v.pipe(v.string("is required"), v.url("must be a URL")), fallback);

/** An optional URL with no default: absent stays undefined. */
export const optionalUrl = () => v.optional(v.pipe(v.string(), v.url("must be a URL")));

export const oneOfEnv = <const T extends readonly [string, ...string[]]>(values: T, fallback?: T[number]) =>
  v.optional(v.picklist(values, `must be one of ${values.join(", ")}`), fallback);

/** Settings every app needs. Apps spread this into their own `v.object`. */
export const baseEnv = {
  NODE_ENV: oneOfEnv(["development", "test", "production"], "development"),
  LOG_LEVEL: oneOfEnv(["trace", "debug", "info", "warn", "error", "fatal"], "info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: url("http://localhost:4318"),
  OTEL_METRIC_INTERVAL_MS: int({ min: 1000, default: 15000 }),
  // How long in-flight requests get to finish after a stop signal, and the hard limit on the
  // whole shutdown. The second must exceed the first.
  DRAIN_TIMEOUT_MS: int({ min: 0, default: 10000 }),
  SHUTDOWN_TIMEOUT_MS: int({ min: 0, default: 15000 }),
};

/**
 * Parses and validates settings. Throws one message listing every bad key, so an operator fixes
 * the whole `.env` at once rather than one rerun per mistake.
 */
export function loadEnv<S extends v.GenericSchema>(
  schema: S,
  raw: Record<string, string | undefined>,
): v.InferOutput<S> {
  // An empty value (`KEY=` in a .env) means unset, so the key takes its default.
  const present = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== ""));
  const parsed = v.safeParse(schema, present, { abortPipeEarly: true });
  if (parsed.success) return parsed.output;

  const problems = new Map<string, string>();
  for (const issue of parsed.issues) {
    const name = v.getDotPath(issue) ?? "(root)";
    if (!problems.has(name)) problems.set(name, issue.message);
  }
  const lines = [...problems].map(([name, message]) => `  ${name}: ${message}`).join("\n");
  throw new Error(`Invalid environment configuration:\n${lines}`);
}

/** Throws when an inner call's timeout can outlive the request waiting on it. */
export function assertNestedBudget(name: string, innerMs: number, outerMs: number): void {
  if (innerMs < outerMs) return;
  throw new Error(
    `Invalid environment configuration:\n  ${name}=${innerMs} is not shorter than ${outerMs}; ` +
      "the outer wait would end before the inner call could fail.",
  );
}
```

Run: `bun test packages/lib/test/config.test.ts`
Expected: PASS. If the "every bad key" case fails because Valibot stops at the first entry, the fix is that `v.object` checks all entries by default; `abortPipeEarly` only stops inside one pipe. Do not add `abortEarly`.

- [ ] **Step 5: Write the failing lifecycle test**

`packages/lib/test/lifecycle.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createLifecycle, handleSignals, owned } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";

describe("lifecycle", () => {
  test("draining fails readiness but keeps the root signal live until abort", () => {
    const life = createLifecycle(silentLogger());
    life.markReady();
    life.beginDraining("SIGTERM");
    expect(life.isReady()).toBe(false);
    expect(life.signal.aborted).toBe(false);
    life.abort("SIGTERM");
    expect(life.signal.aborted).toBe(true);
    expect(life.isAlive()).toBe(true);
    life.markStopped();
    expect(life.isAlive()).toBe(false);
  });

  test("a linked signal aborts with the root", () => {
    const life = createLifecycle(silentLogger());
    const linked = life.linkedSignal(60_000);
    life.abort("done");
    expect(linked.aborted).toBe(true);
  });

  test("owned values release when disposed", async () => {
    const release = mock(async () => {});
    const value = owned({ name: "pool" }, release);
    await value[Symbol.asyncDispose]();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("handleSignals", () => {
  test("the first signal shuts down once; a second exits at once", async () => {
    const events = new EventTarget();
    const exits: number[] = [];
    let finish!: () => void;
    const shutdown = mock(() => new Promise<void>((resolve) => (finish = resolve)));

    handleSignals({
      shutdown,
      hardExitMs: 60_000,
      logger: silentLogger(),
      exit: (code) => void exits.push(code),
      on: (signal, listener) => events.addEventListener(signal, listener),
    });

    events.dispatchEvent(new Event("SIGTERM"));
    events.dispatchEvent(new Event("SIGTERM"));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([1]);

    finish();
    await Bun.sleep(0);
    expect(exits).toEqual([1, 0]);
  });
});
```

Run: `bun test packages/lib/test/lifecycle.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 6: Write `lifecycle.ts`**

```ts
import type { Logger } from "./log.ts";

export type Phase = "starting" | "ready" | "draining" | "stopped";

/**
 * Where the process is in its life, and the root signal every long-running loop watches. It
 * doesn't own teardown: the container disposes what it built, in reverse. This only says when.
 */
export interface Lifecycle {
  readonly signal: AbortSignal;
  phase(): Phase;
  isReady(): boolean;
  isAlive(): boolean;
  markReady(): void;
  /** Readiness fails from here; requests in flight carry on. */
  beginDraining(reason: string): void;
  /** Tells everything still running to stop. */
  abort(reason: string): void;
  markStopped(): void;
  /** Aborts on shutdown, on timeout, or on any of the given signals. */
  linkedSignal(timeoutMs: number, ...signals: (AbortSignal | undefined)[]): AbortSignal;
}

export function createLifecycle(logger: Logger): Lifecycle {
  const log = logger.child({ component: "lifecycle" });
  const root = new AbortController();
  let phase: Phase = "starting";

  return {
    signal: root.signal,
    phase: () => phase,
    isReady: () => phase === "ready",
    isAlive: () => phase !== "stopped",
    markReady() {
      phase = "ready";
      log.info("ready");
    },
    beginDraining(reason) {
      if (phase === "draining" || phase === "stopped") return;
      phase = "draining";
      log.info({ reason }, "draining");
    },
    abort(reason) {
      if (!root.signal.aborted) root.abort(new Error(`shutting down: ${reason}`));
    },
    markStopped() {
      phase = "stopped";
      log.info("stopped");
    },
    linkedSignal(timeoutMs, ...signals) {
      return AbortSignal.any([
        root.signal,
        AbortSignal.timeout(timeoutMs),
        ...signals.filter((s): s is AbortSignal => s !== undefined),
      ]);
    },
  };
}

/** `value`, released by `release` when its owner disposes it. For things the container builds. */
export function owned<T extends object>(
  value: T,
  release: () => Promise<void> | void,
): T & AsyncDisposable {
  return Object.assign(value, {
    async [Symbol.asyncDispose]() {
      await release();
    },
  });
}

export interface SignalOptions {
  shutdown: (reason: string) => Promise<void>;
  /** After this, exit whether or not shutdown finished. */
  hardExitMs: number;
  logger: Logger;
  exit?: (code: number) => void;
  on?: (signal: string, listener: () => void) => void;
}

/**
 * The one place process signals are handled. The first SIGTERM or SIGINT shuts down and exits 0;
 * a second, or the hard deadline, exits 1 at once. A crash shuts down and exits 1.
 */
export function handleSignals(options: SignalOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const on = options.on ?? ((signal, listener) => process.on(signal, listener));
  const log = options.logger.child({ component: "lifecycle" });
  let stopping = false;

  const stop = (reason: string, code: number) => {
    if (stopping) {
      log.warn({ reason }, "second signal, exiting now");
      exit(1);
      return;
    }
    stopping = true;
    setTimeout(() => {
      log.error("shutdown exceeded its deadline, exiting");
      exit(1);
    }, options.hardExitMs).unref();
    options.shutdown(reason).then(
      () => exit(code),
      (error: unknown) => {
        log.error({ err: error }, "shutdown failed");
        exit(1);
      },
    );
  };

  on("SIGTERM", () => stop("SIGTERM", 0));
  on("SIGINT", () => stop("SIGINT", 0));
  on("unhandledRejection", () => stop("unhandledRejection", 1));
  on("uncaughtException", () => stop("uncaughtException", 1));
}
```

The `unhandledRejection` and `uncaughtException` listeners receive the error as their argument when attached to `process`; log it there by changing those two lines to `(error) => { log.fatal({ err: error }, "crash"); stop(...) }` if `on`'s type allows it, which requires widening `on`'s listener to `(...args: unknown[]) => void`. Do that, and keep the test passing.

Run: `bun test packages/lib/test/lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the gate and commit**

Run: `bun run check`
Expected: all pass.

```bash
git add -A && git commit -m "feat(lib): logging, config on Valibot, lifecycle and signal handling

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Telemetry and custom spans

**Files:**
- Create: `packages/lib/src/{tracing,telemetry,metrics}.ts`, `packages/lib/test/spans.ts`
- Test: `packages/lib/test/tracing.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@akashic/lib/errors`, `owned` from `@akashic/lib/lifecycle`
- Produces:
  - `@akashic/lib/tracing`: `tracer()`, `traced(name, attributes, fn, options?)`, `withConsumerSpan(name, traceparent, fn, attributes?)`, `currentTraceparent()`, `SpanKind`
  - `@akashic/lib/telemetry`: `createTelemetry(options): AsyncDisposable`
  - `@akashic/lib/metrics`: `meter()`
  - test helper `packages/lib/test/spans.ts`: `recordSpans(): { spans(): ReadableSpan[]; reset(): void }`

- [ ] **Step 1: Dependencies and exports**

```bash
cd packages/lib && bun add @opentelemetry/sdk-node@^0.221.0 @opentelemetry/exporter-trace-otlp-http@^0.221.0 \
  @opentelemetry/exporter-metrics-otlp-http@^0.221.0 @opentelemetry/resources@^2.10.0 \
  @opentelemetry/sdk-metrics@^2.10.0 @opentelemetry/semantic-conventions@^1.43.0 \
  && bun add -d @opentelemetry/sdk-trace-base@^2.10.0 @opentelemetry/context-async-hooks@^2.10.0 && cd ../..
```

Add exports `"./tracing"`, `"./telemetry"`, `"./metrics"`.

- [ ] **Step 2: Test helper that captures spans**

`packages/lib/test/spans.ts`:

```ts
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/** Registers an in-memory tracer for the test file, so assertions can read the spans. */
export function recordSpans() {
  const exporter = new InMemorySpanExporter();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
  return { spans: () => exporter.getFinishedSpans(), reset: () => exporter.reset() };
}
```

- [ ] **Step 3: Failing tracing test**

`packages/lib/test/tracing.test.ts`:

```ts
import { beforeEach, describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok } from "@akashic/lib/result";
import { currentTraceparent, traced, withConsumerSpan } from "@akashic/lib/tracing";
import { recordSpans } from "./spans.ts";

const recorder = recordSpans();
beforeEach(() => recorder.reset());

describe("traced", () => {
  test("ends the span with its attributes on success", async () => {
    expect(await traced("authz.check", { "akashic.realm.id": "r1" }, async () => 7)).toBe(7);
    const [span] = recorder.spans();
    expect(span?.name).toBe("authz.check");
    expect(span?.attributes["akashic.realm.id"]).toBe("r1");
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  test("a returned err marks the span with its code, without throwing", async () => {
    const result = await traced("realm.approve", {}, async () =>
      err(fail.conflict(ErrorCode.realm.duplicateSlug, "Taken.")),
    );
    expect(result.ok).toBe(false);
    const [span] = recorder.spans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes["akashic.error.code"]).toBe("realm.duplicate_slug");
  });

  test("a throw is recorded and rethrown", async () => {
    await expect(traced("mail.send", {}, async () => { throw new Error("down"); })).rejects.toThrow("down");
    expect(recorder.spans()[0]?.events[0]?.name).toBe("exception");
  });

  test("an abort is cancelled, not an error", async () => {
    const reason = new DOMException("stop", "AbortError");
    await expect(traced("authz.check", {}, async () => { throw reason; })).rejects.toBe(reason);
    const [span] = recorder.spans();
    expect(span?.attributes["akashic.cancelled"]).toBe(true);
    expect(span?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  test("an ok value passes through untouched", async () => {
    expect(await traced("x", {}, async () => ok(1))).toEqual(ok(1));
  });
});

describe("propagation", () => {
  test("a consumer span continues the producer's trace", async () => {
    const parent = await traced("publish", {}, async () => currentTraceparent());
    await withConsumerSpan("consume realm.member_changed", parent, async () => undefined);
    const [producer, consumer] = recorder.spans();
    expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
  });
});
```

Run: `bun test packages/lib/test/tracing.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write `tracing.ts`**

Start from `$OLD/api/src/platform/tracing.ts`. Keep `withConsumerSpan` and `currentTraceparent` unchanged. Delete `withServerSpan` and `nameServerSpan` (`@hono/otel` creates the server span). Change the tracer name from `"animerec"` to `"akashic"` and export it as `tracer()`. Replace `withSpan` with:

```ts
/** A returned Result that failed. Recognised structurally, so lib doesn't depend on its callers. */
const isFailedResult = (value: unknown): value is { ok: false; error: AppError } =>
  typeof value === "object" &&
  value !== null &&
  (value as { ok?: unknown }).ok === false &&
  (value as { error?: unknown }).error instanceof AppError;

/**
 * Runs `fn` in an active span and always ends it. A throw is recorded as an exception; an abort is
 * marked cancelled instead, since being told to stop isn't failing; a returned `err` marks the span
 * failed with its code, so a business refusal shows in the trace without being an exception.
 */
export function traced<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: { kind?: SpanKind } = {},
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes, kind: options.kind }, async (span) => {
    try {
      const value = await fn(span);
      if (isFailedResult(value)) {
        span.setAttribute("akashic.error.code", value.error.code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: value.error.message });
      }
      return value;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        span.setAttribute("akashic.cancelled", true);
      } else {
        const thrown = error instanceof Error ? error : new Error(String(error));
        span.recordException(thrown);
        span.setStatus({ code: SpanStatusCode.ERROR, message: thrown.message });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export { SpanKind } from "@opentelemetry/api";
```

Import `AppError` from `./errors.ts`.

Run: `bun test packages/lib/test/tracing.test.ts`
Expected: PASS.

- [ ] **Step 5: Telemetry and metrics**

`packages/lib/src/telemetry.ts`: copy `$OLD/api/src/platform/telemetry.ts`, rename `startTelemetry` to `createTelemetry`, and return `owned({}, shutdown)` instead of `{ shutdown }`, where `shutdown` is the existing flush-and-swallow function. Rewrite the doc comment: "Registers the global tracer and meter providers and starts exporting. The container creates this right after config and disposes it last, so spans recorded during shutdown are flushed."

`packages/lib/src/metrics.ts`:

```ts
import { metrics } from "@opentelemetry/api";

/** The meter for this service's own instruments. A no-op until telemetry is created. */
export const meter = () => metrics.getMeter("akashic");
```

- [ ] **Step 6: Gate and commit**

Run: `bun run check`
Expected: all pass.

```bash
git add -A && git commit -m "feat(lib): telemetry, traced spans and trace propagation

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `@akashic/db`: schema, relations, row schemas, client

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/drizzle.config.ts`
- Create: `packages/db/src/schema/{columns,auth,realm,room,outbox,audit,index}.ts` (copied)
- Create: `packages/db/src/{relations,rows,sql,client,index}.ts`
- Create: `packages/db/migrations/` (generated)
- Test: `packages/db/test/{rows,sql}.test.ts`, `packages/db/test/client.integration.test.ts`

**Interfaces:**
- Consumes: `@akashic/lib/{enums,log,time}`
- Produces:
  - `@akashic/db`: `schema` (namespace), every table, `relations`, `createDb(options): Database`, types `Db`, `Tx`, `Executor`
  - `Database`: `{ db: Db; sql: SQL; ping(): Promise<boolean> } & AsyncDisposable`
  - `@akashic/db/rows`: `selectRow.<table>` and `insertRow.<table>` Valibot schemas
  - `@akashic/db/sql`: `pgArray`, `pgVector`, `parseVector`, `containing`
  - `@akashic/db/migrations` path constant: `migrationsFolder` exported from `@akashic/db`

- [ ] **Step 1: Package**

```bash
mkdir -p packages/db/src/schema packages/db/test
cd packages/db && bun init -y >/dev/null 2>&1; rm -f index.ts README.md
bun add drizzle-orm@1.0.0-rc.4 valibot@1.5.0 @akashic/lib@workspace:* && bun add -d drizzle-kit@1.0.0-rc.4 && cd ../..
```

`packages/db/package.json` (keep the dependency entries `bun add` wrote):

```json
{
  "name": "@akashic/db",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./rows": "./src/rows.ts",
    "./sql": "./src/sql.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p .",
    "generate": "drizzle-kit generate"
  }
}
```

`packages/db/tsconfig.json`: same as lib's, including `drizzle.config.ts`.

- [ ] **Step 2: Copy the schema**

```bash
S=packages/db/src/schema
for f in columns auth realm room outbox audit index; do cp $OLD/api/src/db/schema/$f.ts $S/$f.ts; done
cp $OLD/api/src/adapters/postgres/sql.ts packages/db/src/sql.ts
grep -n 'from "@/' $S/*.ts
```

Rewrite each `@/enums.ts` import to `@akashic/lib/enums`, and any `@/ports/...` constant import (the embedding width) to a local constant in `realm.ts` with the same value and a comment naming where it is used. Remove the `fallow-ignore` comment in `sql.ts`.

Keep every table name, column name, index name and default exactly as copied.

- [ ] **Step 3: Compile against Drizzle 1.0**

Run: `bunx tsc --noEmit -p packages/db`
Expected: either clean, or errors only where 1.0 changed an API. For each error, change the call to the 1.0 form without changing the generated SQL (names, types, defaults). Record each change in the commit message body. Do not change `json()` in `columns.ts` unless it fails to compile: the reason it exists (bun:sql storing a stringified value as a JSON scalar) is verified in Task 6's integration test.

- [ ] **Step 4: Relations**

`packages/db/src/relations.ts`:

```ts
import { defineRelations } from "drizzle-orm";
import * as schema from "./schema/index.ts";

// Relations the relational query API (`db.query.*`) follows. Modules add theirs as they need
// them; each `many` needs the `one` on the other side.
export const relations = defineRelations(schema, (r) => ({
  realms: {
    members: r.many.realmMembers(),
    modules: r.many.realmModules(),
  },
  realmMembers: {
    realm: r.one.realms({ from: r.realmMembers.realmId, to: r.realms.id }),
    user: r.one.user({ from: r.realmMembers.userId, to: r.user.id }),
  },
  realmModules: {
    realm: r.one.realms({ from: r.realmModules.realmId, to: r.realms.id }),
  },
}));
```

- [ ] **Step 5: Row schemas, with a failing test first**

`packages/db/test/rows.test.ts`:

```ts
import { expect, test } from "bun:test";
import * as v from "valibot";
import { selectRow } from "@akashic/db/rows";

test("a row schema checks a row's columns, and is not an API view", () => {
  const row = {
    id: "0190a000-0000-7000-8000-000000000000",
    userId: null,
    entityType: "realm",
    entityId: "0190a000-0000-7000-8000-000000000001",
    action: 0,
    changes: null,
    traceId: null,
    occurredAt: new Date("2026-06-01T00:00:00Z"),
  };
  expect(v.parse(selectRow.auditEntries, row)).toEqual(row);
  expect(v.safeParse(selectRow.auditEntries, { ...row, action: "zero" }).success).toBe(false);
});
```

Run: `bun test packages/db/test/rows.test.ts`
Expected: FAIL, cannot resolve `@akashic/db/rows`.

`packages/db/src/rows.ts`:

```ts
import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as schema from "./schema/index.ts";

// What a row looks like, for scripts that validate what they read and for building API views
// with `v.pick`. Never sent as is: a row carries columns the API must not show.

type Tables = {
  [K in keyof typeof schema as (typeof schema)[K] extends { $inferSelect: unknown } ? K : never]:
    (typeof schema)[K];
};

const tables = Object.fromEntries(
  Object.entries(schema).filter(([, value]) => typeof value === "object" && value !== null && "$inferSelect" in value),
) as unknown as Tables;

export const selectRow = Object.fromEntries(
  Object.entries(tables).map(([name, table]) => [name, createSelectSchema(table)]),
) as { [K in keyof Tables]: ReturnType<typeof createSelectSchema<Tables[K]>> };

export const insertRow = Object.fromEntries(
  Object.entries(tables).map(([name, table]) => [name, createInsertSchema(table)]),
) as { [K in keyof Tables]: ReturnType<typeof createInsertSchema<Tables[K]>> };
```

If the mapped `ReturnType<typeof createSelectSchema<...>>` doesn't typecheck against 1.0's generics, replace the two mapped objects with explicit entries per table (`auditEntries: createSelectSchema(schema.auditEntries)`, one line per table). The test is the contract, not the generic trick.

Run: `bun test packages/db/test/rows.test.ts`
Expected: PASS.

- [ ] **Step 6: SQL helper test**

`packages/db/test/sql.test.ts`:

```ts
import { expect, test } from "bun:test";
import { containing, parseVector, pgArray, pgVector } from "@akashic/db/sql";

test("array and vector literals bind as one text parameter", () => {
  expect(pgArray(["a", 'b"c'])).toBe('{"a","b\\"c"}');
  expect(pgVector([0.5, 0.25])).toBe("[0.5,0.25]");
  expect(parseVector("[0.5,0.25]")).toEqual([0.5, 0.25]);
  expect(containing("50%_off")).toBe("%50\\%\\_off%");
});
```

Write this file with the editor tool (backslashes). Run it. Expected: PASS.

- [ ] **Step 7: The client**

`packages/db/src/client.ts`:

```ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Logger } from "@akashic/lib/log";
import { relations } from "./relations.ts";

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  idleTimeoutS: number;
  connectTimeoutS: number;
  /**
   * Server-side limits, set on every connection. Postgres cancels the statement and frees the
   * connection. Omitted for scripts, which may legitimately run long.
   */
  limits?: { statementTimeoutMs: number; lockTimeoutMs: number; idleInTransactionTimeoutMs: number };
  logger: Logger;
}

const connect = (sql: SQL) => drizzle({ client: sql, relations });

export type Db = ReturnType<typeof connect>;
/** Drizzle's transaction handle. Outbox events and audit entries take only this. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The pool or an open transaction. */
export type Executor = Db | Tx;

export interface Database extends AsyncDisposable {
  db: Db;
  sql: SQL;
  /** Proves the connection works. It does not prove the schema is migrated. */
  ping(): Promise<boolean>;
}

/** Opens a pool. Nothing connects until the first query; `ping` at startup fails fast. */
export function createDb(options: DatabaseOptions): Database {
  const log = options.logger.child({ component: "db" });
  const sql = new SQL({
    url: options.url,
    max: options.poolMax,
    // Infrastructure closes idle connections without telling the client; recycle first.
    idleTimeout: options.idleTimeoutS,
    maxLifetime: 60 * 30,
    connectionTimeout: options.connectTimeoutS,
    ...(options.limits && {
      connection: {
        statement_timeout: options.limits.statementTimeoutMs,
        lock_timeout: options.limits.lockTimeoutMs,
        idle_in_transaction_session_timeout: options.limits.idleInTransactionTimeoutMs,
      },
    }),
  });

  return {
    db: connect(sql),
    sql,
    async ping() {
      try {
        await sql`SELECT 1`;
        return true;
      } catch (error) {
        log.error({ err: error }, "database ping failed");
        return false;
      }
    },
    async [Symbol.asyncDispose]() {
      await sql.close({ timeout: 5 });
      log.info("connection pool closed");
    },
  };
}
```

`packages/db/src/index.ts`:

```ts
export * from "./schema/index.ts";
export * as schema from "./schema/index.ts";
export { relations } from "./relations.ts";
export { createDb, type Database, type DatabaseOptions, type Db, type Executor, type Tx } from "./client.ts";

/** Where drizzle-kit writes migrations and the migrator reads them. */
export const migrationsFolder = new URL("../migrations", import.meta.url).pathname;
```

`packages/db/drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
});
```

- [ ] **Step 8: Client integration test**

`packages/db/test/client.integration.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { silentLogger } from "@akashic/lib/log";
import { createDb } from "@akashic/db";

const url = Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";
const database = createDb({ url, poolMax: 2, idleTimeoutS: 5, connectTimeoutS: 2, logger: silentLogger() });
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)("database", () => {
  test("statement timeout is enforced by Postgres", async () => {
    const limited = createDb({
      url, poolMax: 1, idleTimeoutS: 5, connectTimeoutS: 2, logger: silentLogger(),
      limits: { statementTimeoutMs: 50, lockTimeoutMs: 50, idleInTransactionTimeoutMs: 1000 },
    });
    await expect(limited.sql`SELECT pg_sleep(1)`).rejects.toThrow(/statement timeout/);
    await limited[Symbol.asyncDispose]();
  });
});
```

- [ ] **Step 9: Back up the current database**

The old database is about to be replaced. With compose running (`docker compose up -d postgres`):

```bash
mkdir -p ~/akashic-backups
docker compose exec -T postgres pg_dump -U akashic -d akashic -Fc > ~/akashic-backups/akashic-$(date +%Y%m%d-%H%M).dump
docker compose exec -T postgres pg_dump -U akashic -d akashic --data-only -Fc > ~/akashic-backups/akashic-data-$(date +%Y%m%d-%H%M).dump
ls -la ~/akashic-backups
```

Expected: two non-empty files. Write their paths into the commit message body.

- [ ] **Step 10: Baseline migration and restore**

```bash
cd packages/db && bunx drizzle-kit generate --name baseline && cd ../..
grep -c "CREATE TABLE" packages/db/migrations/*/migration.sql packages/db/migrations/*.sql 2>/dev/null
```

Expected: one migration, with as many `CREATE TABLE` statements as `pgTable(` calls in `src/schema` (`grep -c "pgTable(" packages/db/src/schema/*.ts`). Extensions the old migrations created (`citext`, `vector`) must be in it; if drizzle-kit omits `CREATE EXTENSION`, add a custom migration before the baseline with `bunx drizzle-kit generate --custom --name extensions` containing `CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS vector;`.

Recreate and restore:

```bash
docker compose exec -T postgres psql -U akashic -d postgres -c "DROP DATABASE akashic WITH (FORCE)" -c "CREATE DATABASE akashic OWNER akashic"
DATABASE_URL=postgres://akashic:akashic@localhost:5432/akashic bun -e '
import { SQL } from "bun"; import { drizzle } from "drizzle-orm/bun-sql"; import { migrate } from "drizzle-orm/bun-sql/migrator";
const c = new SQL({ url: Bun.env.DATABASE_URL, max: 1 }); await migrate(drizzle({ client: c }), { migrationsFolder: "packages/db/migrations" }); await c.close(); console.log("migrated");'
docker compose exec -T postgres pg_restore -U akashic -d akashic --data-only --disable-triggers < ~/akashic-backups/<the data dump>
```

Expected: `migrated`, then `pg_restore` with no errors. An error naming a table or column means the schema changed during the port: fix the schema, regenerate, and repeat this step. `__drizzle_migrations` rows from the old dump may conflict; if so, restore with `--exclude-table=__drizzle_migrations` (or `-L` with that entry removed) and say so in the commit.

- [ ] **Step 11: Gate and commit**

Run: `bun run check`
Expected: all pass, the integration test runs (not skipped).

```bash
git add -A && git commit -m "feat(db): schema on Drizzle 1.0, relations, row schemas, client, baseline migration

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Transactions, outbox writer and audit writer

**Files:**
- Create: `packages/db/src/{transaction,outbox,audit}.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/test/transaction.integration.test.ts`

**Interfaces:**
- Consumes: `Db`, `Tx` (Task 5); `Result`, `AppError` (Task 2); `traced`, `currentTraceparent` (Task 4); `JsonValue` (Task 2)
- Produces (from `@akashic/db`):
  - `inTransaction<T>(db: Db, work: (tx: Tx) => Promise<Result<T>>, attributes?: Attributes): Promise<Result<T>>`
  - `DomainEvent { type: string; payload: Record<string, JsonValue> }`
  - `publish(tx: Tx, events: readonly DomainEvent[], now: Temporal.Instant): Promise<void>`
  - `AuditEntry { actorId: string | null; entityType: string; entityId: string; action: AuditAction; changes?: Record<string, unknown> }`
  - `audit(tx: Tx, ...entries: AuditEntry[]): Promise<void>`

- [ ] **Step 1: Failing integration test**

`packages/db/test/transaction.integration.test.ts`:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { err, ok } from "@akashic/lib/result";
import { audit, auditEntries, createDb, inTransaction, outboxMessages, publish } from "@akashic/db";

const url = Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";
const database = createDb({ url, poolMax: 2, idleTimeoutS: 5, connectTimeoutS: 2, logger: silentLogger() });
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());
const now = Temporal.Instant.from("2026-06-01T12:00:00Z");

describe.skipIf(!live)("inTransaction", () => {
  test("a returned err rolls back rows and events written before it", async () => {
    const entityId = Bun.randomUUIDv7();
    const result = await inTransaction(database.db, async (tx) => {
      await publish(tx, [{ type: "test.rolled_back", payload: { entityId } }], now);
      await audit(tx, { actorId: null, entityType: "test", entityId, action: AuditAction.create });
      return err(fail.conflict(ErrorCode.realm.duplicateSlug, "Taken."));
    });
    expect(result.ok).toBe(false);
    expect(await database.db.select().from(auditEntries).where(eq(auditEntries.entityId, entityId))).toEqual([]);
    const events = await database.db.select().from(outboxMessages).where(eq(outboxMessages.messageType, "test.rolled_back"));
    expect(events.filter((e) => (e.payload as { entityId: string }).entityId === entityId)).toEqual([]);
  });

  test("an ok commits, and jsonb is stored as an object, not a string", async () => {
    const entityId = Bun.randomUUIDv7();
    const result = await inTransaction(database.db, async (tx) => {
      await publish(tx, [{ type: "test.committed", payload: { entityId } }], now);
      return ok(entityId);
    });
    expect(result).toEqual(ok(entityId));
    const [row] = await database.sql`
      SELECT jsonb_typeof(payload) AS kind FROM outbox_messages
      WHERE message_type = 'test.committed' AND payload->>'entityId' = ${entityId}`;
    expect(row.kind).toBe("object");
    await database.sql`DELETE FROM outbox_messages WHERE payload->>'entityId' = ${entityId}`;
  });
});
```

Check `AuditAction` has a `create` member in `$OLD/api/src/enums.ts`; if its first member is named differently, use that member.

Run: `bun test packages/db/test/transaction.integration.test.ts`
Expected: FAIL, `inTransaction` is not exported.

- [ ] **Step 2: `transaction.ts`**

```ts
import type { Attributes } from "@opentelemetry/api";
import type { Result } from "@akashic/lib/result";
import { traced } from "@akashic/lib/tracing";
import type { Db, Tx } from "./client.ts";

/** Carries a returned `err` out of Drizzle's callback; never leaves this file. */
class Rollback<T> extends Error {
  constructor(readonly result: Result<T>) {
    super("rolled back");
  }
}

/**
 * Runs `work` in one transaction: commits on `ok`, rolls back on `err` or a throw, so a failure
 * found halfway never commits the half already written, nor its events.
 */
export function inTransaction<T>(
  db: Db,
  work: (tx: Tx) => Promise<Result<T>>,
  attributes: Attributes = {},
): Promise<Result<T>> {
  return traced("db.transaction", { "db.system.name": "postgresql", ...attributes }, async () => {
    try {
      return await db.transaction(async (tx) => {
        const result = await work(tx);
        // Drizzle rolls back only on a throw.
        if (!result.ok) throw new Rollback(result);
        return result;
      });
    } catch (error) {
      if (error instanceof Rollback) return error.result as Result<T>;
      throw error;
    }
  });
}
```

Add `@opentelemetry/api` to `packages/db` dependencies (`bun add @opentelemetry/api@^1.9.1` in `packages/db`).

- [ ] **Step 3: `outbox.ts` and `audit.ts`**

`outbox.ts`: move `enqueue` from `$OLD/api/src/platform/outbox/store.ts`, and `newOutboxEvent` with the types it needs from `$OLD/api/src/platform/outbox/event.ts`, renaming `enqueue` to `publish` with the signature `publish(tx: Tx, events: readonly DomainEvent[], now: Temporal.Instant)`. It must stamp `traceparent` from `currentTraceparent()` into the row's `headers`, exactly as the old `enqueue` does. Export `DomainEvent` from here (copied from `$OLD/api/src/ports/outbox.ts`, importing `JsonValue` from `@akashic/lib/json`).

`audit.ts`: `AuditEntry` copied from `$OLD/api/src/ports/audit.ts`, and:

```ts
/** Records audit entries in the caller's transaction, so they commit with the change. */
export async function audit(tx: Tx, ...entries: AuditEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const traceId = currentTraceparent() ?? null;
  await tx.insert(auditEntries).values(
    entries.map(({ actorId, changes, ...entry }) => ({
      ...entry,
      userId: actorId,
      changes: changes ?? null,
      traceId,
    })),
  );
}
```

Export all three files' public names from `src/index.ts`.

- [ ] **Step 4: Run and commit**

Run: `bun test packages/db` then `bun run check`
Expected: all pass; integration tests ran.

```bash
git add -A && git commit -m "feat(db): transactions that roll back on err, outbox and audit writers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: `@akashic/contracts`: shared building blocks

**Files:**
- Create: `packages/contracts/{package.json,tsconfig.json}`, `packages/contracts/src/{common,problem,index}.ts`
- Test: `packages/contracts/test/common.test.ts`

**Interfaces:**
- Consumes: `@akashic/lib/enums`, `@akashic/lib/errors` only (dependency-free subpaths)
- Produces (from `@akashic/contracts`):
  - `Timestamp`, `iso(instant)`, `isoOrNull(instant | null)`, `Uuid`, `Created`, `IdParam`
  - `PageLimit`, `ListLimit` (query integers: accept a string or a number, output a number)
  - `oneOf(enumObject)` (picklist of the enum's values), `trimmed({ minLength?, maxLength? })`
  - `Slug`, `RealmSlugParam`, `RealmItemParam`, `RealmMemberParam`, `SubjectParam`, `subjectOf(params)`
  - `Problem` (the problem+json body)

- [ ] **Step 1: Package**

`packages/contracts/package.json`:

```json
{
  "name": "@akashic/contracts",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit -p ." },
  "dependencies": { "valibot": "1.5.0", "@akashic/lib": "workspace:*" }
}
```

`tsconfig.json` as lib's. Run `bun install`.

- [ ] **Step 2: Failing test**

`packages/contracts/test/common.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { CommentSubject } from "@akashic/lib/enums";
import { ListLimit, Slug, Timestamp, iso, oneOf, subjectOf, trimmed } from "@akashic/contracts";

describe("contracts", () => {
  test("a timestamp at nanosecond precision is a valid date-time", () => {
    const at = iso(Temporal.Instant.from("2026-06-01T12:00:00.123456789Z"));
    expect(v.parse(Timestamp, at)).toBe("2026-06-01T12:00:00.123456789Z");
  });

  test("a query limit accepts the string a URL carries, with a default", () => {
    expect(v.parse(ListLimit, "5")).toBe(5);
    expect(v.parse(ListLimit, undefined)).toBe(20);
    expect(v.safeParse(ListLimit, "500").success).toBe(false);
  });

  test("trimmed measures its minimum after trimming", () => {
    expect(v.parse(trimmed({ minLength: 3 }), "  abc  ")).toBe("abc");
    expect(v.safeParse(trimmed({ minLength: 3 }), "  ab  ").success).toBe(false);
  });

  test("oneOf accepts exactly an enum's values", () => {
    expect(v.parse(oneOf(CommentSubject), 1)).toBe(1);
    expect(v.safeParse(oneOf(CommentSubject), 9).success).toBe(false);
  });

  test("slugs and subjects", () => {
    expect(v.safeParse(Slug, "print-makers").success).toBe(true);
    expect(v.safeParse(Slug, "Print--makers").success).toBe(false);
    expect(subjectOf({ kind: "jobs", id: "x" })).toEqual({ kind: CommentSubject.job, id: "x" });
  });
});
```

Run: `bun test packages/contracts`
Expected: FAIL, cannot resolve `@akashic/contracts`.

- [ ] **Step 3: `common.ts`** (editor tool: it has regexes)

```ts
import * as v from "valibot";
import { CommentSubject } from "@akashic/lib/enums";

/** Schema pieces more than one module's contract uses. */

/** A moment on the wire: ISO 8601 in UTC. Services hold Temporal.Instant; presenters call `iso`. */
export const Timestamp = v.pipe(v.string(), v.isoTimestamp());
export const iso = (instant: Temporal.Instant): string => instant.toString();
export const isoOrNull = (instant: Temporal.Instant | null): string | null =>
  instant && instant.toString();

export const Uuid = v.pipe(v.string(), v.uuid());

/** What creating something answers: the new id, and nothing else. */
export const Created = v.object({ id: v.string() });
export const IdParam = v.object({ id: Uuid });

/** An integer from a query string (or a number, from a typed client), with bounds and a default. */
const queryInt = (min: number, max: number, fallback: number) =>
  v.pipe(
    v.optional(v.union([v.string(), v.number()]), fallback),
    v.transform(Number),
    v.integer(),
    v.minValue(min),
    v.maxValue(max),
  );

export const PageLimit = queryInt(1, 200, 50);
export const ListLimit = queryInt(1, 100, 20);

/** Every value of an enum object. */
export const oneOf = <const E extends Record<string, string | number>>(members: E) =>
  v.picklist(Object.values(members) as E[keyof E][]);

/** A string trimmed before the handler sees it, with its bounds measured after trimming. */
export const trimmed = (options: { minLength?: number; maxLength?: number }) =>
  v.pipe(
    v.string(),
    v.trim(),
    v.minLength(options.minLength ?? 0),
    v.maxLength(options.maxLength ?? Number.MAX_SAFE_INTEGER),
  );

/** A realm's URL name: lowercase words separated by single dashes. */
export const Slug = v.pipe(
  v.string(),
  v.minLength(2),
  v.maxLength(48),
  v.regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase words separated by single dashes."),
);

export const RealmSlugParam = v.object({ slug: Slug });
export const RealmItemParam = v.object({ slug: Slug, id: Uuid });
export const RealmMemberParam = v.object({ slug: Slug, userId: Uuid });

const SUBJECT_BY_SEGMENT = {
  events: CommentSubject.event,
  listings: CommentSubject.listing,
  jobs: CommentSubject.job,
} as const;

/** `/realms/:slug/:kind/:id`, where kind names the kind of posting in the URL. */
export const SubjectParam = v.object({
  slug: Slug,
  kind: v.picklist(["events", "listings", "jobs"]),
  id: Uuid,
});

/** The posting a SubjectParam path names. */
export const subjectOf = (params: { kind: keyof typeof SUBJECT_BY_SEGMENT; id: string }) => ({
  kind: SUBJECT_BY_SEGMENT[params.kind],
  id: params.id,
});
```

`problem.ts`:

```ts
import * as v from "valibot";

/** RFC 9457 problem details, as every failure is rendered. */
export const Problem = v.object({
  type: v.string(),
  title: v.string(),
  status: v.number(),
  detail: v.string(),
  code: v.string(),
  details: v.optional(v.record(v.string(), v.unknown())),
  traceId: v.string(),
});
```

`index.ts`: `export * from "./common.ts"; export * from "./problem.ts";`

If `v.isoTimestamp()` rejects nanosecond precision, replace it with `v.check((s) => !Number.isNaN(Date.parse(s)) && /Z$/.test(s), "ISO 8601 UTC timestamp")`, since Temporal emits up to nine fractional digits.

Run: `bun test packages/contracts && bun run check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(contracts): shared Valibot building blocks for requests and responses

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: `@akashic/authz`

**Files:**
- Create: `packages/authz/{package.json,tsconfig.json,model.fga}`, `packages/authz/src/{vocabulary,authorizer,index}.ts`
- Test: `packages/authz/test/{cancellation,spans}.test.ts`, `packages/authz/test/model.integration.test.ts`

**Interfaces:**
- Consumes: `@akashic/lib/{errors,abort,log,tracing,circuit-breaker}`
- Produces (from `@akashic/authz`): `FgaType`, `PLATFORM_ID`, `Relation`, `RANK_RELATION`, `Check`, `Subject`, `Tuple`, `Authorizer`, `createAuthorizer(options): Authorizer`, `modelPath`

- [ ] **Step 1: Copy**

```bash
mkdir -p packages/authz/src packages/authz/test
cp $OLD/api/authz/model.fga packages/authz/model.fga
cp $OLD/api/src/ports/authz.ts packages/authz/src/vocabulary.ts
cp $OLD/api/src/adapters/openfga/authorizer.ts packages/authz/src/authorizer.ts
cp $OLD/api/test/adapters/openfga-cancellation.test.ts packages/authz/test/cancellation.test.ts
cp $OLD/api/test/integration/authz-model.test.ts packages/authz/test/model.integration.test.ts
```

Package as the others; dependencies `@openfga/sdk@^0.9.7`, `@openfga/syntax-transformer@^0.2.2`, `@akashic/lib@workspace:*`, `@opentelemetry/api@^1.9.1`. Rewrite imports (`@/ports/authz.ts` → `./vocabulary.ts`, `@/errors.ts` → `@akashic/lib/errors`, `@/platform/...` → `@akashic/lib/...`). Rename `createOpenFgaAuthorizer` to `createAuthorizer`. Fix the model path in the integration test to `new URL("../model.fga", import.meta.url).pathname`.

`src/index.ts`:

```ts
export * from "./vocabulary.ts";
export { createAuthorizer, type OpenFgaOptions } from "./authorizer.ts";
/** The model `authz:push` writes to OpenFGA. */
export const modelPath = new URL("../model.fga", import.meta.url).pathname;
```

- [ ] **Step 2: Failing span test**

`packages/authz/test/spans.test.ts`: build the authorizer against an unroutable URL with a 50 ms timeout (as `cancellation.test.ts` does), call `check(...)`, expect it to reject, then assert one span named `authz.check` with `akashic.fga.relation` set to the checked relation. Import `recordSpans` from `../../lib/test/spans.ts`.

```ts
import { expect, test } from "bun:test";
import { silentLogger } from "@akashic/lib/log";
import { FgaType, Relation, createAuthorizer } from "@akashic/authz";
import { recordSpans } from "../../lib/test/spans.ts";

const recorder = recordSpans();

test("each OpenFGA call is a span named for the operation", async () => {
  const authorizer = createAuthorizer({
    apiUrl: "http://127.0.0.1:9", storeId: "01H0000000000000000000000", timeoutMs: 50, logger: silentLogger(),
  });
  await expect(
    authorizer.check({ userId: "u1", relation: Relation.realm.post, type: FgaType.realm, objectId: "r1" }),
  ).rejects.toThrow();
  const span = recorder.spans().find((s) => s.name === "authz.check");
  expect(span?.attributes["akashic.fga.relation"]).toBe("can_post");
});
```

Run it. Expected: FAIL (no span).

- [ ] **Step 3: Spans in the authorizer**

Wrap each public method's body in `traced`: `check` → `"authz.check"` with `{ "akashic.fga.type": check.type, "akashic.fga.relation": check.relation }`; `checkMany` → `"authz.check_many"` with `{ "akashic.fga.count": checks.length }`; `write` → `"authz.write"` with `{ "akashic.fga.writes": writes?.length ?? 0, "akashic.fga.deletes": deletes?.length ?? 0 }`; `listObjects` → `"authz.list_objects"` with type and relation. No user ids in attributes.

Run: `bun test packages/authz && bun run check`
Expected: PASS; the model integration test runs when OpenFGA is up (`docker compose up -d openfga`).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(authz): OpenFGA vocabulary, authorizer and model, with spans

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: `@akashic/broker`: RabbitMQ and the outbox dispatcher

**Files:**
- Create: `packages/broker/{package.json,tsconfig.json}`, `packages/broker/src/{connection,publisher,consumer,event,store,dispatcher,replay,metrics,queues,index}.ts`
- Test: copied unit tests for event and delivery handling, `packages/broker/test/spans.test.ts`, `packages/broker/test/{broker,outbox}.integration.test.ts`

**Interfaces:**
- Consumes: `@akashic/db` (`Db`, `outboxMessages`, `newOutboxEvent`), `@akashic/lib/{lifecycle,log,time,tracing,metrics,concurrency,retry}`
- Produces (from `@akashic/broker`):
  - `EVENTS_EXCHANGE = "akashic.events"`, `Queues = { authzSync: "akashic.authz-sync" }`
  - `createBroker`, `Broker`; `createBrokerPublisher`, `BrokerPublisher`, `BrokerMessage`
  - `createEventConsumer(options)`, `EventConsumer`, `EventHandler`, `createDeliveryHandler`
  - `createOutboxStore(db)`, `OutboxStore`, `OutboxRecovery`; `createOutbox(options): Outbox & AsyncDisposable`
  - `replayDead`, `deadCount`
  - `observeOutbox(store, options)` metrics registration

- [ ] **Step 1: Copy**

```bash
B=packages/broker/src; mkdir -p $B packages/broker/test
cp $OLD/api/src/platform/broker/{connection,publisher,consumer,replay}.ts $B/
cp $OLD/api/src/platform/outbox/{event,store,dispatcher}.ts $B/
cp $OLD/api/test/platform/outbox*.test.ts $OLD/api/test/platform/broker*.test.ts packages/broker/test/ 2>/dev/null; ls packages/broker/test
cp $OLD/api/test/integration/broker.test.ts packages/broker/test/broker.integration.test.ts
cp $OLD/api/test/integration/outbox.test.ts packages/broker/test/outbox.integration.test.ts
```

If the old event and delivery unit tests live elsewhere (`grep -rl "claimUntil\|createDeliveryHandler" $OLD/api/test`), copy those too. Dependencies: `rabbitmq-client@^5.0.8`, `@akashic/lib@workspace:*`, `@akashic/db@workspace:*`, `drizzle-orm@1.0.0-rc.4`, `@opentelemetry/api@^1.9.1`.

Imports: `@/db/schema/outbox.ts` → `@akashic/db`; `../db.ts` types → `@akashic/db` (`Db`, `Executor`); old platform siblings → `@akashic/lib/...`. `store.ts` loses `enqueue` (it moved to `@akashic/db` in Task 6); import `newOutboxEvent` and the event types it still needs from `@akashic/db` or keep them in `event.ts`, whichever leaves one definition of each.

- [ ] **Step 2: Replace `lifecycle.onShutdown` with disposal**

The old dispatcher, consumer and relay registered their own teardown. Now the container owns teardown. In `dispatcher.ts`, delete the `lifecycle.onShutdown("outbox", () => stopped)` call and return the outbox as `owned(outbox, () => stopped)` (`owned` from `@akashic/lib/lifecycle`), so disposing it waits for the loop to finish. In `consumer.ts`, do the same with whatever the old `start` registered (search for `onShutdown`). The `lifecycle` option stays for its `signal` and `linkedSignal`.

Add a unit test to the copied dispatcher test file:

```ts
test("disposing the outbox waits for the loop to stop", async () => {
  // Build the outbox exactly as the existing tests in this file do, with a store whose claim
  // returns []; call start(); abort the lifecycle; then:
  await outbox[Symbol.asyncDispose]();
  expect(claims).toBeGreaterThan(0); // it ran, and it has stopped without hanging
});
```

Fill in the setup from the file's existing tests (they already build an outbox with a fake store and lifecycle).

- [ ] **Step 3: Producer span, failing test first**

`packages/broker/test/spans.test.ts`:

```ts
import { expect, test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import { createBrokerPublisher } from "@akashic/broker";
import { recordSpans } from "../../lib/test/spans.ts";

const recorder = recordSpans();

test("publishing is a producer span whose context travels in the message headers", async () => {
  const sent: Record<string, unknown>[] = [];
  const broker = {
    connection: {
      createPublisher: () => ({
        send: async (envelope: { headers?: Record<string, unknown> }) => void sent.push(envelope.headers ?? {}),
        close: async () => {},
      }),
    },
  };
  const publisher = createBrokerPublisher({ broker: broker as never, exchange: "akashic.events", confirmTimeoutMs: 1000 });
  await publisher.publish({ id: "e1", type: "realm.member_changed", routingKey: "realm.member_changed", payload: {}, headers: {} });
  const span = recorder.spans().find((s) => s.name === "publish realm.member_changed");
  expect(span?.kind).toBe(SpanKind.PRODUCER);
  expect(String(sent[0]?.traceparent)).toContain(span?.spanContext().spanId ?? "missing");
});
```

Shape the fake `broker` to whatever `createBrokerPublisher` actually calls (read `publisher.ts`); the assertions are the contract.

Then in `publisher.ts`, wrap `publish` in `traced(\`publish ${message.type}\`, { "messaging.system": "rabbitmq", "messaging.destination.name": exchange, "messaging.message.id": message.id }, ..., { kind: SpanKind.PRODUCER })`, and inside it set `headers.traceparent = currentTraceparent()`, overriding the outbox row's stored value: the stored one points at the request that wrote the event, and is kept as the span's link instead (`span.addLink` from the stored traceparent when present).

Consumer side: `consumer.ts` already calls `withConsumerSpan`; keep it, and add `"messaging.system": "rabbitmq"` and `"messaging.destination.name": queue` to its attributes.

Dispatcher: wrap one drain in `traced("outbox.drain", { "akashic.outbox.batch_size": batchSize }, ...)` and record the count claimed as `akashic.outbox.claimed`.

- [ ] **Step 4: Metrics**

`packages/broker/src/metrics.ts`:

```ts
import { meter } from "@akashic/lib/metrics";
import type { Db } from "@akashic/db";
import { sql } from "drizzle-orm";

/**
 * Outbox backlog and dead count as observable gauges, read when the exporter collects. A growing
 * backlog means the broker is down or slow; any dead event needs a person.
 */
export function observeOutbox(db: Db) {
  const backlog = meter().createObservableGauge("akashic.outbox.pending", {
    description: "Outbox events waiting to be published",
  });
  const dead = meter().createObservableGauge("akashic.outbox.dead", {
    description: "Outbox events that gave up and need a person",
  });
  meter().addBatchObservableCallback(
    async (result) => {
      const [row] = (await db.execute(sql`
        SELECT count(*) FILTER (WHERE status = 0)::int AS pending,
               count(*) FILTER (WHERE status = 3)::int AS dead
        FROM outbox_messages`)) as unknown as { pending: number; dead: number }[];
      result.observe(backlog, row?.pending ?? 0);
      result.observe(dead, row?.dead ?? 0);
    },
    [backlog, dead],
  );
}

const retries = () => meter().createCounter("akashic.consumer.retries");
const parked = () => meter().createCounter("akashic.consumer.parked");

/** Counted by the delivery handler when it sets a message aside. */
export const consumerMetrics = { retries, parked };
```

In `consumer.ts`'s `setAside`, call `consumerMetrics.parked().add(1, { queue })` when parking and `consumerMetrics.retries().add(1, { queue })` otherwise. Create the counters once per handler (in `createDeliveryHandler`), not per message.

`queues.ts`:

```ts
/** The topic exchange every domain event is published to, routed by its type. */
export const EVENTS_EXCHANGE = "akashic.events";

/** Every queue a consumer reads. Stored in RabbitMQ: never rename one. */
export const Queues = { authzSync: "akashic.authz-sync" } as const;
```

`index.ts` re-exports every public name listed in this task's Interfaces.

- [ ] **Step 5: Run and commit**

Run: `docker compose up -d rabbitmq postgres && bun test packages/broker && bun run check`
Expected: all pass, integration tests ran.

```bash
git add -A && git commit -m "feat(broker): RabbitMQ, outbox dispatcher and consumer, with producer and consumer spans and metrics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: API config and integrations

**Files:**
- Create: `apps/api/{package.json,tsconfig.json}`, `apps/api/src/config.ts`
- Create: `apps/api/src/integrations/{mail,storage,embedder,redis,relay,counters}.ts` (copied)
- Test: copied `ai.test.ts`, `upload` storage tests that don't need routes, `apps/api/test/integrations/spans.test.ts`

**Interfaces:**
- Consumes: `@akashic/lib/config`, `@akashic/lib/*`
- Produces:
  - `Env` (Valibot schema) and `type Env`, `policy` from `apps/api/src/config.ts`
  - `createResendMailer`, `Mailer`, `MailHealth`; `createS3ImageStore`, `ImageStore`; `createEmbedder`, `Embedder`; `createRedis`, `Redis`; `createRedisRelay`, `createLocalRelay`, `Relay`; `createRateLimiter`, `createRedisCounters`, `createMemoryCounters`, `RateLimiter`, `RateLimitRule`

- [ ] **Step 1: Package**

`apps/api/package.json`:

```json
{
  "name": "@akashic/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --env-file=../../.env --watch src/main.ts",
    "start": "bun src/main.ts",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

Add dependencies: `hono@4.13.13`, `@hono/otel@1.2.0`, `@hono/standard-validator@0.4.0`, `@inferdi/inferdi@6.1.0`, `@inferdi/hono@6.1.0`, `valibot@1.5.0`, `better-auth@^1.7.4`, `resend@^6.22.1`, `drizzle-orm@1.0.0-rc.4`, `@opentelemetry/api@^1.9.1`, and the workspace packages `@akashic/{lib,db,contracts,authz,broker}`.

`apps/api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "paths": { "@/*": ["./src/*"] } },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"]
}
```

- [ ] **Step 2: Config on Valibot**

`apps/api/src/config.ts`: port `$OLD/api/src/config.ts` and the API-specific keys of `$OLD/api/src/platform/config.ts`'s `baseEnv` into one `v.object({ ...baseEnv, ... })` using the builders from `@akashic/lib/config`. Every key, default, bound and comment carries over. Mappings: `Type.Integer({ minimum, maximum, default })` → `int({ min, max, default })`; `Type.Boolean({ default })` → `bool(default)`; `url()` → `url()`; `url({ default })` → `url(default)`; `Type.Optional(url())` → `optionalUrl()`; `Type.String()` → `str({ minLength: 1 })`; `Type.String({ default })` → `str({ default })`; `Type.Optional(Type.String())` → `v.optional(v.string())`; literal unions → `oneOfEnv([...])`. `OTEL_SERVICE_NAME` defaults to `"akashic"`. `policy` is copied unchanged.

Add a test `apps/api/test/config.test.ts` that loads `.env.example`'s keys with dummy values (`DATABASE_URL`, `BETTER_AUTH_SECRET` of 32 chars, `BETTER_AUTH_URL`, `FGA_STORE_ID`, `RABBITMQ_URL`) and asserts the defaults: `PORT === 3000`, `OUTBOX_BATCH_SIZE === 50`, `RABBITMQ_MAX_ATTEMPTS === 5`, `AI_EMBED_MODEL === "gemini-embedding-001"`; and that omitting `RABBITMQ_URL` throws naming it.

- [ ] **Step 3: Copy integrations**

```bash
I=apps/api/src/integrations; mkdir -p $I apps/api/test/integrations
cp $OLD/api/src/platform/mail.ts $I/mail.ts
cp $OLD/api/src/adapters/storage/s3.ts $I/storage.ts
cp $OLD/api/src/adapters/ai/embedder.ts $I/embedder.ts
cp $OLD/api/src/platform/redis.ts $I/redis.ts
cp $OLD/api/src/platform/relay.ts $I/relay.ts
cat $OLD/api/src/platform/rate-limit/{counters,memory-counters,redis-counters}.ts > $I/counters.ts
cp $OLD/api/src/platform/rate-limit/limiter.ts $I/rate-limit.ts
cp $OLD/api/test/adapters/ai.test.ts apps/api/test/integrations/embedder.test.ts
ls $OLD/api/src/adapters/ai/
```

Copy any other file in `adapters/ai/` the embedder imports. Merge `counters.ts`'s three parts into one coherent file (one import block). Interfaces the old ports defined (`Embedder` from `ports/embedder.ts`, `ImageStore` from `ports/storage.ts`) move into the integration file that implements them. Rewrite imports to `@akashic/lib/...`. Replace `lifecycle.onShutdown(...)` in `relay.ts` and `counters.ts` with `owned(...)` as in Task 9 Step 2. `createMemoryCounters` takes `{ signal?: AbortSignal }` instead of `{ lifecycle?: Lifecycle }`: its sweep timer stops when the signal aborts, and the returned store is `owned` so disposal clears the timer too. In `rate-limit.ts`, delete the Elysia-shaped `Budgeted` and `guard`; keep `hit` and `RateLimitRule`. The middleware is written in Task 11.

- [ ] **Step 4: Spans on outgoing calls, failing test first**

`apps/api/test/integrations/spans.test.ts`: with `recordSpans()`, create the mailer with `apiKey: undefined` (it logs instead of sending) and call `send`; create the embedder with a provider whose fetch fails fast; create the image store with no bucket and call `put`. Assert spans `mail.send`, `embedder.embed`, `storage.put` exist. No email address or message content in any attribute: assert `JSON.stringify(span.attributes)` does not contain the recipient.

Then wrap: mailer `send` → `traced("mail.send", { "akashic.mail.has_link": Boolean(message.link) }, ...)`; embedder request → `traced("embedder.embed", { "akashic.ai.provider": provider, "akashic.ai.model": model }, ...)`; storage `put` and `delete` → `traced("storage.put" | "storage.delete", { "akashic.storage.bucket": bucket }, ...)`.

- [ ] **Step 5: Run and commit**

Run: `bun test apps/api && bun run check`
Expected: all pass.

```bash
git add -A && git commit -m "feat(api): config on Valibot and the API's integrations, with spans

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: HTTP layer on Hono

**Files:**
- Create: `apps/api/src/http/{env,problem,reply,validate,request-context,security,rate-limit,session,auth-routes,meta}.ts`, `apps/api/src/auth/{auth,bans}.ts`
- Test: `apps/api/test/http/{problem,reply,validate,security,request-context,rate-limit,session}.test.ts`

**Interfaces:**
- Consumes: Tasks 2-10
- Produces:
  - `AppEnv` (Hono env type): `Variables: { requestId: string; signal: AbortSignal; user: Caller | null }`
  - `Caller { id: string; email: string }`
  - `problemHandler(logger): ErrorHandler<AppEnv>`, `notFound: NotFoundHandler<AppEnv>`, `problemResponse(c, error)`
  - `reply(c, view, value, status?)`, `respond(c, result, view, status?)`
  - `validate(target, schema)` (validator middleware rendering `common.validation` problems)
  - `requestContext({ budgetMs, logger, lifecycle, service })`, `REQUEST_ID_HEADER`
  - `security({ allowedOrigins, maxBodyBytes, largeBodyPaths })`, `parseOrigins(value)`
  - `rateLimit(limiter, rule)`
  - `sessions({ auth, db, authorizer })` → `{ session, maybeSession, platformAdmin }` middleware
  - `authRoutes({ auth, limiter, ordinary, credentials })`
  - `healthRoutes({ lifecycle, required, optional })`, `metaRoutes({ service, mailer })`
  - `createAuth(options)`, `Auth`; `banOf(db, userId, options?)`, `banFrom`, `banMessage`, `Ban`

- [ ] **Step 1: `env.ts`**

```ts
import type { Env as HonoEnv } from "hono";

export interface Caller {
  readonly id: string;
  readonly email: string;
}

/** What every request carries, set by middleware before any route runs. */
export interface AppEnv extends HonoEnv {
  Variables: {
    requestId: string;
    /** Aborts on client disconnect, the request deadline, or shutdown. */
    signal: AbortSignal;
    user: Caller | null;
  };
}
```

- [ ] **Step 2: `reply` and `respond`, failing test first**

`apps/api/test/http/reply.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import * as v from "valibot";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { err, ok } from "@akashic/lib/result";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { reply, respond } from "@/http/reply.ts";

const View = v.object({ id: v.string(), status: v.picklist([0, 1]) });

const app = new Hono<AppEnv>()
  .use(async (c, next) => { c.set("requestId", "req-1"); await next(); })
  .get("/leaky", (c) => reply(c, View, { id: "a", status: 0, email: "x@y.z" } as never))
  .get("/bad", (c) => reply(c, View, { id: "a", status: 9 } as never))
  .get("/created", (c) => respond(c, ok({ id: "a", status: 1 as const }), View, 201))
  .get("/refused", (c) => respond(c, err(fail.conflict(ErrorCode.realm.duplicateSlug, "Taken.")), View));
app.onError(problemHandler(silentLogger()));

describe("reply", () => {
  test("an undeclared field never leaves", async () => {
    const res = await app.request("/leaky");
    expect(await res.json()).toEqual({ id: "a", status: 0 });
  });

  test("a value outside the view fails as our error, not sent", async () => {
    const res = await app.request("/bad");
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("common.server.unexpected");
  });

  test("respond sends an ok with its status, and an err as problem+json", async () => {
    expect((await app.request("/created")).status).toBe(201);
    const refused = await app.request("/refused");
    expect(refused.status).toBe(409);
    expect(refused.headers.get("content-type")).toContain("application/problem+json");
    expect((await refused.json()).traceId).toBe("req-1");
  });
});
```

Run: `bun test apps/api/test/http/reply.test.ts`. Expected: FAIL, modules missing.

- [ ] **Step 3: `problem.ts`**

```ts
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { AppError, ErrorCode, fail } from "@akashic/lib/errors";
import type { Logger } from "@akashic/lib/log";
import { PROBLEM_CONTENT_TYPE, toProblem } from "@akashic/lib/problem";
import type { AppEnv } from "./env.ts";

// nginx's "client closed request": keeps disconnects out of the 5xx count.
const CLIENT_CLOSED_REQUEST = 499;

/** The problem+json response for a failure; also how `respond` renders a returned `err`. */
export function problemResponse(c: Context<AppEnv>, failure: AppError): Response {
  const { body, status } = toProblem(failure, c.get("requestId") ?? "");
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": PROBLEM_CONTENT_TYPE },
  });
}

/** The one place a thrown failure becomes a response. */
export function problemHandler(logger: Logger): ErrorHandler<AppEnv> {
  const log = logger.child({ component: "http" });
  return (error, c) => {
    if (c.req.raw.signal.aborted) return new Response(null, { status: CLIENT_CLOSED_REQUEST });

    const failure = classify(error);
    const traceId = c.get("requestId");
    if (failure.kind === "internal") {
      log.error({ err: error, path: c.req.path, method: c.req.method, traceId }, "unhandled error");
    } else if (failure.kind === "external") {
      // A dependency failing is worth a line; a 4xx is the API working.
      log.warn({ err: failure.cause ?? failure, code: failure.code, path: c.req.path, traceId }, failure.message);
    }
    return problemResponse(c, failure);
  };
}

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  problemResponse(c, fail.notFound(ErrorCode.common.routeNotFound, `No route for ${c.req.path}.`));

/** Maps whatever escaped a handler onto the error vocabulary. */
function classify(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return fail.external(ErrorCode.common.timeout, "The request took too long.");
  }
  return fail.internal(ErrorCode.common.unexpected, "Unexpected error", { cause: error });
}
```

Add `apps/api/test/http/problem.test.ts` covering: a thrown `AppError` renders its status and code; an unknown route renders `common.route.not_found` with 404; a handler that throws after the request's signal aborted returns 499 (build the request with an `AbortController`, abort it inside the handler, then throw).

- [ ] **Step 4: `reply.ts`**

```ts
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import * as v from "valibot";
import type { Result } from "@akashic/lib/result";
import type { AppEnv } from "./env.ts";
import { problemResponse } from "./problem.ts";

/**
 * Sends `value` as `view` describes it. Parsing drops keys the view doesn't declare, so a column
 * added to a query never reaches the wire; a value the view rejects throws, and is our bug.
 */
export function reply<S extends v.GenericSchema>(
  c: Context<AppEnv>,
  view: S,
  value: v.InferInput<S>,
  status: ContentfulStatusCode = 200,
): Response {
  return c.json(v.parse(view, value) as object, status);
}

/** A service's Result as the answer: the value through `view`, or the problem a throw would be. */
export function respond<S extends v.GenericSchema>(
  c: Context<AppEnv>,
  result: Result<v.InferInput<S>>,
  view: S,
  status: ContentfulStatusCode = 200,
): Response {
  return result.ok ? reply(c, view, result.value, status) : problemResponse(c, result.error);
}
```

Run: `bun test apps/api/test/http/reply.test.ts apps/api/test/http/problem.test.ts`. Expected: PASS.

- [ ] **Step 5: `validate.ts`, failing test first**

`apps/api/test/http/validate.test.ts`: a route `app.post("/x", validate("json", v.object({ name: v.pipe(v.string(), v.minLength(2)) })), (c) => c.text(c.req.valid("json").name))` (a test route may use `c.text`). Posting `{ "name": "a" }` returns 400 with code `common.request.validation_failed` and `details.issues[0].path === "name"`; posting `{ "name": "ab" }` returns `ab`.

```ts
import { sValidator } from "@hono/standard-validator";
import type { ValidationTargets } from "hono";
import type * as v from "valibot";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { problemResponse } from "./problem.ts";

/** Validates one part of the request with a contract schema; a failure is the usual problem. */
export const validate = <T extends keyof ValidationTargets, S extends v.GenericSchema>(target: T, schema: S) =>
  sValidator(target, schema, (result, c) => {
    if (result.success) return;
    return problemResponse(
      c as never,
      fail.validation(ErrorCode.common.validation, "Invalid request.", {
        details: {
          issues: result.error.map((issue) => ({
            path: (issue.path ?? []).map((p) => String(typeof p === "object" ? p.key : p)).join("."),
            message: issue.message,
          })),
        },
      }),
    );
  });
```

Run the test. Expected: PASS.

- [ ] **Step 6: Request context**

`request-context.ts`: one middleware doing what `$OLD/api/src/http/observability.ts` does, on Hono:

```ts
import { httpInstrumentationMiddleware } from "@hono/otel";
import { createMiddleware } from "hono/factory";
import type { Lifecycle } from "@akashic/lib/lifecycle";
import type { Logger } from "@akashic/lib/log";
import type { AppEnv } from "./env.ts";

export const REQUEST_ID_HEADER = "x-request-id";

// Probed every few seconds by the orchestrator; a trace each would bury the real traffic.
const UNTRACED_PATHS = new Set(["/livez", "/readyz"]);

/** A server span, a request id, a deadline signal, and one access-log line per response. */
export function requestContext(options: {
  budgetMs: number;
  logger: Logger;
  lifecycle: Lifecycle;
  service: string;
}) {
  const log = options.logger.child({ component: "http" });
  const traced = httpInstrumentationMiddleware({ serviceName: options.service });

  const context = createMiddleware<AppEnv>(async (c, next) => {
    const startedAt = performance.now();
    // Honours the proxy's id, so one id follows the request end to end.
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? Bun.randomUUIDv7();
    c.set("requestId", requestId);
    c.set("user", null);
    const deadline = AbortSignal.timeout(options.budgetMs);
    c.set("signal", AbortSignal.any([c.req.raw.signal, deadline, options.lifecycle.signal]));
    c.header(REQUEST_ID_HEADER, requestId);

    await next();

    // Checked after the handler rather than raced against it, so nothing keeps running once the
    // response is sent.
    if (deadline.aborted && !c.req.raw.signal.aborted && c.res.status < 400) {
      throw new DOMException("request exceeded its budget", "TimeoutError");
    }
    log.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, requestId, ms: Math.round(performance.now() - startedAt) },
      "request",
    );
  });

  return createMiddleware<AppEnv>((c, next) =>
    UNTRACED_PATHS.has(c.req.path) ? context(c, next) : traced(c, () => context(c, next)),
  );
}
```

`apps/api/test/http/request-context.test.ts`: port the cases of `$OLD/api/test/http/observability.test.ts` (request id echoed from the header or generated; a slow handler past its budget becomes 502 `common.request.timeout`). Add: a span named for the route exists for `/x` and none for `/livez` (use `recordSpans`). If the timeout thrown after `next()` doesn't reach `onError` in Hono, set `c.res = problemResponse(c, fail.external(ErrorCode.common.timeout, ...))` there instead; the test decides.

- [ ] **Step 7: Security and rate limit**

`security.ts`: port `$OLD/api/src/http/security.ts` to a Hono middleware: `cors` from `hono/cors` with `origin: allowedOrigins.length > 0 ? allowedOrigins : []`... use `origin: (origin) => (allowedOrigins.includes(origin) ? origin : null)` and `credentials: true`, `maxAge: 600`; then the same three headers, the body-size check against `content-length` (exempting `largeBodyPaths`), and the Origin check on non-safe methods, throwing the same `fail.validation` / `fail.forbidden` errors. Copy `$OLD/api/test/http/security.test.ts` and adapt its requests to `app.request(...)`.

`rate-limit.ts` (http):

```ts
import { createMiddleware } from "hono/factory";
import { getConnInfo } from "hono/bun";
import { ErrorCode, fail } from "@akashic/lib/errors";
import type { RateLimiter, RateLimitRule } from "@/integrations/rate-limit.ts";
import type { AppEnv } from "./env.ts";

/** Enforces `rule` per account once known, else per IP, and sets the RateLimit headers. */
export function rateLimit(limiter: RateLimiter, rule: RateLimitRule, options: { trustProxy: boolean }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    const caller = user ? `u:${user.id}` : `ip:${clientIp(c, options.trustProxy)}`;
    const counter = await limiter.hit(rule, caller);
    // No counter means the store couldn't answer. Fail open: failing closed turns a cache outage
    // into a total outage.
    if (counter) {
      c.header("ratelimit-limit", String(rule.limit));
      c.header("ratelimit-remaining", String(Math.max(rule.limit - counter.count, 0)));
      c.header("ratelimit-reset", String(counter.resetSeconds));
      if (counter.count > rule.limit) {
        c.header("retry-after", String(counter.resetSeconds));
        throw fail.rateLimited(ErrorCode.common.rateLimited, "Too many requests. Slow down.", {
          details: { limit: rule.limit, windowSeconds: rule.windowSeconds, retryAfter: counter.resetSeconds },
        });
      }
    }
    await next();
  });
}

function clientIp(c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0], trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return c.req.header("x-real-ip") ?? getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // `app.request()` in tests has no socket.
    return "unknown";
  }
}
```

Test `rate-limit.test.ts` with `createMemoryCounters()`: the third request under `{ limit: 2, windowSeconds: 60, bucket: "t" }` is 429 with `retry-after`; a signed-in user (set `user` in a preceding test middleware) has a separate count from the IP.

- [ ] **Step 8: Auth and sessions**

```bash
cp $OLD/api/src/auth/auth.ts apps/api/src/auth/auth.ts
```

`apps/api/src/auth/bans.ts`: `Ban` and `banMessage` from `$OLD/api/src/ports/accounts.ts`, `banFrom` from `$OLD/api/src/adapters/postgres/account.repository.ts`, and:

```ts
/** The suspension in force at `now`, if any. Expiry is judged on read, so no job lifts bans. */
export async function banOf(
  db: Executor,
  userId: string,
  { now = Temporal.Now.instant(), signal }: { now?: Temporal.Instant; signal?: AbortSignal } = {},
): Promise<Ban | undefined> {
  signal?.throwIfAborted();
  const [row] = await db
    .select({ bannedAt: user.bannedAt, reason: user.banReason, until: user.bannedUntil })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return banFrom(row, now);
}
```

In `auth.ts`: replace the `accounts: Accounts` option with `db: Db` usage (`banOf(options.db, session.userId)`), import `Db` from `@akashic/db` and `Mailer` from `@/integrations/mail.ts`. Keep `cookiePrefix`, hooks and everything else.

`session.ts`: port `$OLD/api/src/http/session.ts` to three Hono middlewares returned by `sessions({ auth, db, authorizer })`. `session` sets `user` or throws `unauthenticated`; `maybeSession` sets `user` or `null`; `platformAdmin` requires `Relation.platform.administer` on `PLATFORM_ID` and otherwise throws `fail.notFound(ErrorCode.common.routeNotFound, "No route for that path.")`. Each uses `c.get("signal")` for the ban check and the authz call.

`auth-routes.ts`: port `$OLD/api/src/http/auth-routes.ts`. On Hono:

```ts
export function authRoutes(options: { auth: Auth; limiter: RateLimiter; ordinary: RateLimitRule; credentials: RateLimitRule; trustProxy: boolean }) {
  const app = new Hono<AppEnv>();
  app.use("/api/auth/*", rateLimit(options.limiter, options.ordinary, options));
  for (const path of CREDENTIAL_PATHS) app.use(`/api/auth${path}*`, rateLimit(options.limiter, options.credentials, options));
  app.on(["GET", "POST"], "/api/auth/*", (c) => options.auth.handler(c.req.raw));
  return app;
}
```

`apps/api/test/http/session.test.ts`: with a fake `auth` (`{ api: { getSession: async () => null | { user } } }`) and a fake `authorizer`, check `session` → 401 `auth.session.unauthenticated` when signed out; `maybeSession` → `user` null; `platformAdmin` → 404 when the check is false. The ban path is covered by the integration test in Task 12.

- [ ] **Step 9: Meta and health**

`meta.ts`: port `$OLD/api/src/http/meta.ts` to two Hono sub-apps. Health keeps the paths `/livez` and `/readyz`, the same bodies and the 503s. `/` and `/mail-status` respond through `reply` with views:

```ts
const MailStatusView = v.object({
  configured: v.boolean(),
  healthy: v.boolean(),
  lastFailure: v.nullable(v.string()),
  failedAt: v.nullable(v.string()),
});
```

Put `MailStatusView` in `packages/contracts/src/meta.ts` and export it, since the web app reads `/mail-status` (its `src/lib/api/mail.ts` schema has exactly these four fields). The `/` description is a plain view in `meta.ts` (not shared).

- [ ] **Step 10: Run and commit**

Run: `bun test apps/api && bun run check`
Expected: all pass.

```bash
git add -A && git commit -m "feat(api): HTTP layer on Hono: problems, replies, validation, request context, security, rate limits, sessions, health

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Container, app and process lifecycle

**Files:**
- Create: `apps/api/src/{container,app,runtime,main}.ts`
- Test: `apps/api/test/{container,runtime,app}.test.ts`, `apps/api/test/app.integration.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `buildContainer(env)`: the root InferDI container (type `AppContainer`)
  - `RequestScope { id: string; signal: AbortSignal; user: Caller | null }`, declared as the scope input `request`
  - `ModuleRoutes { public?: Hono<AppEnv>; private?: Hono<AppEnv>; root?: Hono<AppEnv> }`
  - `createApp(deps)`: the Hono app
  - `start(container)`: resolves the graph in startup order, returns `{ app, lifecycle, logger, env }`
  - `stop({ reason, server, container, lifecycle, drainMs })`

- [ ] **Step 1: Failing container test**

`apps/api/test/container.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildContainer } from "@/container.ts";
import { testEnv } from "./env.ts";

describe("container", () => {
  test("disposes what it built in reverse order of creation", async () => {
    const released: string[] = [];
    const tracked = (name: string) => ({ async [Symbol.asyncDispose]() { released.push(name); } });
    const c = buildContainer(testEnv())
      .override("telemetry", tracked("telemetry") as never)
      .override("database", Object.assign(tracked("database"), { db: {} as never, sql: {} as never, ping: async () => true }) as never);
    await c.getAsync("telemetry");
    await c.getAsync("database");
    await c.dispose();
    // Overrides are owned by the test, so nothing of theirs is released by the container.
    expect(released).toEqual([]);
  });

  test("a request scope exposes its input", async () => {
    const c = buildContainer(testEnv());
    const scope = c.createScope({ request: { id: "r1", signal: new AbortController().signal, user: null } });
    expect(scope.get("request").id).toBe("r1");
    await scope.dispose();
    await c.dispose();
  });
});
```

`apps/api/test/env.ts`:

```ts
import { loadEnv } from "@akashic/lib/config";
import { Env } from "@/config.ts";

/** A valid environment for tests, pointing at the compose services. */
export const testEnv = (overrides: Record<string, string> = {}) =>
  loadEnv(Env, {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic",
    RABBITMQ_URL: Bun.env.RABBITMQ_URL ?? "amqp://akashic:akashic@localhost:5672",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret!",
    BETTER_AUTH_URL: "http://localhost:3000",
    FGA_STORE_ID: Bun.env.FGA_STORE_ID ?? "01H0000000000000000000000",
    ...overrides,
  });
```

The first test pins that overrides are externally owned (InferDI's contract) and that the keys exist. Ordering of real disposal is pinned in Step 4's runtime test with real factories.

Run: `bun test apps/api/test/container.test.ts`. Expected: FAIL, `@/container.ts` missing.

- [ ] **Step 2: `container.ts`**

```ts
import { Container } from "@inferdi/inferdi";
import { createAuthorizer } from "@akashic/authz";
import { createBroker, createBrokerPublisher, createEventConsumer, createOutbox, createOutboxStore, EVENTS_EXCHANGE, observeOutbox } from "@akashic/broker";
import { createDb } from "@akashic/db";
import { createLifecycle, owned } from "@akashic/lib/lifecycle";
import { createLogger } from "@akashic/lib/log";
import { createTelemetry } from "@akashic/lib/telemetry";
import { systemClock } from "@akashic/lib/time";
import { createAuth } from "@/auth/auth.ts";
import type { Env } from "@/config.ts";
import type { Caller } from "@/http/env.ts";
import { parseOrigins } from "@/http/security.ts";
import { createEmbedder } from "@/integrations/embedder.ts";
import { createResendMailer } from "@/integrations/mail.ts";
import { createMemoryCounters, createRedisCounters } from "@/integrations/counters.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";
import { createRedis } from "@/integrations/redis.ts";
import { createLocalRelay, createRedisRelay } from "@/integrations/relay.ts";
import { createS3ImageStore } from "@/integrations/storage.ts";

/** What a request scope is given. Services that need the caller resolve it from here. */
export interface RequestScope {
  id: string;
  signal: AbortSignal;
  user: Caller | null;
}

/**
 * The composition root: the only place that constructs things, and the only file that imports
 * InferDI. Nothing here runs until resolved; `start` in runtime.ts resolves in startup order, and
 * disposal releases in reverse.
 */
export function buildContainer(env: Env) {
  return new Container()
    .declareScopeInputs<{ request: RequestScope }>()
    .registerValue("env", env)
    .registerValue("clock", systemClock)
    .registerFactory("telemetry", () =>
      createTelemetry({
        serviceName: env.OTEL_SERVICE_NAME,
        environment: env.NODE_ENV,
        endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
        metricIntervalMs: env.OTEL_METRIC_INTERVAL_MS,
      }),
    )
    .registerFactory("logger", () =>
      createLogger({ level: env.LOG_LEVEL, service: env.OTEL_SERVICE_NAME, environment: env.NODE_ENV }),
    )
    .registerFactory("lifecycle", (c) => createLifecycle(c.get("logger")))
    .registerAsyncFactory(
      "database",
      async (logger) => {
        const database = createDb({
          url: env.DATABASE_URL,
          poolMax: env.DB_POOL_MAX,
          idleTimeoutS: env.DB_IDLE_TIMEOUT_S,
          connectTimeoutS: env.DB_CONNECT_TIMEOUT_S,
          limits: {
            statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
            lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
            idleInTransactionTimeoutMs: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
          },
          logger,
        });
        if (!(await database.ping())) {
          await database[Symbol.asyncDispose]();
          throw new Error("database unreachable at startup");
        }
        return database;
      },
      ["logger"] as const,
    )
    .registerAsyncFactory(
      "redis",
      async (logger) => {
        const redis = createRedis({ url: env.REDIS_URL, logger });
        await redis.connect();
        return owned(redis, () => redis.close());
      },
      ["logger"] as const,
    )
    .registerAsyncFactory(
      "broker",
      async (logger) => {
        const broker = createBroker({ url: env.RABBITMQ_URL, name: "akashic-api", logger });
        await broker.connect();
        return owned(broker, () => broker.close());
      },
      ["logger"] as const,
    )
    .registerFactory("authorizer", (c) =>
      createAuthorizer({
        apiUrl: env.FGA_API_URL,
        storeId: env.FGA_STORE_ID,
        modelId: env.FGA_MODEL_ID,
        timeoutMs: env.FGA_TIMEOUT_MS,
        logger: c.get("logger"),
      }),
    )
    .registerFactory("embedder", (c) =>
      createEmbedder({
        provider: env.AI_PROVIDER,
        apiKey: env.AI_API_KEY,
        baseUrl: env.AI_BASE_URL,
        model: env.AI_EMBED_MODEL,
        timeoutMs: env.AI_TIMEOUT_MS,
        attempts: env.AI_ATTEMPTS,
        logger: c.get("logger"),
      }),
    )
    .registerFactory("storage", (c) =>
      createS3ImageStore({
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        publicUrl: env.S3_PUBLIC_URL,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        logger: c.get("logger"),
      }),
    )
    .registerFactory("mailer", (c) =>
      createResendMailer({
        apiKey: env.RESEND_API_KEY,
        from: env.MAIL_FROM,
        timeoutMs: env.MAIL_TIMEOUT_MS,
        logLinks: env.NODE_ENV !== "production",
        logger: c.get("logger"),
        signal: c.get("lifecycle").signal,
      }),
    )
    .registerAsyncFactory(
      "auth",
      async (database, mailer, logger) =>
        createAuth({
          appName: "Akashic Records",
          cookiePrefix: "akashic",
          db: database.db,
          secret: env.BETTER_AUTH_SECRET,
          baseUrl: env.BETTER_AUTH_URL,
          trustedOrigins: parseOrigins(env.CORS_ORIGINS),
          mailer,
          sessionExpiryDays: env.SESSION_EXPIRY_DAYS,
          sessionCacheS: env.SESSION_CACHE_S,
          secureCookies: env.NODE_ENV === "production",
          logger,
        }),
      ["database", "mailer", "logger"] as const,
    )
    // With Redis every replica shares counts and room traffic; without it this instance is
    // assumed to be the only one.
    .registerAsyncFactory(
      "rateLimiter",
      async (redis, lifecycle, logger) =>
        createRateLimiter({
          counters: redis.client
            ? createRedisCounters({ redis: redis.client, logger })
            : createMemoryCounters({ signal: lifecycle.signal }),
          trustProxy: env.TRUST_PROXY,
          logger,
        }),
      ["redis", "lifecycle", "logger"] as const,
    )
    .registerAsyncFactory(
      "relay",
      async (redis, lifecycle, logger) =>
        redis.client
          ? createRedisRelay({ redis: redis.client, channel: "akashic:room-relay", lifecycle, logger })
          : createLocalRelay({ logger }),
      ["redis", "lifecycle", "logger"] as const,
    )
    .registerAsyncFactory(
      "outbox",
      async (database, broker, lifecycle, logger, clock) => {
        const publisher = createBrokerPublisher({ broker, exchange: EVENTS_EXCHANGE, confirmTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS });
        const store = createOutboxStore(database.db);
        observeOutbox(database.db);
        const outbox = createOutbox({
          store,
          transport: (event) =>
            publisher.publish({ id: event.id, type: event.eventType, routingKey: event.routingKey, payload: event.payload, headers: event.headers }),
          clock,
          lifecycle,
          logger,
          batchSize: env.OUTBOX_BATCH_SIZE,
          pollMs: env.OUTBOX_POLL_MS,
          concurrency: env.OUTBOX_CONCURRENCY,
          sendTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS,
        });
        if (env.OUTBOX_DISPATCHER_ENABLED) outbox.start();
        return owned(outbox, async () => {
          await outbox[Symbol.asyncDispose]();
          await publisher.close();
        });
      },
      ["database", "broker", "lifecycle", "logger", "clock"] as const,
    )
    .registerFactory("request", (c) => c.get("request"), "scoped");
}

export type AppContainer = ReturnType<typeof buildContainer>;
```

Adjust every factory's option names to the actual copied files' option interfaces (they were copied verbatim, so these match the old `composition.ts`). Where InferDI's types reject a form (for instance the scoped `request` re-registration, since a declared scope input is already resolvable), drop it and resolve the input key directly. `createEventConsumer` is wired in Plan 2, when the realm module brings the first handlers; the import is removed if unused.

Run: `bun test apps/api/test/container.test.ts`. Expected: PASS.

- [ ] **Step 3: `app.ts`**

```ts
import { inferdiHono } from "@inferdi/hono";
import { Hono } from "hono";
import type { Lifecycle } from "@akashic/lib/lifecycle";
import type { Logger } from "@akashic/lib/log";
import type { Authorizer } from "@akashic/authz";
import type { Db } from "@akashic/db";
import type { Auth } from "@/auth/auth.ts";
import type { AppContainer } from "@/container.ts";
import { authRoutes } from "@/http/auth-routes.ts";
import type { AppEnv } from "@/http/env.ts";
import { healthRoutes, metaRoutes } from "@/http/meta.ts";
import { notFound, problemHandler } from "@/http/problem.ts";
import { rateLimit } from "@/http/rate-limit.ts";
import { requestContext } from "@/http/request-context.ts";
import { security } from "@/http/security.ts";
import { sessions } from "@/http/session.ts";
import type { Mailer } from "@/integrations/mail.ts";
import type { RateLimiter, RateLimitRule } from "@/integrations/rate-limit.ts";

/** Where a module's routes are mounted. */
export interface ModuleRoutes {
  /** Under the public API: anonymous reads, no session lookup. */
  readonly public?: Hono<AppEnv>;
  /** Under the signed-in API. */
  readonly private?: Hono<AppEnv>;
  /** At the app root, for routes that own their path, such as a socket. */
  readonly root?: Hono<AppEnv>;
}

export interface AppDeps {
  container: AppContainer;
  logger: Logger;
  lifecycle: Lifecycle;
  auth: Auth;
  db: Db;
  authorizer: Authorizer;
  mailer: Mailer;
  limiter: RateLimiter;
  limits: { api: RateLimitRule; auth: RateLimitRule; credentials: RateLimitRule };
  allowedOrigins: string[];
  maxBodyBytes: number;
  budgetMs: number;
  trustProxy: boolean;
  checks: { required: Record<string, () => Promise<boolean>>; optional: Record<string, () => Promise<boolean>> };
  /** Mounted in this order. */
  modules: readonly ModuleRoutes[];
}

/** The HTTP surface: cross-cutting middleware around the routes each module brings. */
export function createApp(deps: AppDeps) {
  const { session } = sessions({ auth: deps.auth, db: deps.db, authorizer: deps.authorizer });
  // One request scope per request, after the caller is known, so services resolved from it see them.
  const scoped = inferdiHono({
    container: deps.container,
    createScope: (root, c) =>
      root.createScope({ request: { id: c.get("requestId"), signal: c.get("signal"), user: c.get("user") } }),
  });

  const publicApi = new Hono<AppEnv>()
    .use(rateLimit(deps.limiter, { ...deps.limits.api, bucket: "public" }, deps))
    .use(scoped);
  const api = new Hono<AppEnv>().use(session).use(rateLimit(deps.limiter, deps.limits.api, deps)).use(scoped);
  for (const group of deps.modules) {
    if (group.public) publicApi.route("/", group.public);
    if (group.private) api.route("/", group.private);
  }

  const app = new Hono<AppEnv>()
    .use(requestContext({ budgetMs: deps.budgetMs, logger: deps.logger, lifecycle: deps.lifecycle, service: "akashic" }))
    .use(security({ allowedOrigins: deps.allowedOrigins, maxBodyBytes: deps.maxBodyBytes, largeBodyPaths: ["/api/v1/uploads/"] }))
    .route("/", healthRoutes({ lifecycle: deps.lifecycle, ...deps.checks }))
    .route("/", metaRoutes({ service: "akashic", mailer: deps.mailer }))
    .route("/", authRoutes({ auth: deps.auth, limiter: deps.limiter, ordinary: deps.limits.auth, credentials: deps.limits.credentials, trustProxy: deps.trustProxy }))
    .route("/api/public/v1", publicApi)
    .route("/api/v1", api);
  // Routes that own their path, such as the room socket, sit outside both API prefixes.
  for (const group of deps.modules) if (group.root) app.route("/", group.root);

  app.onError(problemHandler(deps.logger));
  app.notFound(notFound);
  return app;
}
```

`apps/api/test/app.test.ts`: build `createApp` with fakes (memory counters, a fake auth returning no session, a lifecycle marked ready, `checks.required = { database: async () => true }`, one module with `private: new Hono<AppEnv>().get("/whoami", (c) => c.text(c.var.di.get("request").id))`). Assert: `GET /livez` 200; `GET /readyz` 200 with `database: true`; `GET /api/v1/whoami` without a session is 401 `auth.session.unauthenticated`; `GET /nope` 404 `common.route.not_found`; responses carry `x-request-id`.

- [ ] **Step 4: `runtime.ts`, with a test of the order**

```ts
import type { AppContainer } from "@/container.ts";
import { createApp, type ModuleRoutes } from "@/app.ts";
import { parseOrigins } from "@/http/security.ts";

/**
 * Builds the graph in startup order: config, telemetry, logger, database, redis, broker, the rest,
 * then the outbox. Disposal releases in reverse, so telemetry flushes last. If any step fails,
 * everything already built is released before the error propagates.
 */
export async function start(container: AppContainer, modules: readonly ModuleRoutes[] = []) {
  try {
    const env = container.get("env");
    await container.getAsync("telemetry");
    const logger = container.get("logger");
    const lifecycle = container.get("lifecycle");
    const database = await container.getAsync("database");
    const redis = await container.getAsync("redis");
    const broker = await container.getAsync("broker");
    const authorizer = container.get("authorizer");
    const mailer = container.get("mailer");
    const auth = await container.getAsync("auth");
    const limiter = await container.getAsync("rateLimiter");
    await container.getAsync("relay");
    await container.getAsync("outbox");

    const app = createApp({
      container, logger, lifecycle, auth, db: database.db, authorizer, mailer, limiter,
      limits: {
        api: { bucket: "api", limit: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_S },
        auth: { bucket: "auth-read", limit: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_S },
        credentials: { bucket: "auth", limit: env.AUTH_RATE_LIMIT_MAX, windowSeconds: env.AUTH_RATE_LIMIT_WINDOW_S },
      },
      allowedOrigins: parseOrigins(env.CORS_ORIGINS),
      maxBodyBytes: env.MAX_BODY_BYTES,
      budgetMs: env.REQUEST_TIMEOUT_MS,
      trustProxy: env.TRUST_PROXY,
      // The broker is optional for readiness: requests still work, and the outbox holds events.
      checks: { required: { database: database.ping }, optional: { redis: redis.ping, rabbitmq: broker.ping } },
      modules,
    });
    return { app, env, logger, lifecycle };
  } catch (error) {
    await container.dispose();
    throw error;
  }
}

/** Drain, abort, release, in that order. Called once, by the signal handler. */
export async function stop(options: {
  reason: string;
  server: { stop(closeActive?: boolean): Promise<void> };
  container: AppContainer;
  lifecycle: { beginDraining(r: string): void; abort(r: string): void; markStopped(): void };
  drainMs: number;
}) {
  const { reason, server, container, lifecycle } = options;
  lifecycle.beginDraining(reason);
  const drained = await Promise.race([
    server.stop().then(() => true),
    Bun.sleep(options.drainMs).then(() => false),
  ]);
  if (!drained) await server.stop(true);
  lifecycle.abort(reason);
  await container.dispose();
  lifecycle.markStopped();
}
```

`apps/api/test/runtime.test.ts`:

```ts
import { expect, test } from "bun:test";
import { stop } from "@/runtime.ts";

test("shutdown drains, then aborts, then releases, then stops", async () => {
  const steps: string[] = [];
  await stop({
    reason: "SIGTERM",
    drainMs: 1000,
    server: { stop: async (force) => void steps.push(force ? "force-close" : "stop-accepting") },
    container: { dispose: async () => void steps.push("dispose") } as never,
    lifecycle: {
      beginDraining: () => steps.push("draining"),
      abort: () => steps.push("abort"),
      markStopped: () => steps.push("stopped"),
    },
  });
  expect(steps).toEqual(["draining", "stop-accepting", "abort", "dispose", "stopped"]);
});

test("in-flight work past the drain window is cut off before release", async () => {
  const steps: string[] = [];
  await stop({
    reason: "SIGTERM",
    drainMs: 10,
    server: { stop: (force) => (force ? (steps.push("force-close"), Promise.resolve()) : new Promise(() => {})) },
    container: { dispose: async () => void steps.push("dispose") } as never,
    lifecycle: { beginDraining: () => {}, abort: () => steps.push("abort"), markStopped: () => {} },
  });
  expect(steps).toEqual(["force-close", "abort", "dispose"]);
});
```

`apps/api/test/app.integration.test.ts` (skips unless Postgres, RabbitMQ and OpenFGA answer, the way the old integration tests probe): `start(buildContainer(testEnv()))`, then `app.request("/readyz")` is 200 with `database: true` and `rabbitmq: true`; sign up through `/api/auth/sign-up/email`, mark the user banned with SQL, and assert a session-bearing request to a private test route is 403 `auth.account.suspended`; finally `stop(...)` with a fake server and assert `lifecycle.isAlive()` is false.

- [ ] **Step 5: `main.ts`**

```ts
import { assertNestedBudget, loadEnv } from "@akashic/lib/config";
import { handleSignals } from "@akashic/lib/lifecycle";
import { Env } from "@/config.ts";
import { buildContainer } from "@/container.ts";
import { start, stop } from "@/runtime.ts";

const env = loadEnv(Env, Bun.env);
assertNestedBudget("AI_TIMEOUT_MS", env.AI_TIMEOUT_MS, env.REQUEST_TIMEOUT_MS);
assertNestedBudget("DRAIN_TIMEOUT_MS", env.DRAIN_TIMEOUT_MS, env.SHUTDOWN_TIMEOUT_MS);

const container = buildContainer(env);
const { app, logger, lifecycle } = await start(container).catch((error: unknown) => {
  console.error("startup failed:", error);
  process.exit(1);
});

const server = Bun.serve({ port: env.PORT, fetch: app.fetch });
handleSignals({
  logger,
  hardExitMs: env.SHUTDOWN_TIMEOUT_MS,
  shutdown: (reason) => stop({ reason, server, container, lifecycle, drainMs: env.DRAIN_TIMEOUT_MS }),
});
lifecycle.markReady();
logger.info({ port: env.PORT }, "listening");
```

- [ ] **Step 6: Manual check**

```bash
docker compose up -d postgres redis rabbitmq openfga
cp .env.example .env   # then fill FGA_STORE_ID etc. from the old repo's .env
(cd apps/api && timeout 20 bun run dev &) ; sleep 5
curl -s localhost:3000/readyz; echo; curl -s localhost:3000/; echo
pkill -TERM -f "src/main.ts"; sleep 3
```

Expected: readiness JSON with `"status":"ready"`; the meta description; the log shows `draining`, `connection pool closed`, `stopped` in that order, and the process exits 0.

- [ ] **Step 7: Gate and commit**

Run: `bun run check`
Expected: all pass.

```bash
git add -A && git commit -m "feat(api): InferDI container, Hono app, and ordered startup and shutdown

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Scripts

**Files:**
- Create: `apps/api/scripts/{migrate,authz-push,authz-backfill,events-replay}.ts`
- Modify: root `package.json` scripts

**Interfaces:**
- Consumes: `@akashic/db` (`migrationsFolder`, tables), `@akashic/authz` (`modelPath`, `createAuthorizer`, vocabulary), `@akashic/broker` (`createBroker`, `createOutboxStore`, `replayDead`, `deadCount`, `Queues`), `@akashic/lib/config`
- Produces: `bun run db:migrate`, `authz:push`, `authz:backfill`, `events:replay` at the root

Each script loads only the variables it needs with its own small `v.object`, builds only what it uses, and runs its body inside `if (import.meta.main)`, releasing what it built in `finally`.

- [ ] **Step 1: `migrate.ts`**

```ts
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as v from "valibot";
import { migrationsFolder } from "@akashic/db";
import { loadEnv, url } from "@akashic/lib/config";

// Needs only the database URL, so it can run as a release step without the app's secrets.
if (import.meta.main) {
  const env = loadEnv(v.object({ DATABASE_URL: url() }), Bun.env);
  const client = new SQL({ url: env.DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    console.log("migrations applied");
  } finally {
    await client.close();
  }
}
```

- [ ] **Step 2: `authz-push.ts`, `authz-backfill.ts`, `events-replay.ts`**

Port `$OLD/api/src/jobs/authz-push.ts`, `authz-backfill.ts` and `replay-dead.ts` with these changes: env through `loadEnv` with a local `v.object` of only the keys used (`FGA_API_URL`; `DATABASE_URL`, `FGA_*`; `DATABASE_URL`, `RABBITMQ_URL`); the model file from `modelPath`; resources built directly (`createDb`, `createAuthorizer`, `createBroker`) and released in `finally` (`await database[Symbol.asyncDispose]()`, `await broker.close()`); `AUTHZ_SYNC_QUEUE` becomes `Queues.authzSync`; the body inside `if (import.meta.main)`. Keep the dry-run and `--apply` behaviour of the replay, and every printed line.

- [ ] **Step 3: Root scripts**

Add to the root `package.json`:

```json
"dev": "bun --filter @akashic/api dev",
"db:generate": "bun --filter @akashic/db generate",
"db:migrate": "bun --env-file=.env apps/api/scripts/migrate.ts",
"authz:push": "bun --env-file=.env apps/api/scripts/authz-push.ts",
"authz:backfill": "bun --env-file=.env apps/api/scripts/authz-backfill.ts",
"events:replay": "bun --env-file=.env apps/api/scripts/events-replay.ts"
```

- [ ] **Step 4: Verify against the running services**

```bash
bun run db:migrate && bun run authz:push && bun run authz:backfill && bun run events:replay
```

Expected: `migrations applied`; the store and model ids; `synced N realms and M memberships` matching the restored data; `outbox: 0 dead event(s)` (or a count) and `dry run: nothing changed.`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): migrate, authz push and backfill, and events replay as scripts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: Structure test, CI, and project notes

**Files:**
- Create: `apps/api/test/structure.test.ts`, `.github/workflows/ci.yml`, `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: the layout above
- Produces: the structure rules enforced in CI

- [ ] **Step 1: Structure test, failing first**

`apps/api/test/structure.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

const root = `${import.meta.dir}/../src`;
const files = [...new Glob("**/*.ts").scanSync(root)].map((f) => f.replaceAll("\\", "/"));
const read = (f: string) => Bun.file(`${root}/${f}`).text();

describe("structure", () => {
  test("only container.ts imports InferDI's container", async () => {
    const importing = [];
    for (const f of files) if ((await read(f)).includes('"@inferdi/inferdi"')) importing.push(f);
    expect(importing).toEqual(["container.ts"]);
  });

  test("modules never import each other", async () => {
    const crossing: string[] = [];
    for (const f of files.filter((f) => f.startsWith("modules/"))) {
      const own = f.split("/")[1];
      for (const [, target] of (await read(f)).matchAll(/from\s+["']@\/modules\/([^/"']+)/g)) {
        if (target !== own) crossing.push(`${f} -> ${target}`);
      }
    }
    expect(crossing).toEqual([]);
  });

  test("routes reply through a view, never c.json", async () => {
    const raw: string[] = [];
    for (const f of files.filter((f) => f.endsWith(".routes.ts"))) {
      if ((await read(f)).includes("c.json(")) raw.push(f);
    }
    expect(raw).toEqual([]);
  });

  test("nothing but main.ts and scripts starts the process", async () => {
    const starting: string[] = [];
    for (const f of files.filter((f) => f !== "main.ts")) {
      if (/Bun\.serve\(|handleSignals\(/.test(await read(f))) starting.push(f);
    }
    expect(starting).toEqual([]);
  });
});
```

Write it with the editor tool (regexes). To see the first rule bite, temporarily add `import "@inferdi/inferdi";` to `app.ts`, run, see it fail, remove it.

- [ ] **Step 2: CI**

`.github/workflows/ci.yml`: port `$OLD/.github/workflows/ci.yml`. Keep its Postgres, Redis and RabbitMQ services and the `docker run` for OpenFGA (a GitHub Actions service can't be given a command). Steps: `bun install --frozen-lockfile`; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun apps/api/scripts/migrate.ts`; `bun test`; then `(cd packages/db && bunx drizzle-kit generate) && git diff --exit-code packages/db/migrations`.

- [ ] **Step 3: `CLAUDE.md` and `README.md`**

`CLAUDE.md`: adapt `$OLD/CLAUDE.md` to the new layout: the stack line (Hono, Valibot, Drizzle 1.0 rc, InferDI); commands from the root `package.json`; the rules (nothing runs on import; only `container.ts` imports InferDI; one error funnel with `reply`/`respond`; events and audits only through `publish(tx, ...)`/`audit(tx, ...)` inside `inTransaction`; outbox handlers idempotent; realm-scoped actions check the realm; comments say why). Keep "Traps already hit" items 1-6, and add: "7. `v.object` strips undeclared keys on parse; that's what `reply` relies on. Don't switch views to `looseObject`." Point to the spec for the design.

`README.md`: what the project is, how to start it (`docker compose up -d`, `cp .env.example .env`, `bun install`, `bun run db:migrate`, `bun run authz:push`, `bun run dev`), and the layout tree from the spec.

- [ ] **Step 4: Gate and commit**

Run: `bun run check`
Expected: all pass.

```bash
git add -A && git commit -m "chore: structure rules, CI, and project notes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## After this plan

- Push: once the user has created the empty `wiormiw/akashic-records` repository, `git remote add origin git@github.com:wiormiw/akashic-records.git && git push -u origin main`.
- Plan 2 (modules) and Plan 3 (web, deployment, docs) are written next, against the names above.
