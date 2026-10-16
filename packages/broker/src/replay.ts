import type { Broker } from './connection.ts';
import { deadQueueOf } from './topology.ts';

/** How many messages wait in a consumer's dead queue; zero when it doesn't exist yet. */
export async function deadCount(broker: Broker, queue: string): Promise<number> {
	try {
		const { messageCount } = await broker.connection.queueDeclare({
			queue: deadQueueOf(queue),
			passive: true,
		});
		return messageCount;
	} catch {
		return 0;
	}
}

/**
 * Moves up to `limit` messages from `<queue>.dead` back onto `<queue>`, each with a fresh set of
 * attempts. A message leaves the dead queue only once the broker has confirmed its copy: a crash
 * in between leaves it in both, and the consumer, being idempotent, handles it twice harmlessly.
 */
export async function replayDead(broker: Broker, queue: string, limit: number): Promise<number> {
	const channel = await broker.connection.acquire();
	try {
		await channel.confirmSelect();
		let moved = 0;
		while (moved < limit) {
			const message = await channel.basicGet({ queue: deadQueueOf(queue) });
			if (!message) break;
			// The attempt count restarts; the last error stays as a record of why it was parked.
			const { 'x-attempt': _attempt, ...headers } = message.headers ?? {};
			await channel.basicPublish(
				{
					routingKey: queue,
					messageId: message.messageId,
					type: message.type,
					contentType: 'application/json',
					durable: true,
					headers,
				},
				message.body,
			);
			channel.basicAck({ deliveryTag: message.deliveryTag });
			moved++;
		}
		return moved;
	} finally {
		await channel.close();
	}
}
