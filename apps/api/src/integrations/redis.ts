import { RedisClient } from 'bun';
import type { Logger } from '@akashic/lib/log';

export interface Redis {
	/** Undefined when no REDIS_URL is set: features fall back to per-process state. */
	readonly client: RedisClient | undefined;
	/**
	 * Connects eagerly, so a bad URL shows up at startup rather than on the first request. Never
	 * blocks startup on an unreachable Redis: it warns and keeps retrying in the background.
	 */
	connect(): Promise<void>;
	/** For readiness. Also tries to reconnect: Bun stops retrying once `maxRetries` runs out. */
	ping(): Promise<boolean>;
	close(): void;
}

export function createRedis(options: {
	url: string | undefined;
	logger: Logger;
	/** How long `connect` waits for an answer before carrying on. Default 3s. */
	connectWaitMs?: number;
}): Redis {
	const log = options.logger.child({ component: 'redis' });

	const client = options.url
		? new RedisClient(options.url, {
				maxRetries: 200,
				// Fail fast while disconnected instead of queueing commands behind a dead socket.
				enableOfflineQueue: false,
				connectionTimeout: 3000,
			})
		: undefined;

	const connectWaitMs = options.connectWaitMs ?? 3000;
	let reviving = false;

	// Bounded, because Bun's connect() settles only once every retry is spent: minutes against a
	// dead host. Awaited unbounded at startup, that kept the API from ever listening.
	async function attempt(redis: RedisClient): Promise<boolean> {
		const connecting = redis.connect();
		connecting.catch(() => {}); // it may still reject after we stop waiting
		let timer: Timer | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`no answer within ${connectWaitMs}ms`)),
				connectWaitMs,
			);
		});
		try {
			await Promise.race([connecting, deadline]);
			return true;
		} catch (error) {
			log.debug({ err: error }, 'redis connect attempt failed');
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	/** True once connected. One attempt at a time; concurrent callers don't pile on. */
	async function revive(): Promise<boolean> {
		if (!client || client.connected) return true;
		if (reviving) return false;
		reviving = true;
		const connected = await attempt(client);
		reviving = false;
		if (connected) log.info('redis connected');
		return connected;
	}

	return {
		client,

		async connect() {
			if (!client) {
				log.warn("REDIS_URL unset: rate limits are per-process and won't hold across replicas");
				return;
			}
			if (await revive()) return;
			log.warn(
				'redis unreachable at startup: rate limits allow requests and readiness reports it until it answers',
			);
		},

		async ping() {
			if (!client) return true; // Not configured isn't unhealthy.
			try {
				await client.send('PING', []);
				return true;
			} catch (error) {
				log.error({ err: error }, 'redis ping failed');
				void revive();
				return false;
			}
		},

		close() {
			client?.close();
		},
	};
}
