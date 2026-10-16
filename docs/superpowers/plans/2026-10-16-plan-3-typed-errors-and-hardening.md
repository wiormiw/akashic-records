# Plan 3: Typed Errors and Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every service declares exactly which errors it returns, through a new Result library and one error class per stable code; and the open issues from Plan 2's follow-ups are fixed.

**Architecture:** `packages/lib/src/result.ts` is rewritten as a small typed-error Result library (inspired by the user's design: one error branch per error type, narrowing by class, `pipe`, `all`, edge wrappers). `packages/lib/src/errors.ts` gains `defineError(kind, code, defaultMessage)` and one class per code, all extending `AppError`, so `respond()` and the problem renderer keep working. Modules migrate from `fail.*` to the classes, naming each service's error union in `<module>.types.ts`. Then `fail.*` is removed and a structure test keeps it out. The hardening tasks close the follow-ups doc.

**Tech Stack:** as Plans 1-2 (Bun 1.4, TypeScript 7, Hono, Valibot 1.5.0, Drizzle 1.0.0-rc.4, InferDI, RabbitMQ, OpenFGA).

**Spec:** `docs/superpowers/specs/2026-10-13-akashic-records-monorepo-design.md`, section "Typed errors", plus everything it already says. Follow-ups this plan closes: `docs/superpowers/plans/2026-10-15-plan-2-followups.md`.

**The web app and deployment move to Plan 4.**

## Global Constraints

- The repo's `CLAUDE.md` binds: rules, layout, named types, request order, code style (tabs, single quotes) and traps.
- Bun is off PATH: `export PATH="$HOME/.bun/bin:$PATH"`.
- **The wire never changes.** Every error code string, HTTP status and problem body stays as it is today. The single exception is new: a request cut off by shutdown becomes 503 `common.request.unavailable` with `Retry-After`.
- **One class per error code**, named by meaning in PascalCase, made with `defineError`. The exception is a code that today is answered with different statuses at different sites: it gets one class per status, named by what each site means, all with the same code. That applies to `realm.not_member`:
  - 404 at 4 sites;
  - 400 at 2 sites;
  - 403 at 1 site.

  Check the actual sites and name the classes accordingly.
- **Error unions are named types** in `<module>.types.ts` (for example `type JoinError = RealmNotFound | AlreadyMember | RealmArchived`). Service signatures use them, never `AppError` or an untyped `Result<T>`.
- `throw` stays for bugs and infrastructure. `fn` and `exec` are used only at integration edges, and always with an error mapper.
- Tests: services and routes run in `withRollback`; race tests commit uniquely named rows and delete exactly those. Postgres holds real dev data.
- Commit trailer exactly `Co-Authored-By: Claude <noreply@anthropic.com>`. Write regex-bearing files with the editor tool.

## Review Focus

1. **A status code that changed silently** during the migration (a 404 becoming 403 because the wrong class was picked). Pinned by Task 2's catalogue test and each module's existing route tests, which must pass unchanged.
2. **A union that lies**: a service whose declared error type omits an error it can actually return. The compiler catches most; `isError` narrowing tests in Task 3 pin the pattern.
3. **A request cut off by shutdown** answering 500 and logging "unhandled error" during every deploy. Pinned in Task 6.
4. **Two admins and a leave racing** into a deadlock or a realm with no admin. Pinned in Task 6.
5. **An oversized upload** getting a bare 413 with no CORS headers, which a browser reports as a network error. Pinned in Task 6.

---

### Task 1: The Result library

**Files:**
- Rewrite: `packages/lib/src/result.ts`
- Test: `packages/lib/test/result.test.ts` (extend)

**Interfaces:**
- Produces, from `@akashic/lib/result`:
  - `Result<T, E = AppError>`, `Ok<T>`, `Err<E>`, `ok`, `err`, `isOk`, `isErr`, `isError`
  - `mapOk`, `mapErr`, `andThen`, `pipe`, `all`
  - `unwrap`, `value`, `orElse`
  - `fn`, `exec`, `forget`
  - `ErrorOf<R>`, `ValueOf<R>`
- Keep the existing exports' behaviour (`ok`, `err`, `mapOk`, `Result<T>` defaulting to `AppError`), so nothing breaks before migration.

- [ ] **Step 1: Write the failing tests** in `packages/lib/test/result.test.ts`, covering:
  - narrowing: given `Result<number, A | B>` from a function, `isError(r, A)` narrows to the `A` branch at runtime and in types. Use a `// @ts-expect-error` line showing `r.error` is not `B` inside the branch.
  - `pipe` stops at the first error and passes values along; its return error type is the union of the steps' errors (checked with a type assertion helper `expectType<T>(value: T)`).
  - `all` runs everything with the same arguments and returns each result.
  - `unwrap` returns the value or throws the error, for a value and for a promise.
  - `orElse` returns the fallback on an error result and on a rejected promise.
  - `fn`/`exec` turn a throw into `err(mapError(caught))`.
  - `forget` never throws and logs a failure to the given logger (use `captureLogger()` from `@akashic/lib/testing`).

- [ ] **Step 2: Run them.** Run `bun test packages/lib/test/result.test.ts`. They should fail because the exports are missing.

- [ ] **Step 3: Write `result.ts`.** Use the editor tool.

```ts
import type { AppError } from './errors.ts';
import type { Logger } from './log.ts';

/**
 * What a service returns when it can fail in a way the caller should handle: a value, or one of
 * the errors its type names. `throw` is left for bugs and infrastructure failing.
 */
export type Result<T, E = AppError> = Ok<T> | Err<E>;
export type Ok<T> = { readonly ok: true; readonly value: T };
// One `{ ok: false }` branch per error, so narrowing on one error leaves the rest.
export type Err<E> = E extends unknown ? { readonly ok: false; readonly error: E } : never;

type Ctor<T> = abstract new (...args: never[]) => T;

/** The errors and the value, read off a result rather than inferred through `Err<E>`. */
export type ErrorOf<R> = R extends { ok: false; error: infer E } ? E : never;
export type ValueOf<R> = R extends { ok: true; value: infer T } ? T : never;

/** The branches of R whose error is C; a C that subclasses one of the errors narrows to C. */
type Narrow<R, C> = R extends { ok: false; error: infer E }
	? [E] extends [C]
		? R
		: [C] extends [E]
			? R & Err<C>
			: never
	: never;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error }) as Err<E>;

export const isOk = <R extends Result<unknown, unknown>>(r: R): r is Extract<R, { ok: true }> => r.ok;
export const isErr = <R extends Result<unknown, unknown>>(r: R): r is Extract<R, { ok: false }> =>
	!r.ok;

/** Whether the result failed with C: narrows the result to that branch. */
export function isError<R extends Result<unknown, unknown>, C extends ErrorOf<R>>(
	result: R,
	ctor: Ctor<C>,
): result is Narrow<R, C> & R {
	return !result.ok && result.error instanceof ctor;
}

/** Transforms a success, passing a failure through untouched. */
export const mapOk = <T, U, E>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> =>
	result.ok ? ok(transform(result.value)) : result;

/** Transforms a failure, passing a success through untouched. */
export const mapErr = <T, E, F>(result: Result<T, E>, transform: (error: E) => F): Result<T, F> =>
	result.ok ? result : err(transform(result.error));

/** Runs `next` on a success; a failure skips it. */
export const andThen = async <T, E, U, F>(
	result: Result<T, E>,
	next: (value: T) => Promise<Result<U, F>>,
): Promise<Result<U, E | F>> => (result.ok ? next(result.value) : result);
```

Port `pipe` (the five overloads), `all` (with `SharedArgs` and `Results`), `unwrap` (both overloads), `value`, `orElse`, `fn` and `exec` from the user's design. The design is reproduced in this plan's appendix. Use camelCase names: `orElse`, not `or_else`.

`forget` takes a logger and logs a failure at warn, rather than swallowing it silently:

```ts
/** Runs `work` without waiting for it; a failure is logged, never thrown. */
export function forget<A extends unknown[]>(
	log: Pick<Logger, 'warn'>,
	work: (...args: A) => Promise<unknown>,
	...args: A
): void {
	void (async () => {
		try {
			await work(...args);
		} catch (error) {
			log.warn({ err: error }, 'background work failed');
		}
	})();
}
```

- [ ] **Step 4: Run the tests and the gate.** Run `bun test packages/lib && bun run check`. Everything passes, and existing users of `ok`, `err` and `mapOk` compile unchanged.

- [ ] **Step 5: Commit.** Message: `feat(lib): a typed-error Result library`.

---

### Task 2: Error classes, the `unavailable` kind, and typed plumbing

**Files:**
- Modify: `packages/lib/src/errors.ts`, `packages/lib/src/problem.ts`
- Modify: `apps/api/src/http/{reply,problem}.ts`, `packages/db/src/transaction.ts`, `packages/lib/test/expect-result.ts` (or its home in `@akashic/lib/testing`)
- Test: `packages/lib/test/errors.test.ts`

**Interfaces:**
- Produces `defineError(kind, code, defaultMessage)` and one exported class per code, each with a matching `type`:

```ts
export const RealmNotFound = defineError('not_found', 'realm.not_found', 'No such realm.');
export type RealmNotFound = InstanceType<typeof RealmNotFound>;
```

- Adds kind `unavailable` (503) and code `common.request.unavailable`.
- `respond`, `inTransaction` and `traced` become generic over `E extends AppError`.
- The test helper `expectErr(result, codeOrClass)` accepts either a code or a class.

- [ ] **Step 1: Failing test** `packages/lib/test/errors.test.ts`:
  - A **catalogue** test: for every class exported from `errors.ts`, the instance's `kind` maps through `httpStatusByKind` to the status the code has today. The table of today's (code → status) pairs is derived from the `fail.<kind>(ErrorCode…)` pairs in the code (listed in this plan's appendix). It's written into the test, so a later change to a class can't silently move a status.
  - Two classes with different codes are not assignable to each other (a `@ts-expect-error` assignment).
  - `instanceof AppError` holds for every class.

- [ ] **Step 2: Implement** `defineError` in `errors.ts`:

```ts
export interface ErrorOptions {
	details?: Record<string, unknown>;
	cause?: unknown;
}

/**
 * A class for one stable error code. Its kind and code are literal types, so two errors are
 * never confused in a union, and it is an AppError, so the problem renderer handles it as is.
 */
export function defineError<const K extends ErrorKind, const C extends string>(
	kind: K,
	code: C,
	defaultMessage: string,
) {
	return class extends AppError {
		static readonly kind = kind;
		static readonly code = code;
		declare readonly kind: K;
		declare readonly code: C;
		constructor(message: string = defaultMessage, options?: ErrorOptions) {
			super(kind, code, message, options);
		}
	};
}
```

Define one class per code from the appendix table, with the realm.not_member split described in Global Constraints. `ErrorCode` stays exported as it is, since other code reads the strings.

Add the kind `unavailable` and the code `common.request.unavailable`. `httpStatusByKind.unavailable = 503`, and `problem.ts` gets a title for it.

- [ ] **Step 3: Generic plumbing.**
  - `respond<S, E extends AppError>(c, result: Result<…, E>, view, status?)`.
  - `inTransaction<T, E extends AppError>(db, work: (tx) => Promise<Result<T, E>>): Promise<Result<T, E>>`.
  - `traced` keeps recognising a failed result by `instanceof AppError`.
  - The test helper `expectErr` takes a code string or a class and returns the narrowed error.
  - Everything compiles with today's `fail.*` code, which still returns `AppError`.

- [ ] **Step 4: Gate and commit.** Run `bun run check`, then commit `feat(lib): one error class per code, and the unavailable kind`.

---

### Task 3: Migrate the HTTP layer, integrations, scripts, and the realm, events, comments and mail modules

**Files:**
- `apps/api/src/http/*`, `apps/api/src/auth/*`, `apps/api/src/integrations/*`, `apps/api/scripts/*`
- `apps/api/src/modules/{realm,events,comments,mail}/*`
- Their tests

The migration recipe applies to every module (this task and Tasks 4 and 5):

1. Replace each `fail.<kind>(ErrorCode.x.y, message, options)` with `new <Class>(message, options)`. Keep messages identical: they are on the wire as `detail`. Where the message equals the class's default, it may be omitted.
2. For each exported service function that returns a Result, name its error union in `<module>.types.ts` and use it in the signature: `Promise<Result<Joined, JoinError>>`. A union may reference another service's union when one calls the other.
3. Where a route or a caller special-cases one error (by checking `error.code`), use `isError(result, Class)` instead.
4. The module's route tests must pass **without edits to their status or code assertions**. Edits to types and imports only.
5. Add one test per module that narrows a real service result with `isError` and asserts the remaining union in types (`@ts-expect-error` on the excluded branch).

- [ ] Apply the recipe to the HTTP layer:
  - `problem.ts` `classify` and `notFound`;
  - `session.ts`, `security.ts`, `rate-limit.ts`, `validate.ts`, `request-context.ts`, `realm-context.ts`.
- [ ] Apply it to auth, integrations, scripts and mail.
- [ ] Apply it to realm, events and comments.
- [ ] Run `bun run check`. Commit per area (`refactor(http): typed errors`, `refactor(realm): typed errors`, …).

---

### Task 4: Migrate postings and governance

Apply the recipe from Task 3 to `apps/api/src/modules/{postings,governance}/*` and their tests. Commit per module.

---

### Task 5: Migrate room, upload and admin, then remove `fail`

- [ ] Apply the recipe to `apps/api/src/modules/{room,upload,admin}/*`, then commit per module.
- [ ] **Remove the old API.** Delete `fail` and `make` from `errors.ts`, and make the `Result` type parameter `E` required, with no default.
- [ ] **Add structure rules** to `apps/api/test/structure.test.ts`:
  - no `fail.` in `apps/api/src` or `packages/*/src`;
  - no exported signature in `apps/api/src/modules/**` whose result is `Result<…, AppError>` or `Result<X>` with no error type.

  Show each rule failing once, then revert the probe.
- [ ] **Update `CLAUDE.md`.** The "One error funnel" rule now describes error classes and named unions.
- [ ] Run `bun run check`, then commit `refactor: fail is gone; every service names its errors`.

---

### Task 6: Hardening from the follow-ups doc

Each item is one commit with tests.

1. **Shutdown answers 503.**
   - When the lifecycle signal has aborted and a request's handler throws because of it, render 503 `common.request.unavailable` with `Retry-After: 5`.
   - Log it at info, not as "unhandled error".
   - Keep `akashic.cancelled` on the span. The span is still ERROR, because @hono/otel marks every 5xx; record that in a comment.
   - Test it through `requestContext` with an aborted lifecycle.
2. **Lock edges** (from "Lock-order edges left"):
   - `leave` locks `role = admin OR user_id = <self>` in one sorted statement, and runs the sole-admin check on the locked role.
   - `removeModerator` and recalls re-check the subject's role under `lockMembers`, and refuse if the subject is now an admin.
   - Tests:
     - a demoted admin's `leave` succeeds once they're no longer admin;
     - unseating someone promoted to admin in between is refused, and no admin is demoted.
3. **Oversized uploads get a problem response.**
   - On the upload route, add a Hono `bodyLimit` middleware at `policy.uploads.maxBytes + 64 KiB` that answers with the `PayloadTooLarge` problem (413 status, code `common.request.payload_too_large`, CORS and request-id headers intact).
   - Raise Bun's `maxRequestBodySize` backstop to twice that.
   - Test it with a streamed oversized body through the app.
4. **Topology preparation obeys shutdown.**
   - The dispatcher's `prepare` races the abort signal, so shutdown never waits on rabbitmq-client's channel acquisition.
   - Test it with a `prepare` that never resolves: dispose returns promptly.
5. **Founding hides like the admin surface.** `POST /realms` runs `platformAdmin` before `validate`, as `/admin/*` does (R15). Test: a non-admin's malformed body gets the router's 404.
6. **Moderator actions are audited.**
   - A fit-review takedown writes an audit entry: actor, the posting, action `moderated`, `changes: { by: 'fit-review' }`.
   - A moderator changing the status of someone else's job or listing writes an audit entry (`changes: { by: 'moderator', status }`). Authors changing their own write none.
   - Tests for both.
7. **Pin OpenFGA.** Pin `openfga/openfga` to the exact version currently running, in `compose.yaml` and `.github/workflows/ci.yml`. Read the version from `docker compose exec openfga ./openfga version`, or from the image's digest/labels.

---

### Task 7: Correctness polish from the follow-ups doc

One commit per item, with tests:

1. **Comments:** the thread-open check runs inside the add transaction, with the posting row locked `FOR SHARE`, so turning comments off can't race a new comment.
2. **Events:** the first RSVP's `respondedAt` comes from the injected clock, not the column default.
3. **Room:**
   - the socket tests parse each live frame with the web `StoredMessage` schema;
   - add a negative test: a socket in room B receives nothing when room A gets a message.
4. **Upload:** a test that a refused upload (wrong type) leaves the hourly rate-limit budget unspent.
5. **Governance contracts:** `SeatStanding.role` and `Takedown.subjectKind` use the `RealmRole` and `CommentSubject` enum types, not `number`. Wire values are unchanged.
6. **Scripts:** `authz-backfill.ts` and `authz-push.ts` load env with `v.pick(Env, [...])`, like the others.
7. **Structure rule:** in `*.routes.ts`, a `validate(` call may not appear after `realmContext`, `requirePermission(`, `requireModule(` or `requireOn(` in the same route chain.
   - Exception: `platformAdmin` before `validate` on `/admin` and founding routes.
   - A regex heuristic over each route's argument list is acceptable; document what it catches.
   - Show it failing once.

---

### Task 8: Close-out

- [ ] Update `docs/superpowers/plans/2026-10-15-plan-2-followups.md`. Tick everything this plan settled, and leave only the Plan 4 items (contracts in the web app, split-deploy strictness, MinIO in CI, mail PII retention) plus anything still open.
- [ ] Update `CLAUDE.md`'s traps with anything this plan hit.
- [ ] Run `bun run check`, then commit `chore: plan 3 close-out`.

---

## Appendix A: today's error code → kind pairings (from the code, 2026-10-16)

| Code | Kind (status) | Sites |
| --- | --- | --- |
| auth.account.suspended | forbidden (403) | 1 |
| auth.session.unauthenticated | unauthorized (401) | 2 |
| common.auth.forbidden | forbidden (403) | 1 |
| common.request.payload_too_large | validation (400) | 2 |
| common.request.rate_limited | rate_limited (429) | 3 |
| common.route.not_found | not_found (404) | 6 |
| common.request.timeout | external (502) | 2 |
| common.server.unexpected | internal (500) | 1 |
| common.request.validation_failed | validation (400) | 15 |
| posting.already_settled | conflict (409) | 2 |
| event.at_capacity | conflict (409) | 1 |
| event.not_found | not_found (404) | 10 |
| event.already_happened | validation (400) | 1 |
| external.authz.unavailable | external (502) | 1 |
| external.resend.delivery_failed | external (502) | 1 |
| external.storage.not_configured | external (502) | 1 |
| realm.already_member | conflict (409) | 5 |
| realm.archived | conflict (409) | 1 |
| realm.duplicate_slug | conflict (409) | 5 |
| realm.forbidden | forbidden (403) | 14 |
| realm.module_disabled | not_found (404) | 1 |
| realm.not_found | not_found (404) | 11 |
| realm.not_member | not_found (404) ×4, validation (400) ×2, forbidden (403) ×1 | 7 |
| realm.sole_admin | conflict (409) | 2 |

Codes defined but not yet used with `fail` (`auth.session.expired`, `common.request.cancelled`, `external.ai.unavailable`, `external.ai.not_configured`) also get classes, with the kind their name implies. The implementer notes the chosen kinds in the commit.

`common.request.payload_too_large` keeps kind `validation` (400) where it's answered today. Task 6 item 3 answers the new route-level oversize with 413. Define a second class with that code and kind `payload_too_large` (add the kind, status 413), used only there.

## Appendix B: the user's design, which `result.ts` ports

`pipe`, `all` (with `SharedArgs` and `Results`), `unwrap`, `value`, `orElse` (`or_else`), `fn` and `exec` come from the design the user shared on 2026-10-16. Port their behaviour and types as written there, adapted to camelCase and to `Result`'s readonly branches. Skip three things:
- its `define`: errors here come from `defineError`, which extends `AppError`;
- its `JsonError` and `parseJSON`, which this codebase doesn't need;
- its `forget`, which is replaced by the logging one above.

```ts
type ResultFn<A extends readonly unknown[], T, E> = (...args: A) => Promise<Result<T, E>>;
type Step<In, Out, E> = ResultFn<[In], Out, E>;

function pipe<A extends unknown[], T, E>(first: ResultFn<A, T, E>): ResultFn<A, T, E>;
function pipe<A extends unknown[], T, E, T1, E1>(
	first: ResultFn<A, T, E>,
	step1: Step<T, T1, E1>,
): ResultFn<A, T1, E | E1>;
// … overloads up to step5, each widening the error union …
function pipe(
	first: (...args: never[]) => Promise<Result<unknown, unknown>>,
	...rest: Array<(value: never) => Promise<Result<unknown, unknown>>>
): (...args: never[]) => Promise<Result<unknown, unknown>> {
	return async (...args) => {
		let current = await first(...args);
		for (const step of rest) {
			if (!current.ok) return current;
			current = await step(current.value as never);
		}
		return current;
	};
}

type AnyResultFn = (...args: never[]) => Promise<Result<unknown, unknown>>;
type Results<Fns extends readonly AnyResultFn[]> = {
	-readonly [K in keyof Fns]: Awaited<ReturnType<Fns[K]>>;
};
// The parameters of the first function every function can be called with.
type SharedArgs<Fns extends readonly AnyResultFn[], Rest extends readonly AnyResultFn[] = Fns> =
	Rest extends readonly [infer F extends AnyResultFn, ...infer Tail extends readonly AnyResultFn[]]
		? Fns[number] extends (...args: Parameters<F>) => unknown
			? Parameters<F>
			: SharedArgs<Fns, Tail>
		: Parameters<Fns[0]>;

function all<Fns extends readonly [AnyResultFn, ...AnyResultFn[]]>(
	...fns: Fns & readonly ((...args: SharedArgs<Fns>) => Promise<Result<unknown, unknown>>)[]
): (...args: SharedArgs<Fns>) => Promise<Results<Fns>>;

function unwrap<R extends Result<unknown, unknown>>(result: R): ValueOf<R>;
function unwrap<R extends Result<unknown, unknown>>(result: Promise<R>): Promise<ValueOf<R>>;

function value<T>(result: Result<T, never>): T; // throws at runtime if TypeScript collapsed an error
async function orElse<T, E>(result: Promise<Result<T, E>>, fallback: T): Promise<T>; // a rejection counts as an error

function fn<A extends unknown[], T, E>(
	inner: (...args: A) => Promise<T>,
	mapError: (error: unknown, ...args: A) => E,
): ResultFn<A, T, E>;
function exec<T, E>(inner: () => Promise<T>, mapError: (error: unknown) => E): Promise<Result<T, E>>;
```

`unwrap` needs a runtime `isResult` check, to tell a result from a promise.
