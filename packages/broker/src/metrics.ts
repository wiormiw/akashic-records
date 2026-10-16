import type { BatchObservableCallback } from '@opentelemetry/api';
import { sql } from 'drizzle-orm';
import type { Db } from '@akashic/db';
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
		const [row] = (await db.execute(sql`
        SELECT (SELECT count(*) FROM outbox_messages WHERE status = 0)::int AS pending,
               (SELECT count(*) FROM outbox_messages WHERE status = 3)::int AS dead`)) as unknown as {
			pending: number;
			dead: number;
		}[];
		result.observe(backlog, row?.pending ?? 0);
		result.observe(dead, row?.dead ?? 0);
	};
	meter().addBatchObservableCallback(callback, [backlog, dead]);
	// Disposing removes the callback, so a stopped container stops querying.
	return owned({}, () => meter().removeBatchObservableCallback(callback, [backlog, dead]));
}

const retries = () => meter().createCounter('akashic.consumer.retries');
const parked = () => meter().createCounter('akashic.consumer.parked');

/** Counted by the delivery handler when it sets a message aside. */
export const consumerMetrics = { retries, parked };
