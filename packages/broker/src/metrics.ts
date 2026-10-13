import { sql } from "drizzle-orm";
import type { Db } from "@akashic/db";
import { meter } from "@akashic/lib/metrics";

/**
 * Outbox backlog and dead count as observable gauges, read when the exporter collects. A growing
 * backlog means the broker is down or slow; any dead event needs a person.
 */
export function observeOutbox(db: Db) {
  const backlog = meter().createObservableGauge("akashic.outbox.pending", {
    description: "Outbox events waiting to be published",
  });
  const dead = meter().createObservableGauge("akashic.outbox.dead", {
    description: "Outbox events that gave up and need a person",
  });
  meter().addBatchObservableCallback(
    async (result) => {
      const [row] = (await db.execute(sql`
        SELECT count(*) FILTER (WHERE status = 0)::int AS pending,
               count(*) FILTER (WHERE status = 3)::int AS dead
        FROM outbox_messages`)) as unknown as { pending: number; dead: number }[];
      result.observe(backlog, row?.pending ?? 0);
      result.observe(dead, row?.dead ?? 0);
    },
    [backlog, dead],
  );
}

const retries = () => meter().createCounter("akashic.consumer.retries");
const parked = () => meter().createCounter("akashic.consumer.parked");

/** Counted by the delivery handler when it sets a message aside. */
export const consumerMetrics = { retries, parked };
