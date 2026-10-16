import { getConnInfo } from 'hono/bun';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { RateLimited } from '@akashic/lib/errors';
import type { Logger } from '@akashic/lib/log';
import type { RateLimiter, RateLimitRule } from '@/integrations/rate-limit.ts';
import type { AppEnv } from './env.ts';

/** Enforces `rule` per account once known, else per IP, and sets the RateLimit headers. */
export function rateLimit(
	limiter: RateLimiter,
	rule: RateLimitRule,
	options: { trustProxy: boolean; logger: Logger },
) {
	const log = options.logger.child({ component: 'rate-limit' });
	return createMiddleware<AppEnv>(async (c, next) => {
		const user = c.get('user');
		const caller = user ? `u:${user.id}` : `ip:${clientIp(c, options.trustProxy)}`;
		const counter = await limiter.hit(rule, caller);
		// No counter means the store couldn't answer. Fail open: failing closed turns a cache outage
		// into a total outage.
		if (counter) {
			c.header('ratelimit-limit', String(rule.limit));
			c.header('ratelimit-remaining', String(Math.max(rule.limit - counter.count, 0)));
			c.header('ratelimit-reset', String(counter.resetSeconds));
			if (counter.count > rule.limit) {
				c.header('retry-after', String(counter.resetSeconds));
				log.warn({ bucket: rule.bucket, caller, count: counter.count }, 'rate limit exceeded');
				throw new RateLimited('Too many requests. Slow down.', {
					details: {
						limit: rule.limit,
						windowSeconds: rule.windowSeconds,
						retryAfter: counter.resetSeconds,
					},
				});
			}
		}
		await next();
	});
}

// Proxy headers are the client's own words unless our proxy wrote them, so they are read only
// when told one is in front. Behind an appending proxy the left-most X-Forwarded-For entry is
// whatever the client sent; the right-most is the hop our proxy added.
function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
	if (trustProxy) {
		const hops = c.req.header('x-forwarded-for')?.split(',');
		const forwarded = hops?.at(-1)?.trim();
		const real = c.req.header('x-real-ip')?.trim();
		const viaProxy = forwarded || real;
		if (viaProxy) return viaProxy;
	}
	try {
		return getConnInfo(c).remote.address ?? 'unknown';
	} catch {
		// `app.request()` in tests has no socket.
		return 'unknown';
	}
}
