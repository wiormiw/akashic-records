import type { Broker } from './connection.ts';

/** One consumer's place on the exchange: its queue, and the event types it binds. */
export interface ConsumerTopology {
	readonly exchange: string;
	readonly queue: string;
	readonly routingKeys: readonly string[];
	readonly retryDelayMs: number;
}

/** A queue declaration, as rabbitmq-client takes it. */
export interface QueueDeclaration {
	queue: string;
	durable: boolean;
	arguments?: Record<string, unknown>;
}

export const retryQueueOf = (queue: string) => `${queue}.retry`;
export const deadQueueOf = (queue: string) => `${queue}.dead`;

/** The retry and dead queues beside a consumer's queue. Stored in RabbitMQ: never rename them. */
export function sideQueues(queue: string, retryDelayMs: number): QueueDeclaration[] {
	return [
		{
			queue: retryQueueOf(queue),
			durable: true,
			// A fixed delay: a TTL'd message leaves only from the head, so mixed delays would hold each
			// other up. Expired, it goes back to the work queue.
			arguments: {
				'x-message-ttl': retryDelayMs,
				'x-dead-letter-exchange': '',
				'x-dead-letter-routing-key': queue,
			},
		},
		{ queue: deadQueueOf(queue), durable: true },
	];
}

/**
 * Declares the exchange and, for each consumer, its queue, bindings, retry and dead queues. The
 * dispatcher waits for this before its first publish: on a fresh broker an event published before
 * its queue is bound is confirmed, routed nowhere, and lost. Declarations are idempotent.
 */
export async function declareTopology(
	broker: Broker,
	topologies: readonly ConsumerTopology[],
): Promise<void> {
	const { connection } = broker;
	for (const exchange of new Set(topologies.map((t) => t.exchange))) {
		await connection.exchangeDeclare({ exchange, type: 'topic', durable: true });
	}
	for (const topology of topologies) {
		await connection.queueDeclare({ queue: topology.queue, durable: true });
		for (const declaration of sideQueues(topology.queue, topology.retryDelayMs)) {
			await connection.queueDeclare(declaration);
		}
		for (const routingKey of topology.routingKeys) {
			await connection.queueBind({
				queue: topology.queue,
				exchange: topology.exchange,
				routingKey,
			});
		}
	}
}
