import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import * as v from 'valibot';
import { captureLogger } from '@akashic/lib/testing';
import type { AppEnv } from '@/http/env.ts';
import { problemHandler } from '@/http/problem.ts';
import { validate } from '@/http/validate.ts';

const app = new Hono<AppEnv>().post(
	'/x',
	validate('json', v.object({ name: v.pipe(v.string(), v.minLength(2)) })),
	(c) => c.text(c.req.valid('json').name),
);
const { logger, lines } = captureLogger();
app.onError(problemHandler(logger));

const post = (body: unknown) =>
	app.request('/x', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

describe('validate', () => {
	test("a failure is the usual problem, with the issue's path", async () => {
		const res = await post({ name: 'a' });
		expect(res.status).toBe(400);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		const body = (await res.json()) as { code: string; details: { issues: { path: string }[] } };
		expect(body.code).toBe('common.request.validation_failed');
		expect(body.details.issues[0]?.path).toBe('name');
	});

	test('a valid body reaches the handler', async () => {
		const res = await post({ name: 'ab' });
		expect(await res.text()).toBe('ab');
	});

	test('a malformed body is a 400 validation problem, not a logged 500', async () => {
		lines.length = 0;
		const res = await app.request('/x', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{bad',
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe('common.request.validation_failed');
		expect(lines.filter((l) => (l.level as number) >= 50)).toEqual([]);
	});
});
