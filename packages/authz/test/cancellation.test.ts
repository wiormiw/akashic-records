import { afterAll, describe, expect, test } from 'bun:test';
import { AppError } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { FgaType, createAuthorizer } from '@akashic/authz';

// An OpenFGA that accepts every request and never answers: what a hung one looks like.
let requests = 0;
const hung = Bun.serve({
	port: 0,
	fetch: () => {
		requests++;
		return new Promise<Response>(() => {});
	},
});
afterAll(() => hung.stop(true));

const authorizer = (timeoutMs: number) =>
	createAuthorizer({
		apiUrl: `http://localhost:${hung.port}`,
		storeId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
		modelId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
		timeoutMs,
		logger: silentLogger(),
	});

const check = { userId: 'u1', relation: 'member', type: FgaType.realm, objectId: 'r1' };
const write = {
	writes: [{ subject: { userId: 'u1' }, relation: 'member', type: FgaType.realm, objectId: 'r1' }],
};

describe('openfga authorizer against a service that never answers', () => {
	test('the request times out on its own, as an outage', async () => {
		const started = performance.now();
		const error = await authorizer(50)
			.check(check)
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AppError);
		expect((error as AppError).code).toBe('external.authz.unavailable');
		// Four attempts of 50ms plus the SDK's backoff, not forever.
		expect(performance.now() - started).toBeLessThan(5000);
	});

	test("the caller's deadline ends the wait first, with the signal's reason, not an outage", async () => {
		const started = performance.now();
		const error = await authorizer(10_000)
			.write(write, AbortSignal.timeout(50))
			.catch((e: unknown) => e);
		expect(error).not.toBeInstanceOf(AppError);
		expect((error as Error).name).toBe('TimeoutError');
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test('an already aborted signal sends nothing', async () => {
		const controller = new AbortController();
		controller.abort(new Error('shutting down'));
		const before = requests;
		await expect(authorizer(10_000).checkMany([check], controller.signal)).rejects.toThrow(
			'shutting down',
		);
		expect(requests).toBe(before);
	});
});
