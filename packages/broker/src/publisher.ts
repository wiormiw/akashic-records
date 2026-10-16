import { isSpanContextValid, TraceFlags, type Link } from '@opentelemetry/api';
import { SpanKind, currentTraceparent, traced } from '@akashic/lib/tracing';
import type { Broker } from './connection.ts';

/** The span context a stored W3C traceparent names, for a link; undefined when it doesn't parse. */
function linkOf(traceparent: string | undefined): Link | undefined {
	const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(traceparent ?? '');
	if (!match) return undefined;
	const [, traceId = '', spanId = '', flags = '00'] = match;
	const context = {
		traceId,
		spanId,
		traceFlags: parseInt(flags, 16) & TraceFlags.SAMPLED,
		isRemote: true,
	};
	return isSpanContextValid(context) ? { context } : undefined;
}

/** What travels: an event, its id for deduplication, and where to route it. */
export interface BrokerMessage {
	readonly id: string;
	readonly type: string;
	readonly routingKey: string;
	readonly payload: unknown;
	readonly headers: Readonly<Record<string, string>> | null;
}

export interface BrokerPublisher {
	/** Resolves once the broker has confirmed it stored the message; rejects otherwise. */
	publish(message: BrokerMessage): Promise<void>;
	close(): Promise<void>;
}

/** Publishes to a durable topic exchange, declaring it first, and waits for each confirm. */
export function createBrokerPublisher(options: {
	broker: Broker;
	exchange: string;
	confirmTimeoutMs: number;
}): BrokerPublisher {
	const { exchange, confirmTimeoutMs } = options;
	const publisher = options.broker.connection.createPublisher({
		confirm: true,
		// The outbox retries with backoff; retrying here too would only stretch one attempt.
		maxAttempts: 1,
		exchanges: [{ exchange, type: 'topic', durable: true }],
	});

	return {
		publish: (message) =>
			traced(
				`publish ${message.type}`,
				{
					'messaging.system': 'rabbitmq',
					'messaging.destination.name': exchange,
					'messaging.message.id': message.id,
				},
				async (span) => {
					// The stored traceparent points at the request that wrote the event; it is kept as a
					// link, and the message carries this span so the consumer continues from the publish.
					const link = linkOf(message.headers?.['traceparent']);
					if (link) span.addLink(link);
					const headers: Record<string, string> = { ...message.headers };
					const traceparent = isSpanContextValid(span.spanContext())
						? currentTraceparent()
						: undefined;
					if (traceparent) headers['traceparent'] = traceparent;

					const sent = publisher.send(
						{
							exchange,
							routingKey: message.routingKey,
							messageId: message.id,
							type: message.type,
							contentType: 'application/json',
							durable: true,
							headers,
						},
						message.payload,
					);
					// A send waits through a reconnect; past the timeout this attempt counts as failed, and
					// the outbox schedules the next. A late confirm then only means a duplicate, which
					// consumers already tolerate.
					let timer: Timer | undefined;
					const timeout = new Promise<never>((_, reject) => {
						timer = setTimeout(
							() => reject(new Error(`no confirm from the broker within ${confirmTimeoutMs}ms`)),
							confirmTimeoutMs,
						);
					});
					try {
						await Promise.race([sent, timeout]);
					} finally {
						clearTimeout(timer);
					}
				},
				{ kind: SpanKind.PRODUCER },
			),
		close: () => publisher.close(),
	};
}
