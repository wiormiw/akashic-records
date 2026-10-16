import { describe, expect, test } from 'bun:test';
import { ErrorCode, fail } from '@akashic/lib/errors';
import {
	all,
	andThen,
	err,
	type ErrorOf,
	exec,
	fn,
	forget,
	isErr,
	isError,
	isOk,
	mapErr,
	mapOk,
	ok,
	orElse,
	pipe,
	type Result,
	unwrap,
	value,
	type ValueOf,
} from '@akashic/lib/result';
import { captureLogger, expectErr, expectOk } from '@akashic/lib/testing';

/** Compiles only when `value` is assignable to T. */
const expectType = <T>(_value: T): void => {};
/** True only when A and B are the same type. */
type Equal<A, B> =
	(<X>() => X extends A ? 1 : 2) extends <X>() => X extends B ? 1 : 2 ? true : false;
const assertTrue = <_T extends true>(): void => {};

// Distinct fields, so the errors are not structurally interchangeable.
class Missing extends Error {
	readonly tag = 'missing';
}
class Taken extends Error {
	readonly tag = 'taken';
}
class Gone extends Error {
	readonly tag = 'gone';
}

const lookup = (n: number): Result<number, Missing | Taken> =>
	n === 0 ? err(new Missing()) : n === 1 ? err(new Taken()) : ok(n);

