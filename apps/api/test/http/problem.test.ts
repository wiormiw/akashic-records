import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { ErrorCode, Forbidden } from '@akashic/lib/errors';
import { silentLogger } from '@akashic/lib/log';
import type { AppEnv } from '@/http/env.ts';
import { notFound, problemHandler } from '@/http/problem.ts';

const abort = new AbortController();

const app = new Hono<AppEnv>()
	.use(async (c, next) => {
		c.set('requestId', 'req-1');
		await next();
	})
	.get('/refuse', () => {
		throw new Forbidden('Nope.');
	})
	.get('/aborted', () => {
		abort.abort();
		throw new Error('after abort');
	});
app.onError(problemHandler(silentLogger()));
app.notFound(notFound);

describe('problem handler', () => {
	test('a thrown AppError renders its status and code', async () => {
		const res = await app.request('/refuse');
		expect(res.status).toBe(403);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		expect(((await res.json()) as { code: string }).code).toBe(ErrorCode.common.forbidden);
	});

	test('an unknown route is common.route.not_found', async () => {
		const res = await app.request('/nowhere');
		expect(res.status).toBe(404);
		expect(((await res.json()) as { code: string }).code).toBe('common.route.not_found');
	});

	test("a throw after the request's signal aborted is a 499", async () => {
		const res = await app.fetch(new Request('http://localhost/aborted', { signal: abort.signal }));
		expect(res.status).toBe(499);
	});
});
