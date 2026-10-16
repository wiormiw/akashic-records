import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { DuplicateSlug, NotBothMembers, RealmNotFound } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import { err, ok, type Result } from '@akashic/lib/result';
import type { AppEnv } from '@/http/env.ts';
import { problemHandler } from '@/http/problem.ts';
import { reply, respond } from '@/http/reply.ts';

const View = v.object({ id: v.string(), status: v.picklist([0, 1]) });

// A service result with a named error union, as migrated services return.
const refusedTyped = (): Result<v.InferInput<typeof View>, RealmNotFound | NotBothMembers> =>
	err(new NotBothMembers());

const app = new Hono<AppEnv>()
	.use(async (c, next) => {
		c.set('requestId', 'req-1');
		await next();
	})
	.get('/leaky', (c) => reply(c, View, { id: 'a', status: 0, email: 'x@y.z' } as never))
	.get('/bad', (c) => reply(c, View, { id: 'a', status: 9 } as never))
	.get('/created', (c) => respond(c, ok({ id: 'a', status: 1 as const }), View, 201))
	.get('/refused', (c) => respond(c, err(new DuplicateSlug('Taken.')), View))
	.get('/typed', (c) => respond(c, refusedTyped(), View));
app.onError(problemHandler(silentLogger()));

describe('reply', () => {
	test('an undeclared field never leaves', async () => {
		const res = await app.request('/leaky');
		expect(await res.json()).toEqual({ id: 'a', status: 0 });
	});

	test('a value outside the view fails as our error, not sent', async () => {
		const res = await app.request('/bad');
		expect(res.status).toBe(500);
		expect(((await res.json()) as { code: string }).code).toBe('common.server.unexpected');
	});

	test('respond sends an ok with its status, and an err as problem+json', async () => {
		expect((await app.request('/created')).status).toBe(201);
		const refused = await app.request('/refused');
		expect(refused.status).toBe(409);
		expect(refused.headers.get('content-type')).toContain('application/problem+json');
		expect(((await refused.json()) as { traceId: string }).traceId).toBe('req-1');
	});

	test('respond renders an error class by its kind and code', async () => {
		const res = await app.request('/typed');
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: 'realm.not_member',
			detail: 'Both people have to be in the realm the posting belongs to.',
		});
	});
});
