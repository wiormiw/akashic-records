import { sql } from "drizzle-orm";
import { index, pgTable, smallint, text } from "drizzle-orm/pg-core";
import { json, primaryId, utcTimestamp } from "./columns.ts";

/**
 * pending is claimable; dead needs a human. Stored numbers: 2 was "failed", now folded into
 * pending, so it is never reused.
 */
export const OutboxStatus = { pending: 0, published: 1, dead: 3 } as const;
export type OutboxStatus = (typeof OutboxStatus)[keyof typeof OutboxStatus];

export const outboxMessages = pgTable(
  "outbox_messages",
  {
    id: primaryId(),
    messageType: text("message_type").notNull(),
    // Where the broker routes it; the event type today, kept apart so the two can diverge.
    routingKey: text("routing_key").notNull(),
    payload: json("payload").notNull(),
    // Carries traceparent, so the handler's span joins the request that caused it.
    headers: json<Record<string, string>>("headers"),
    status: smallint("status").notNull().default(OutboxStatus.pending),
    attemptCount: smallint("attempt_count").notNull().default(0),
    createdAt: utcTimestamp("created_at").notNull().defaultNow(),
    // When a pending event is next due; while claimed, the end of the claim's lease.
    nextAttemptAt: utcTimestamp("next_attempt_at").notNull().defaultNow(),
    publishedAt: utcTimestamp("published_at"),
    lastError: text("last_error"),
  },
  (table) => [
    // Partial, and keyed to match the dispatcher's WHERE and ORDER BY.
    index("ix_outbox_messages_pending")
      .on(table.nextAttemptAt, table.id)
      .where(sql`status = 0`),
    // So the dead count reads a handful of index entries, not the table.
    index("ix_outbox_messages_dead")
      .on(table.id)
      .where(sql`status = 3`),
  ],
);
