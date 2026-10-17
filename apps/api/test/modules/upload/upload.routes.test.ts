import { afterAll, describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { createDb } from '@akashic/db';
import { withRollback } from '@akashic/db/testing';
import { silentLogger } from '@akashic/lib/log';
import { policy } from '@/config.ts';
import { databaseUrl, person } from '../../support/fixtures.ts';
import { uploadApp } from './app.ts';
import { JPEG, memoryStore, PNG } from './fixtures.ts';

// Both upload routes through app.request. The session looks the caller up in Postgres, so these run
// on the real database in a rolled-back transaction.

// The web app's schema (akashic_records_fe/src/lib/api/uploads.ts); Plan 3 replaces it with the
// shared contract.
const WebUploadPolicy = v.object({
	enabled: v.boolean(),
	imageTypes: v.array(v.string()),
	maxBytes: v.number(),
});

const database = createDb({
	url: databaseUrl,
	poolMax: 2,
	idleTimeoutS: 5,
	connectTimeoutS: 2,
	logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

const formOf = (file: File | undefined) => {
	const form = new FormData();
	if (file) form.set('file', file);
	return form;
};

const scenario = (
	run: (
		s: ReturnType<typeof uploadApp> & {
			user: string;
			stored: ReturnType<typeof memoryStore>['stored'];
		},
	) => Promise<void>,
	configured = true,
) =>
	withRollback(database.db, async (tx) => {
		const { store, stored } = memoryStore(configured);
		await run({ ...uploadApp(tx, store), user: await person(tx), stored });
	});

describe.skipIf(!live)('uploads', () => {
	test('GET /uploads answers the limits as the web app reads them', () =>
		scenario(async ({ call, user }) => {
			const { status, body } = await call('GET', '/api/v1/uploads', { as: user });
			expect(status).toBe(200);
			expect(v.parse(WebUploadPolicy, body)).toEqual({
				enabled: true,
				imageTypes: [...policy.uploads.imageTypes],
				maxBytes: policy.uploads.maxBytes,
			});
		}));

	test('signed out is 401 on both routes', () =>
		scenario(async ({ call }) => {
			expect((await call('GET', '/api/v1/uploads')).status).toBe(401);
			const form = formOf(new File([PNG], 'a.png', { type: 'image/png' }));
			expect((await call('POST', '/api/v1/uploads/listings', { form })).status).toBe(401);
		}));

	test('POST files an image by purpose (201, a url the web app can store)', () =>
		scenario(async ({ call, user, stored }) => {
			const form = formOf(new File([JPEG], 'a.jpg', { type: 'image/jpeg' }));
			const { status, body } = await call('POST', '/api/v1/uploads/avatars', { as: user, form });
			expect(status).toBe(201);
			expect(body).toEqual({ url: 'http://cdn.test/avatars/1' });
			expect(stored).toEqual([{ type: 'image/jpeg', prefix: 'avatars' }]);
		}));

	test('a file the bytes disown is 400, whatever type it declares', () =>
		scenario(async ({ call, user }) => {
			const form = formOf(new File(['GIF89a...'], 'a.png', { type: 'image/png' }));
			const refused = await call('POST', '/api/v1/uploads/listings', { as: user, form });
			expect(refused.status).toBe(400);
			expect(refused.body.code).toBe('common.request.validation_failed');
		}));

	test('a declared type outside the policy, a missing file and an unknown purpose are 400', () =>
		scenario(async ({ call, user }) => {
			const gif = formOf(new File([PNG], 'a.gif', { type: 'image/gif' }));
			expect((await call('POST', '/api/v1/uploads/listings', { as: user, form: gif })).status).toBe(
				400,
			);
			const none = await call('POST', '/api/v1/uploads/listings', {
				as: user,
				form: formOf(undefined),
			});
			expect(none.status).toBe(400);
			expect(none.body.code).toBe('common.request.validation_failed');
			const form = formOf(new File([PNG], 'a.png', { type: 'image/png' }));
			const unknown = await call('POST', '/api/v1/uploads/banners', { as: user, form });
			expect(unknown.status).toBe(400);
		}));

	test('a file over the size limit is refused before the service sees it', () =>
		scenario(async ({ call, user, stored }) => {
			const huge = new File([new Uint8Array(policy.uploads.maxBytes + 1)], 'a.png', {
				type: 'image/png',
			});
			const refused = await call('POST', '/api/v1/uploads/listings', {
				as: user,
				form: formOf(huge),
			});
			expect(refused.status).toBe(400);
			expect(stored).toEqual([]);
		}));

	test('without a bucket: limits say disabled, an upload is 502 external.storage.not_configured', () =>
		scenario(async ({ call, user }) => {
			const limits = await call('GET', '/api/v1/uploads', { as: user });
			expect(v.parse(WebUploadPolicy, limits.body).enabled).toBe(false);
			const form = formOf(new File([PNG], 'a.png', { type: 'image/png' }));
			const refused = await call('POST', '/api/v1/uploads/listings', { as: user, form });
			expect(refused.body.code).toBe('external.storage.not_configured');
			expect(refused.status).toBe(502);
		}, false));

	test("the hour's budget is spent per caller: the next request is 429", () =>
		scenario(async ({ call, user }) => {
			for (let i = 0; i < policy.uploads.perHour; i++) {
				expect((await call('GET', '/api/v1/uploads', { as: user })).status).toBe(200);
			}
			const over = await call('GET', '/api/v1/uploads', { as: user });
			expect(over.status).toBe(429);
			expect(over.body.code).toBe('common.request.rate_limited');
		}));

	test('refused uploads leave the hourly budget unspent', () =>
		scenario(async ({ call, user }) => {
			const gif = () => formOf(new File([PNG], 'a.gif', { type: 'image/gif' }));
			for (let i = 0; i < policy.uploads.perHour + 1; i++) {
				const refused = await call('POST', '/api/v1/uploads/listings', { as: user, form: gif() });
				expect(refused.status).toBe(400);
			}
			// Were refusals charged, the budget would be gone and these would be 429.
			const png = formOf(new File([PNG], 'a.png', { type: 'image/png' }));
			expect((await call('POST', '/api/v1/uploads/listings', { as: user, form: png })).status).toBe(
				201,
			);
			expect((await call('GET', '/api/v1/uploads', { as: user })).status).toBe(200);
		}));
});
