import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import { ContentTooLarge, Forbidden } from '@akashic/lib/errors';
import type { AppEnv } from './env.ts';

/** "a, b" -> ["a", "b"]. An empty list trusts no browser origin. */
export const parseOrigins = (value: string): string[] =>
	value
		.split(',')
		.map((origin) => origin.trim())
		.filter(Boolean);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** CORS, security headers, a body-size ceiling, and an Origin check on state-changing requests. */
export function security(options: {
	allowedOrigins: string[];
	maxBodyBytes: number;
	/** Path prefixes with their own, larger body limit, such as uploads. */
	largeBodyPaths?: string[];
}) {
	const { allowedOrigins, maxBodyBytes, largeBodyPaths = [] } = options;

	// With credentials, reflecting any origin is no policy at all, so none means CORS is off.
	const corsPolicy = cors({
		origin: (origin) => (allowedOrigins.includes(origin) ? origin : null),
		credentials: true,
		maxAge: 600,
	});

	const checks = createMiddleware<AppEnv>(async (c, next) => {
		// Judged on the declared length, so an oversized body is refused before it is read.
		const exempt = largeBodyPaths.some((prefix) => c.req.path.startsWith(prefix));
		if (!exempt && Number(c.req.header('content-length') ?? 0) > maxBodyBytes) {
			throw new ContentTooLarge(`Request body exceeds ${maxBodyBytes} bytes.`);
		}

		// Cookies ride along on cross-site requests; the Origin header is what proves the page is
		// ours. Requests without one (curl, servers) aren't the threat here.
		const origin = c.req.header('origin');
		if (!SAFE_METHODS.has(c.req.method) && allowedOrigins.length > 0 && origin !== undefined) {
			if (!allowedOrigins.includes(origin)) {
				throw new Forbidden('Origin not allowed for a state-changing request.');
			}
		}
		await next();
	});

	return createMiddleware<AppEnv>((c, next) => {
		// Before cors, which answers a preflight without running what follows.
		c.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
		c.header('x-content-type-options', 'nosniff');
		c.header('referrer-policy', 'no-referrer');
		return corsPolicy(c, async () => void (await checks(c, next)));
	});
}