describe('result', () => {
	test('mapOk transforms a success', () => {
		expect(expectOk(mapOk(ok(2), (n) => n * 3))).toBe(6);
	});

	test('mapOk passes a failure through untouched', () => {
		const failure = err(fail.conflict(ErrorCode.realm.alreadyMember, 'Already in.'));
		const mapped = mapOk(failure, () => 1);
		expect(mapped).toBe(failure);
		expectErr(mapped, 'realm.already_member');
	});

	test('mapErr transforms a failure and passes a success through', () => {
		const mapped = mapErr(lookup(0), () => new Gone());
		expect(!mapped.ok && mapped.error).toBeInstanceOf(Gone);
		const kept = lookup(5);
		expect<unknown>(mapErr(kept, () => new Gone())).toBe(kept);
	});

	test('andThen runs the next step on a success and skips it on a failure', async () => {
		const next = async (n: number): Promise<Result<string, Gone>> => ok(String(n));
		const chained = await andThen(lookup(7), next);
		expect(chained).toEqual(ok('7'));
		const failed = lookup(0);
		expect<unknown>(await andThen(failed, next)).toBe(failed);
		assertTrue<Equal<ErrorOf<typeof chained>, Missing | Taken | Gone>>();
	});

	test('isOk and isErr tell the branches apart', () => {
		expect(isOk(lookup(5))).toBe(true);
		expect(isErr(lookup(5))).toBe(false);
		expect(isErr(lookup(0))).toBe(true);
	});

	test('isError narrows to the one error, leaving the rest', () => {
		const missing = lookup(0);
		expect(isError(missing, Missing)).toBe(true);
		expect(isError(missing, Taken)).toBe(false);
		expect(isError(lookup(5), Missing)).toBe(false);

		const r = lookup(1);
		if (isError(r, Taken)) {
			expectType<Taken>(r.error);
			// @ts-expect-error the branch holds only Taken, not Missing
			expectType<Missing>(r.error);
		} else {
			throw new Error('expected Taken');
		}
	});

	test('pipe passes values along and stops at the first error', async () => {
		const parse = async (s: string): Promise<Result<number, Missing>> =>
			s === '' ? err(new Missing()) : ok(Number(s));
		const check = async (n: number): Promise<Result<number, Taken>> =>
			n === 1 ? err(new Taken()) : ok(n * 2);
		let reached = false;
		const show = async (n: number): Promise<Result<string, Gone>> => {
			reached = true;
			return ok(`n=${n}`);
		};
		const run = pipe(parse, check, show);

		expect(await run('4')).toEqual(ok('n=8'));
		expect(reached).toBe(true);

		reached = false;
		const stopped = await run('1');
		expect(!stopped.ok && stopped.error).toBeInstanceOf(Taken);
		expect(reached).toBe(false);

		assertTrue<Equal<ErrorOf<Awaited<ReturnType<typeof run>>>, Missing | Taken | Gone>>();
		assertTrue<Equal<ValueOf<Awaited<ReturnType<typeof run>>>, string>>();
	});

	test('all runs every function with the same arguments and returns each result', async () => {
		const seen: string[] = [];
		const first = async (id: string): Promise<Result<number, Missing>> => {
			seen.push(`first:${id}`);
			return ok(id.length);
		};
		const second = async (id: string): Promise<Result<string, Taken>> => {
			seen.push(`second:${id}`);
			return err(new Taken());
		};
		const third = async (): Promise<Result<boolean, never>> => ok(true);

		const [a, b, c] = await all(first, second, third)('abc');
		expect(a).toEqual(ok(3));
		expect(!b.ok && b.error).toBeInstanceOf(Taken);
		expect(c).toEqual(ok(true));
		expect(seen.sort()).toEqual(['first:abc', 'second:abc']);
		assertTrue<Equal<typeof a, Result<number, Missing>>>();
		assertTrue<Equal<typeof b, Result<string, Taken>>>();
	});

	test('unwrap returns the value or throws the error', async () => {
		expect(unwrap(lookup(5))).toBe(5);
		expect(() => unwrap(lookup(0))).toThrow(Missing);
		expect(await unwrap(Promise.resolve(lookup(5)))).toBe(5);
		await expect(unwrap(Promise.resolve(lookup(1)))).rejects.toBeInstanceOf(Taken);
	});

	test('value reads a result that cannot fail', () => {
		expect(value(ok(3))).toBe(3);
		expect(() => value(err(new Gone()) as unknown as Result<number, never>)).toThrow(Gone);
	});

	test('orElse returns the fallback on an error result and on a rejection', async () => {
		expect(await orElse(Promise.resolve(lookup(5)), 9)).toBe(5);
		expect(await orElse(Promise.resolve(lookup(0)), 9)).toBe(9);
		expect(await orElse(Promise.reject(new Error('down')), 9)).toBe(9);
	});

	test('fn turns a throw into err(mapError(caught)) and passes the arguments on', async () => {
		const wrapped = fn(
			async (n: number) => {
				if (n < 0) throw new Error('negative');
				return n + 1;
			},
			(caught, n) => new Gone(`${n}: ${(caught as Error).message}`),
		);
		expect(await wrapped(1)).toEqual(ok(2));
		const failed = await wrapped(-1);
		expect(!failed.ok && failed.error).toBeInstanceOf(Gone);
		expect(!failed.ok && failed.error.message).toBe('-1: negative');
		assertTrue<Equal<typeof failed, Result<number, Gone>>>();
	});

	test('exec runs the call once and maps a throw', async () => {
		let calls = 0;
		const fine = await exec(
			async () => {
				calls += 1;
				return 'fine';
			},
			() => new Gone(),
		);
		expect(fine).toEqual(ok('fine'));
		expect(calls).toBe(1);
		const failed = await exec(
			async () => {
				throw new Error('boom');
			},
			() => new Gone(),
		);
		expect(!failed.ok && failed.error).toBeInstanceOf(Gone);
	});

	test('forget never throws and logs a failure at warn', async () => {
		const { logger, lines } = captureLogger();
		expect(() =>
			forget(
				logger,
				async (reason: string) => {
					throw new Error(reason);
				},
				'boom',
			),
		).not.toThrow();
		await Bun.sleep(0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			level: 40,
			msg: 'background work failed',
			err: { message: 'boom' },
		});
	});

	test('forget logs nothing when the work succeeds', async () => {
		const { logger, lines } = captureLogger();
		forget(logger, async () => 'done');
		await Bun.sleep(0);
		expect(lines).toEqual([]);
	});
});
