import type { JsonValue } from "@akashic/lib/json";
import { toDate } from "@akashic/lib/time";
import { currentTraceparent } from "@akashic/lib/tracing";
import type { Tx } from "./client.ts";
import { OutboxStatus, outboxMessages } from "./schema/index.ts";

/** What a service publishes: a type and its data. */
export interface DomainEvent {
  type: string;
  payload: Record<string, JsonValue>;
}

/**
 * One row of the outbox and where it is in its life:
 * PENDING (due, or leased while claimed) -> PUBLISHED, or back to PENDING to retry, or DEAD.
 */
export interface OutboxEvent {
  readonly id: string;
  readonly eventType: string;
  /** Where the broker routes it. */
  readonly routingKey: string;
  readonly payload: unknown;
  readonly headers: Readonly<Record<string, string>> | null;
  readonly status: OutboxStatus;
  readonly attemptCount: number;
  /** When a pending event is next due; while claimed, the end of the claim's lease. */
  readonly nextAttemptAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly publishedAt: Temporal.Instant | null;
  readonly lastError: string | null;
}

export function newOutboxEvent(
  event: DomainEvent,
  now: Temporal.Instant,
  headers: Record<string, string> | null = null,
): OutboxEvent {
  return {
    id: Bun.randomUUIDv7(),
    eventType: event.type,
    routingKey: event.type,
    payload: event.payload,
    headers,
    status: OutboxStatus.pending,
    attemptCount: 0,
    nextAttemptAt: now,
    createdAt: now,
    publishedAt: null,
    lastError: null,
  };
}

function toRow(event: OutboxEvent): typeof outboxMessages.$inferInsert {
  return {
    id: event.id,
    messageType: event.eventType,
    routingKey: event.routingKey,
    payload: event.payload,
    headers: event.headers,
    status: event.status,
    attemptCount: event.attemptCount,
    createdAt: toDate(event.createdAt),
    nextAttemptAt: toDate(event.nextAttemptAt),
    publishedAt: event.publishedAt && toDate(event.publishedAt),
    lastError: event.lastError,
  };
}

/**
 * Writes events in the caller's transaction, so an event and the state change it describes
 * commit together or not at all. Pass the transaction, never the pool.
 */
export async function publish(
  tx: Tx,
  events: readonly DomainEvent[],
  now: Temporal.Instant,
): Promise<void> {
  if (events.length === 0) return;
  const traceparent = currentTraceparent();
  const headers = traceparent ? { traceparent } : null;
  await tx
    .insert(outboxMessages)
    .values(events.map((event) => toRow(newOutboxEvent(event, now, headers))));
}
