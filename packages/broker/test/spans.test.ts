import { beforeEach, expect, test } from 'bun:test';
import { SpanKind } from '@opentelemetry/api';
import { createBrokerPublisher } from '@akashic/broker';
import { recordSpans } from '@akashic/lib/testing';

const recorder = recordSpans();
beforeEach(() => recorder.reset());

test('publishing is a producer span whose context travels in the message headers', async () => {
	const sent: Record<string, unknown>[] = [];
	const broker = {
		connection: {
			createPublisher: () => ({
				send: async (envelope: { headers?: Record<string, unknown> }) =>
					void sent.push(envelope.headers ?? {}),
				close: async () => {},
			}),
		},
	};
	const publisher = createBrokerPublisher({
		broker: broker as never,
		exchange: 'akashic.events',
		confirmTimeoutMs: 1000,
	});
	await publisher.publish({
		id: 'e1',
		type: 'realm.member_changed',
		routingKey: 'realm.member_changed',
		payload: {},
		headers: {},
	});
	const span = recorder.spans().find((s) => s.name === 'publish realm.member_changed');
	expect(span?.kind).toBe(SpanKind.PRODUCER);
	expect(String(sent[0]?.traceparent)).toContain(span?.spanContext().spanId ?? 'missing');
});

test("the stored traceparent is replaced by the publish span's and kept as a link", async () => {
	const sent: Record<string, unknown>[] = [];
	const broker = {
		connection: {
			createPublisher: () => ({
				send: async (envelope: { headers?: Record<string, unknown> }) =>
					void sent.push(envelope.headers ?? {}),
				close: async () => {},
			}),
		},
	};
	const publisher = createBrokerPublisher({
		broker: broker as never,
		exchange: 'akashic.events',
		confirmTimeoutMs: 1000,
	});
	const stored = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
	await publisher.publish({
		id: 'e2',
		type: 'realm.created',
		routingKey: 'realm.created',
		payload: {},
		headers: { traceparent: stored },
	});
	const span = recorder.spans().find((s) => s.name === 'publish realm.created');
	expect(span?.links[0]?.context.spanId).toBe('b'.repeat(16));
	expect(sent[0]?.traceparent).not.toBe(stored);
	expect(String(sent[0]?.traceparent)).toContain(span?.spanContext().spanId ?? 'missing');
});
