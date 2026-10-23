import { and, asc, eq, inArray, lt, lte, type AnyColumn, type SQL } from 'drizzle-orm';
import {
	OutboxStatus,
	outboxMessages,
	type Db,
	type Executor,
	type OutboxEvent,
} from '@akashic/db';
import { first } from '@akashic/db/sql';
import { fromDate, toDate } from '@akashic/lib/time';
import { claimUntil, revive } from './event.ts';

// The mail event's type (`MAIL_REQUESTED` in @akashic/contracts). Stored in rows: never rename it.
// The broker doesn't depend on contracts, so it is spelled out here.
export const MAIL_TOPIC = 'mail.requested';

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
	 * bounded. Dead mail events past the cutoff go too (their payloads hold addresses and tokens); pending and other dead events are never touched. Returns how many went.
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
				const revived = (await deadRows(tx, limit).for('update')).map((row) =>
					revive(fromRow(row), now),
				);
				const sample = first(revived);
				if (!sample) return revived;
				// Every revival writes the same three columns, so one statement; the rows are locked
				// above, so none has left `dead` since.
				const { status, attemptCount, nextAttemptAt } = changedColumns(sample);
				await tx
					.update(outboxMessages)
					.set({ status, attemptCount, nextAttemptAt })
					.where(
						and(
							inArray(
								outboxMessages.id,
								revived.map((event) => event.id),
							),
							eq(outboxMessages.status, OutboxStatus.dead),
						),
					);
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
					.for('update', { skipLocked: true });
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
			// The status is repeated on each delete so a row revived meanwhile is never removed.
			const published = await deleteOldest(
				db,
				and(
					eq(outboxMessages.status, OutboxStatus.published),
					lt(outboxMessages.publishedAt, toDate(before)),
				),
				OutboxStatus.published,
				outboxMessages.publishedAt,
				limit,
			);
			if (published >= limit) return published;
			// Mail carries addresses and tokens, so it doesn't wait in the dead letters; every other
			// dead event stays for `events:replay`.
			const deadMail = await deleteOldest(
				db,
				and(
					eq(outboxMessages.status, OutboxStatus.dead),
					eq(outboxMessages.messageType, MAIL_TOPIC),
					lt(outboxMessages.createdAt, toDate(before)),
				),
				OutboxStatus.dead,
				outboxMessages.createdAt,
				limit - published,
			);
			return published + deadMail;
		},
	};
}

/** Deletes the oldest `limit` rows matching `where`, re-checking `status` on the delete itself. */
async function deleteOldest(
	db: Db,
	where: SQL | undefined,
	status: number,
	orderBy: AnyColumn,
	limit: number,
) {
	const old = db
		.select({ id: outboxMessages.id })
		.from(outboxMessages)
		.where(where)
		.orderBy(asc(orderBy), asc(outboxMessages.id))
		.limit(limit);
	const deleted = await db
		.delete(outboxMessages)
		.where(and(inArray(outboxMessages.id, old), eq(outboxMessages.status, status)))
		.returning({ id: outboxMessages.id });
	return deleted.length;
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
