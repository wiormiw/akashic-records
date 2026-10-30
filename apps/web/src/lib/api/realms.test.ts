import { describe, expect, mock, test } from 'bun:test';
import { RealmModule } from '@akashic/lib/enums';

// bun test has no SvelteKit aliases, so the config module is stubbed before realms.ts loads.
mock.module('#lib/config.ts', () => ({ API_BASE: 'http://api.test' }));
const { listRealms } = await import('./realms');

type Equal<A, B> =
	(<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>() => {};

const summary = {
	id: 'r1',
	slug: 'tokyo',
	name: 'Tokyo',
	description: null,
	category: null,
	memberCount: 3,
	modules: [RealmModule.jobs, RealmModule.events],
};

const answering = (body: unknown): typeof fetch =>
	(() => Promise.resolve(Response.json(body))) as unknown as typeof fetch;

describe('listRealms', () => {
	test('a realm with an unknown module drops to the fallback, never throws', async () => {
		const realms = await listRealms({ fetch: answering([{ ...summary, modules: [9] }]) });
		expect(realms).toEqual([]);
	});

	test('an unreachable API renders the empty directory', async () => {
		const down = (() =>
			Promise.reject(new TypeError('connection refused'))) as unknown as typeof fetch;
		expect(await listRealms({ fetch: down })).toEqual([]);
	});

	test('a valid summary parses with the contract view', async () => {
		const realms = await listRealms({ fetch: answering([summary]) });
		expect(realms).toEqual([summary]);

		// Compile-time only: svelte-check fails the build if the modules widen back to number[].
		assertType<Equal<(typeof realms)[number]['modules'], RealmModule[]>>();
	});
});
