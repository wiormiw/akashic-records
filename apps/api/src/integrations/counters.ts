import type { RedisClient } from 'bun';
import { owned } from '@akashic/lib/lifecycle';
import type { Logger } from '@akashic/lib/log';

/** A caller's count in the current window. */
export interface Counter {
	count: number;
	/** Seconds until the window rolls. Sent as `RateLimit-Reset` and `Retry-After`. */
	resetSeconds: number;
}

/**
 * Where request counts are kept: the strategy behind the rate limiter. Undefined means the store
 * could not answer, and the request is allowed rather than refused.
 */
export interface CounterStore {
	increment(
		key: string,
		windowSeconds: number,
		now: Temporal.Instant,
	): Promise<Counter | undefined>;
}

const SWEEP_EVERY_MS = 60_000;

/**
 * Counts in this process only: right for one instance and for tests, wrong behind several
 * replicas, where each would allow the full limit. Sweeps its own expired windows when given a
 * signal to stop it with; disposing the store stops the sweep too.
 */
export function createMemoryCounters(options: { signal?: AbortSignal } = {}) {
	const windows = new Map<string, { count: number; resetAt: Temporal.Instant }>();

	const store = {
		async increment(key: string, windowSeconds: number, now: Temporal.Instant) {
			const existing = windows.get(key);
			if (!existing || Temporal.Instant.compare(existing.resetAt, now) <= 0) {
				windows.set(key, { count: 1, resetAt: now.add({ seconds: windowSeconds }) });
				return { count: 1, resetSeconds: windowSeconds };
			}
			existing.count += 1;
			return {
				count: existing.count,
				resetSeconds: Math.ceil(now.until(existing.resetAt).total('seconds')),
			};
		},

		/** Drops expired windows, so a stream of one-off callers cannot grow the map forever. */
		sweep(now: Temporal.Instant = Temporal.Now.instant()) {
			for (const [key, window] of windows) {
				if (Temporal.Instant.compare(window.resetAt, now) <= 0) windows.delete(key);
			}
		},
	} satisfies CounterStore & { sweep(now?: Temporal.Instant): void };

	// Unref'd so a store nobody disposes (a test's) cannot hold the process open.
	const timer = setInterval(() => store.sweep(), SWEEP_EVERY_MS);
	timer.unref();
	const stop = () => clearInterval(timer);
	options.signal?.addEventListener('abort', stop, { once: true });
	if (options.signal?.aborted) stop();
	return owned(store, stop);
}

// INCR and read the TTL in one round trip, creating the window on first use. Two commands would
// race: between INCR and EXPIRE another replica can see a key with no TTL, which lives forever.
const INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`.trim();

/**
 * Counts in Redis, shared by every replica. When Redis cannot answer, the request is allowed:
 * falling back to per-process counts would let each of N replicas allow the full limit.
 */
export function createRedisCounters(options: { redis: RedisClient; logger: Logger }): CounterStore {
	const client = options.redis;
	const log = options.logger.child({ component: 'rate-limit' });
	let scriptSha: string | undefined;

	return {
		async increment(key, windowSeconds) {
			const args = [key, String(windowSeconds)];
			try {
				const raw = scriptSha
					? await client
							.send('EVALSHA', [scriptSha, '1', ...args])
							.catch(async (error: unknown) => {
								// Gone from the server's cache after a restart or SCRIPT FLUSH: send the body again.
								if (!String(error).includes('NOSCRIPT')) throw error;
								scriptSha = undefined;
								return client.send('EVAL', [INCREMENT_SCRIPT, '1', ...args]);
							})
					: await client.send('EVAL', [INCREMENT_SCRIPT, '1', ...args]);

				scriptSha ??= Bun.SHA1.hash(INCREMENT_SCRIPT, 'hex');
				const [count, ttl] = raw as [number, number];
				return { count: Number(count), resetSeconds: Math.max(Number(ttl), 0) };
			} catch (error) {
				log.error({ err: error }, 'redis unavailable, allowing request');
				return undefined;
			}
		},
	};
}
