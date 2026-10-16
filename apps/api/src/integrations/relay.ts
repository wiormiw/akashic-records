import type { RedisClient } from 'bun';
import type { Logger } from '@akashic/lib/log';
import { owned } from '@akashic/lib/lifecycle';

/** Fans a WebSocket publish out to every instance, so sockets on other pods see it too. */
export interface Relay {
	publish(topic: string, payload: string): void;
	/** Delivers what other instances publish. Call once the server exists. */
	start(deliver: (topic: string, payload: string) => void): Promise<void>;
}

/** One instance: every socket is already local, so there is nothing to relay. */
export function createLocalRelay(options: { logger: Logger }): Relay {
	const log = options.logger.child({ component: 'relay' });
	return {
		publish() {},
		async start() {
			log.info('no redis: messages reach only sockets on this instance');
		},
	};
}

/** Several instances: a Redis channel carries each publish to the others. */
export function createRedisRelay(options: {
	redis: RedisClient;
	channel: string;
	logger: Logger;
}): Relay & AsyncDisposable {
	const { redis, channel } = options;
	const log = options.logger.child({ component: 'relay' });
	// Each instance ignores its own messages: it already delivered them locally.
	const origin = Bun.randomUUIDv7();
	let subscriber: Awaited<ReturnType<RedisClient['duplicate']>> | undefined;

	const relay: Relay = {
		publish(topic, payload) {
			redis.publish(channel, JSON.stringify({ origin, topic, payload })).catch((error: unknown) => {
				log.warn({ err: error, topic }, 'could not relay to other instances');
			});
		},

		async start(deliver) {
			// A subscribed connection can't run other commands, so it gets its own.
			const connection = await redis.duplicate();
			subscriber = connection;
			await connection.subscribe(channel, (message) => {
				try {
					const frame = JSON.parse(message) as { origin: string; topic: string; payload: string };
					if (frame.origin !== origin) deliver(frame.topic, frame.payload);
				} catch {
					log.warn('dropped an unreadable relay frame');
				}
			});
			log.info('relaying between instances');
		},
	};

	// Disposal closes the subscription `start` opened, if it got that far.
	return owned(relay, async () => {
		await subscriber?.unsubscribe(channel).catch(() => undefined);
		subscriber?.close();
	});
}
