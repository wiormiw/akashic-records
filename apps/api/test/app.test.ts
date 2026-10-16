import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Authorizer } from '@akashic/authz';
import type { Db } from '@akashic/db';
import { createLifecycle } from '@akashic/lib/lifecycle';
import { silentLogger } from '@akashic/lib/log';
import { createApp } from '@/app.ts';
import type { Auth } from '@/auth/auth.ts';
import type { AppEnv } from '@/http/env.ts';
import { sessions } from '@/http/session.ts';
import { createMemoryCounters } from '@/integrations/counters.ts';
import type { Mailer } from '@/integrations/mail.ts';
import { createRateLimiter } from '@/integrations/rate-limit.ts';
import { UPLOAD_BODY_BYTES } from '@/config.ts';
import type { ModuleRoutes } from '@/modules/module.ts';
import { createUploadRoutes } from '@/modules/upload/upload.routes.ts';
import { createUploadService } from '@/modules/upload/upload.service.ts';
import { memoryStore } from './modules/upload/fixtures.ts';

const rule = { limit: 100, windowSeconds: 60 };

let sessionLookups = 0;

const ORIGIN = 'https://web.test';

const build = (
	session: { user: { id: string; email: string } } | null,
	extra: { modules?: ModuleRoutes[] } = {},
) => {
	const lifecycle = createLifecycle(silentLogger());
	lifecycle.markReady();
	const auth = {
		api: {
			getSession: async () => {
				sessionLookups += 1;
				return session;
			},
		},
	} as unknown as Auth;
	return createApp({
		logger: silentLogger(),
		lifecycle,
		auth,
		sessions: sessions({
			auth,
			// The ban lookup finds no row: nobody is suspended.
			db: {
				select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
			} as unknown as Db,
			authorizer: { check: async () => false } as unknown as Authorizer,
		}),
		mailer: {
			send: async () => {},
			health: () => ({ configured: false, healthy: false, lastFailure: null, failedAt: null }),
		} satisfies Mailer,
		limiter: createRateLimiter({ counters: createMemoryCounters() }),
		limits: {
			api: { ...rule, bucket: 'api' },
			auth: { ...rule, bucket: 'auth-read' },
			credentials: { ...rule, bucket: 'auth' },
		},
		allowedOrigins: [ORIGIN],
		maxBodyBytes: 1024 * 1024,
		budgetMs: 5000,
		trustProxy: false,
		checks: { required: { database: async () => true }, optional: {} },
		modules: [
			{
				private: new Hono<AppEnv>().get('/whoami', (c) =>
					c.text(`${c.var.requestId} ${c.var.user?.id}`),
				),
				public: new Hono<AppEnv>().get('/whoami', (c) => c.text(String(c.var.user))),
				root: new Hono<AppEnv>().get('/socket', (c) => c.text('root')),
			},
			...(extra.modules ?? []),
		],
	});
};

describe('app', () => {
	test('liveness and readiness', async () => {
		const app = build(null);
		expect((await app.request('/livez')).status).toBe(200);
		const ready = await app.request('/readyz');
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: 'ready', database: true });
	});

	test('a private route without a session is 401', async () => {
		const res = await build(null).request('/api/v1/whoami');
		expect(res.status).toBe(401);
		expect(((await res.json()) as { code: string }).code).toBe('auth.session.unauthenticated');
	});

	test('a private route sees the request id and the caller on the context', async () => {
		const res = await build({ user: { id: 'u1', email: 'u1@x.test' } }).request('/api/v1/whoami', {
			headers: { 'x-request-id': 'req-1' },
		});
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('req-1 u1');
	});

	test('an unknown route is the not-found problem, and carries a request id', async () => {
		const res = await build(null).request('/nope');
		expect(res.status).toBe(404);
		expect(((await res.json()) as { code: string }).code).toBe('common.route.not_found');
		expect(res.headers.get('x-request-id')).toBeTruthy();
	});

	test('a public route sees a visitor, without looking up a session', async () => {
		const app = build({ user: { id: 'u1', email: 'u1@x.test' } });
		sessionLookups = 0;
		const res = await app.request('/api/public/v1/whoami');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('null');
		expect(sessionLookups).toBe(0);
	});

	test("a module's root routes are mounted at the app root", async () => {
		const res = await build(null).request('/socket');
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('root');
	});
});

describe('an oversized upload', () => {
	/** The app with the real upload routes, over a store that remembers what reached it. */
	const withUploads = () => {
		const { store, stored } = memoryStore();
		const app = build(
			{ user: { id: 'u1', email: 'u1@x.test' } },
			{
				modules: [
					createUploadRoutes({
						uploads: createUploadService({ store }),
						limiter: createRateLimiter({ counters: createMemoryCounters() }),
						trustProxy: false,
						logger: silentLogger(),
					}),
				],
			},
		);
		return { app, stored };
	};

	const expectTooLarge = async (res: Response, requestId: string) => {
		expect(res.status).toBe(413);
		expect(res.headers.get('content-type')).toContain('application/problem+json');
		expect(res.headers.get('x-request-id')).toBe(requestId);
		expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
		expect(await res.json()).toMatchObject({
			status: 413,
			code: 'common.request.payload_too_large',
			traceId: requestId,
		});
	};

	test('declared too long, it is refused unread as a 413 problem with CORS and a request id', async () => {
		const { app, stored } = withUploads();
		const res = await app.request('/api/v1/uploads/avatar', {
			method: 'POST',
			headers: {
				origin: ORIGIN,
				'x-request-id': 'req-declared',
				'content-type': 'multipart/form-data; boundary=x',
				'content-length': String(UPLOAD_BODY_BYTES + 1),
			},
			body: 'x',
		});
		await expectTooLarge(res, 'req-declared');
		expect(stored).toEqual([]);
	});

	test('streamed with no declared length, it is a 413 problem with CORS and a request id', async () => {
		const { app, stored } = withUploads();
		// Chunked, so only counting the stream can catch it: there is no content-length to judge.
		const chunk = new Uint8Array(64 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > UPLOAD_BODY_BYTES) return controller.close();
				sent += chunk.byteLength;
				controller.enqueue(chunk);
			},
		});
		const res = await app.request('/api/v1/uploads/avatar', {
			method: 'POST',
			headers: {
				origin: ORIGIN,
				'x-request-id': 'req-big',
				'content-type': 'multipart/form-data; boundary=x',
			},
			body,
			duplex: 'half',
		} as RequestInit);

		await expectTooLarge(res, 'req-big');
		expect(stored).toEqual([]);
	});
});
