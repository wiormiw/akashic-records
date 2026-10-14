import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import {
  OutboxStatus,
  outboxMessages,
  type Db,
  type Executor,
  type OutboxEvent,
} from "@akashic/db";
import { fromDate, toDate } from "@akashic/lib/time";
import { claimUntil, revive } from "./event.ts";

type Row = typeof outboxMessages.$inferSelect;

/** Where outbox events live between the transaction that wrote them and their delivery. */
export interface OutboxStore {
  /** Leases up to `limit` due pending events until `deadline`; no other claim sees them meanwhile. */
  claim(now: Temporal.Instant, deadline: Temporal.Instant, limit: number): Promise<OutboxEvent[]>;
  /**
   * Writes an event's outcome if the claim that leased it until `deadline` still holds it.
   * False when the lease ran out and another worker claimed it: that worker's outcome wins.
   */
  finish(next: OutboxEvent, deadline: Temporal.Instant): Promise<boolean>;
  /**
   * Deletes published events older than `before`, oldest first, at most `limit` so one call is
   * bounded. Pending and dead events are never touched. Returns how many went.
   */
  prune(before: Temporal.Instant, limit: number): Promise<number>;
}

/** For a person, not the dispatcher: what gave up, and putting it back in line. */
export interface OutboxRecovery {
  /** Dead events, oldest first. */
  dead(limit: number): Promise<OutboxEvent[]>;
  /** Revives up to `limit` dead events, oldest first, and returns them as revived. */
  reviveDead(now: Temporal.Instant, limit: number): Promise<OutboxEvent[]>;
}

export function createOutboxStore(db: Db): OutboxStore & OutboxRecovery {
  const deadRows = (executor: Executor, limit: number) =>
    executor
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.status, OutboxStatus.dead))
      .orderBy(asc(outboxMessages.createdAt), asc(outboxMessages.id))
      .limit(limit);

  return {
    dead: async (limit) => (await deadRows(db, limit)).map(fromRow),

    reviveDead: (now, limit) =>
      db.transaction(async (tx) => {
        const revived = (await deadRows(tx, limit).for("update")).map((row) =>
          revive(fromRow(row), now),
        );
        for (const event of revived) {
          const { status, attemptCount, nextAttemptAt } = changedColumns(event);
          await tx
            .update(outboxMessages)
            .set({ status, attemptCount, nextAttemptAt })
            .where(
              and(eq(outboxMessages.id, event.id), eq(outboxMessages.status, OutboxStatus.dead)),
            );
        }
        return revived;
      }),

    claim: (now, deadline, limit) =>
      db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(outboxMessages)
          .where(
            and(
              eq(outboxMessages.status, OutboxStatus.pending),
              lte(outboxMessages.nextAttemptAt, toDate(now)),
            ),
          )
          .orderBy(asc(outboxMessages.nextAttemptAt), asc(outboxMessages.id))
          .limit(limit)
          .for("update", { skipLocked: true });
        if (rows.length === 0) return [];

        const claimed = rows.map((row) => claimUntil(fromRow(row), deadline));
        await tx
          .update(outboxMessages)
          .set({ nextAttemptAt: toDate(deadline) })
          .where(
            inArray(
              outboxMessages.id,
              claimed.map((event) => event.id),
            ),
          );
        return claimed;
      }),

    async finish(next, deadline) {
      const columns = changedColumns(next);
      const written = await db
        .update(outboxMessages)
        .set(columns)
        // isClaimedUntil, checked in the same statement that writes, so nothing slips between.
        .where(
          and(
            eq(outboxMessages.id, next.id),
            eq(outboxMessages.status, OutboxStatus.pending),
            eq(outboxMessages.nextAttemptAt, toDate(deadline)),
          ),
        )
        .returning({ id: outboxMessages.id });
      return written.length > 0;
    },

    async prune(before, limit) {
      const old = db
        .select({ id: outboxMessages.id })
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.status, OutboxStatus.published),
            lt(outboxMessages.publishedAt, toDate(before)),
          ),
        )
        .orderBy(asc(outboxMessages.publishedAt), asc(outboxMessages.id))
        .limit(limit);
      // The status is repeated on the delete so a row revived meanwhile is never removed.
      const deleted = await db
        .delete(outboxMessages)
        .where(
          and(inArray(outboxMessages.id, old), eq(outboxMessages.status, OutboxStatus.published)),
        )
        .returning({ id: outboxMessages.id });
      return deleted.length;
    },
  };
}

/** The columns an event's transitions change; the rest is written once, by `publish`. */
function changedColumns(event: OutboxEvent) {
  return {
    status: event.status,
    attemptCount: event.attemptCount,
    nextAttemptAt: toDate(event.nextAttemptAt),
    publishedAt: event.publishedAt && toDate(event.publishedAt),
    lastError: event.lastError,
  };
}

function fromRow(row: Row): OutboxEvent {
  return {
    id: row.id,
    eventType: row.messageType,
    routingKey: row.routingKey,
    payload: row.payload,
    headers: row.headers,
    status: row.status as OutboxStatus,
    attemptCount: row.attemptCount,
    nextAttemptAt: fromDate(row.nextAttemptAt),
    createdAt: fromDate(row.createdAt),
    publishedAt: row.publishedAt && fromDate(row.publishedAt),
    lastError: row.lastError,
  };
}
