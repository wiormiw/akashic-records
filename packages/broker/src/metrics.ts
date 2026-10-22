import type { BatchObservableCallback } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import { type Db, OutboxStatus, outboxMessages } from '@akashic/db';
import { owned } from '@akashic/lib/lifecycle';
import { meter } from '@akashic/lib/metrics';

/**
 * Outbox backlog and dead count as observable gauges, read when the exporter collects. A growing
 * backlog means the broker is down or slow; any dead event needs a person.
 */
export function observeOutbox(db: Db) {
	const backlog = meter().createObservableGauge('akashic.outbox.pending', {
		description: 'Outbox events waiting to be published',
	});
	const dead = meter().createObservableGauge('akashic.outbox.dead', {
		description: 'Outbox events that gave up and need a person',
	});
	const callback: BatchObservableCallback = async (result) => {
		// Literal statuses, not parameters: the planner can only use a partial index whose predicate
		// it sees in the query text.
		const withStatus = (status: OutboxStatus) =>
			sql`${outboxMessages.status} = ${sql.raw(String(status))}`;
		const [pendingCount, deadCount] = await Promise.all([
			db.$count(outboxMessages, withStatus(OutboxStatus.pending)),
			db.$count(outboxMessages, withStatus(OutboxStatus.dead)),
		]);
		result.observe(backlog, pendingCount);
		result.observe(dead, deadCount);
	};
	meter().addBatchObservableCallback(callback, [backlog, dead]);
	// Disposing removes the callback, so a stopped container stops querying.
	return owned({}, () => meter().removeBatchObservableCallback(callback, [backlog, dead]));
}

const retries = () => meter().createCounter('akashic.consumer.retries');
const parked = () => meter().createCounter('akashic.consumer.parked');

/** Counted by the delivery handler when it sets a message aside. */
export const consumerMetrics = { retries, parked };
