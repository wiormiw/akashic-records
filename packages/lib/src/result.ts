import type { Logger } from './log.ts';

/**
 * What a service returns when it can fail in a way the caller should handle: a value, or one of
 * the errors its type names. `throw` is left for bugs and infrastructure failing.
 */
export type Result<T, E> = Ok<T> | Err<E>;
export type Ok<T> = { readonly ok: true; readonly value: T };
// One `{ ok: false }` branch per error, so narrowing on one error leaves the rest.
export type Err<E> = E extends unknown ? { readonly ok: false; readonly error: E } : never;

type ResultFn<A extends readonly unknown[], T, E> = (...args: A) => Promise<Result<T, E>>;
type Step<In, Out, E> = ResultFn<[In], Out, E>;
type AnyResultFn = (...args: never[]) => Promise<Result<unknown, unknown>>;
type Ctor<T> = abstract new (...args: never[]) => T;

/**
 * The errors and the value, read off a result rather than inferred through `Err<E>`: inference
 * picks one candidate from a union of `{ ok: false }` branches, not all of them.
 */
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

function isResult(value: unknown): value is Result<unknown, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	if (!('ok' in value) || typeof value.ok !== 'boolean') return false;
	return value.ok ? 'value' in value : 'error' in value;
}

export const isOk = <R extends Result<unknown, unknown>>(r: R): r is Extract<R, { ok: true }> =>
	r.ok;
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

/** Chains result-returning steps, each taking the value before it; the first error stops it. */
export function pipe<A extends unknown[], T, E>(first: ResultFn<A, T, E>): ResultFn<A, T, E>;
export function pipe<A extends unknown[], T, E, T1, E1>(
	first: ResultFn<A, T, E>,
	step1: Step<T, T1, E1>,
): ResultFn<A, T1, E | E1>;
export function pipe<A extends unknown[], T, E, T1, E1, T2, E2>(
	first: ResultFn<A, T, E>,
	step1: Step<T, T1, E1>,
	step2: Step<T1, T2, E2>,
): ResultFn<A, T2, E | E1 | E2>;
export function pipe<A extends unknown[], T, E, T1, E1, T2, E2, T3, E3>(
	first: ResultFn<A, T, E>,
	step1: Step<T, T1, E1>,
	step2: Step<T1, T2, E2>,
	step3: Step<T2, T3, E3>,
): ResultFn<A, T3, E | E1 | E2 | E3>;
export function pipe<A extends unknown[], T, E, T1, E1, T2, E2, T3, E3, T4, E4>(
	first: ResultFn<A, T, E>,
	step1: Step<T, T1, E1>,
	step2: Step<T1, T2, E2>,
	step3: Step<T2, T3, E3>,
	step4: Step<T3, T4, E4>,
): ResultFn<A, T4, E | E1 | E2 | E3 | E4>;
export function pipe<A extends unknown[], T, E, T1, E1, T2, E2, T3, E3, T4, E4, T5, E5>(
	first: ResultFn<A, T, E>,
	step1: Step<T, T1, E1>,
	step2: Step<T1, T2, E2>,
	step3: Step<T2, T3, E3>,
	step4: Step<T3, T4, E4>,
	step5: Step<T4, T5, E5>,
): ResultFn<A, T5, E | E1 | E2 | E3 | E4 | E5>;
export function pipe(
	first: AnyResultFn,
	...rest: Array<(value: never) => Promise<Result<unknown, unknown>>>
): AnyResultFn {
	return async (...args) => {
		let current = await first(...args);
		for (const step of rest) {
			if (!current.ok) return current;
			current = await step(current.value as never);
		}
		return current;
	};
}

// Each function's own result, read off its return type so its errors stay as it declared them.
type Results<Fns extends readonly AnyResultFn[]> = {
	-readonly [K in keyof Fns]: Awaited<ReturnType<Fns[K]>>;
};

// The parameters of the first function every function can be called with. Computed rather than
// inferred: inference can't choose between `[]` and `[id: string]`, though a function taking
// nothing accepts either. When none fits, the first function's parameters make the mismatch an
// argument error.
type SharedArgs<
	Fns extends readonly AnyResultFn[],
	Rest extends readonly AnyResultFn[] = Fns,
> = Rest extends readonly [
	infer F extends AnyResultFn,
	...infer Tail extends readonly AnyResultFn[],
]
	? Fns[number] extends (...args: Parameters<F>) => unknown
		? Parameters<F>
		: SharedArgs<Fns, Tail>
	: Parameters<Fns[0]>;

/** Runs every function at once with the same arguments, and returns each one's result. */
export function all<Fns extends readonly [AnyResultFn, ...AnyResultFn[]]>(
	...fns: Fns & readonly ((...args: SharedArgs<Fns>) => Promise<Result<unknown, unknown>>)[]
): (...args: SharedArgs<Fns>) => Promise<Results<Fns>>;
export function all(
	...fns: AnyResultFn[]
): (...args: never[]) => Promise<Result<unknown, unknown>[]> {
	return async (...args) => Promise.all(fns.map((call) => call(...args)));
}

/** The value of a result that cannot fail. */
export function value<T>(result: Result<T, never>): T {
	// `never` has no error branch in the types; the check stays for one the types collapsed.
	const settled = result as Result<T, unknown>;
	if (!settled.ok) throw settled.error;
	return settled.value;
}

/** The value of a result, or its error thrown; a promise of a result gives a promise. */
export function unwrap<R extends Result<unknown, unknown>>(result: R): ValueOf<R>;
export function unwrap<R extends Result<unknown, unknown>>(result: Promise<R>): Promise<ValueOf<R>>;
export function unwrap(
	result: Result<unknown, unknown> | Promise<Result<unknown, unknown>>,
): unknown {
	const settle = (settled: Result<unknown, unknown>): unknown => {
		if (settled.ok) return settled.value;
		throw settled.error;
	};
	return isResult(result) ? settle(result) : result.then(settle);
}

/** The value, or `fallback` when the result failed or the promise rejected. */
export async function orElse<T, E>(result: Promise<Result<T, E>>, fallback: T): Promise<T> {
	try {
		const settled = await result;
		if (settled.ok) return settled.value;
	} catch {
		// A rejected promise is the same outcome as an error result.
	}
	return fallback;
}

/**
 * Wraps a throwing call at an integration edge, so a throw becomes `err(mapError(caught))`. The
 * mapper is required: an edge always says which typed error a throw becomes.
 */
export function fn<A extends unknown[], T, E>(
	inner: (...args: A) => Promise<T>,
	mapError: (error: unknown, ...args: A) => E,
): ResultFn<A, T, E> {
	return async (...args) => {
		try {
			return ok(await inner(...args));
		} catch (caught) {
			return err(mapError(caught, ...args));
		}
	};
}

/** `fn` called at once, for a call made in one place. */
export const exec = <T, E>(
	inner: () => Promise<T>,
	mapError: (error: unknown) => E,
): Promise<Result<T, E>> => fn(inner, mapError)();

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
	})().catch(() => {
		// The logger itself failed; there is nowhere left to report it, and it must not escape.
	});
}
