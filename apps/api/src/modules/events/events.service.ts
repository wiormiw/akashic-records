import { and, asc, eq, gte, sql } from 'drizzle-orm';
import type { EventDetail, EventSummary } from '@akashic/contracts';
import { realmEvents } from '@akashic/contracts/events';
import { eventRsvps, events, type Executor, inTransaction, publish, user } from '@akashic/db';
import { first, one } from '@akashic/db/sql';
import { RsvpStatus } from '@akashic/lib/enums';
import { EventFull, EventInPast, EventNotFound } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, isBefore, toDate } from '@akashic/lib/time';
import type {
	EventsDeps,
	GoingTallyRow,
	NewEvent,
	PostEventError,
	PostedEvent,
	ReadEventError,
	RsvpAnswer,
	RsvpError,
	RsvpRequest,
	Withdrawal,
	WithdrawError,
} from './events.types.ts';

// ---- Queries ------------------------------------------------------------

/** The columns every event listing shows; the count comes from a subquery per event. */
const summaryColumns = (db: Executor) => ({
	id: events.id,
	title: events.title,
	startsAt: events.startsAt,
	capacity: events.capacity,
	imageUrl: events.imageUrl,
	going: db.$count(
		eventRsvps,
		and(eq(eventRsvps.eventId, events.id), eq(eventRsvps.status, RsvpStatus.going)),
	),
});

const summaryOf = (row: {
	id: string;
	title: string;
	startsAt: Date;
	capacity: number | null;
	imageUrl: string | null;
	going: number;
}): EventSummary => ({
	id: row.id,
	title: row.title,
	startsAt: fromDate(row.startsAt),
	capacity: row.capacity,
	imageUrl: row.imageUrl,
	goingCount: row.going,
});

/** A realm's events soonest first, optionally only those still to come. */
export async function listEvents(
	db: Executor,
	realmId: string,
	upcomingOnly: boolean,
	limit: number,
): Promise<EventSummary[]> {
	const rows = await db
		.select(summaryColumns(db))
		.from(events)
		.where(
			and(eq(events.realmId, realmId), upcomingOnly ? gte(events.startsAt, sql`now()`) : undefined),
		)
		.orderBy(asc(events.startsAt))
		.limit(limit);
	return rows.map(summaryOf);
}

/** One event of the realm, with the viewer's own answer; undefined for another realm's event. */
export async function findEvent(
	db: Executor,
	realmId: string,
	eventId: string,
	viewerId: string,
): Promise<EventDetail | undefined> {
	const row = first(
		await db
			.select({
				...summaryColumns(db),
				description: events.description,
				endsAt: events.endsAt,
				location: events.location,
				authorId: events.authorId,
				authorName: user.name,
				commentsEnabled: events.commentsEnabled,
				// A scalar subquery, so a viewer with no answer reads null rather than dropping the row.
				yourRsvp: sql<number | null>`(${db
					.select({ status: eventRsvps.status })
					.from(eventRsvps)
					.where(and(eq(eventRsvps.eventId, events.id), eq(eventRsvps.userId, viewerId)))})`,
			})
			.from(events)
			.innerJoin(user, eq(user.id, events.authorId))
			.where(and(eq(events.id, eventId), eq(events.realmId, realmId))),
	);
	if (!row) return undefined;
	return {
		...summaryOf(row),
		description: row.description,
		endsAt: row.endsAt ? fromDate(row.endsAt) : null,
		location: row.location,
		authorId: row.authorId,
		authorName: row.authorName,
		commentsEnabled: row.commentsEnabled,
		yourRsvp: row.yourRsvp,
	};
}

/**
 * Who is going, and whether this person already is: only asked when the answer can matter, a
 * place in a capped event. Run while the event row is locked.
 */
export async function goingTally(
	tx: Executor,
	rsvp: RsvpRequest,
): Promise<GoingTallyRow | undefined> {
	if (rsvp.status !== RsvpStatus.going || rsvp.capacity === null) return undefined;
	const { eventId, userId } = rsvp;
	// Two scalar subqueries read together; the casts make the row match its type.
	return one(
		await tx.execute<GoingTallyRow>(sql`
    SELECT
      (SELECT count(*)::int FROM event_rsvp
         WHERE event_id = ${eventId} AND status = ${RsvpStatus.going}) AS going,
      EXISTS (SELECT 1 FROM event_rsvp
         WHERE event_id = ${eventId} AND user_id = ${userId}
           AND status = ${RsvpStatus.going}) AS already
  `),
		'going tally',
	);
}

/** Whether the event is one of this realm's: another realm's is indistinguishable from none. */
async function inRealm(db: Executor, realmId: string, eventId: string): Promise<boolean> {
	return (
		(
			await db
				.select({ one: sql`1` })
				.from(events)
				.where(and(eq(events.id, eventId), eq(events.realmId, realmId)))
				.limit(1)
		).length > 0
	);
}

/** Removes the person's answer; false when they had none. */
export async function removeRsvp(db: Executor, eventId: string, userId: string): Promise<boolean> {
	const removed = await db
		.delete(eventRsvps)
		.where(and(eq(eventRsvps.eventId, eventId), eq(eventRsvps.userId, userId)))
		.returning({ eventId: eventRsvps.eventId });
	return removed.length > 0;
}

// ---- Rules --------------------------------------------------------------

/**
 * Whether one more RSVP of `status` fits. Only "going" takes a place, someone already going keeps
 * theirs, and an event without a capacity never fills.
 */
export function hasRoomFor(
	status: RsvpStatus,
	capacity: number | null,
	tally: GoingTallyRow | undefined,
): boolean {
	if (status !== RsvpStatus.going || capacity === null || !tally) return true;
	return tally.already || tally.going < capacity;
}

const notFound = () => new EventNotFound('No such event in this realm.');

export function createEventService(deps: EventsDeps) {
	const { db, clock } = deps;

	return {
		browse: (realmId: string, upcomingOnly: boolean, limit: number): Promise<EventSummary[]> =>
			listEvents(db, realmId, upcomingOnly, limit),

		async read(
			realmId: string,
			eventId: string,
			viewerId: string,
		): Promise<Result<EventDetail, ReadEventError>> {
			const event = await findEvent(db, realmId, eventId, viewerId);
			return event ? ok(event) : err(notFound());
		},

		async post(event: NewEvent): Promise<Result<PostedEvent, PostEventError>> {
			const now = clock.now();
			if (isBefore(event.startsAt, now)) {
				return err(new EventInPast('An event cannot start in the past.'));
			}
			return inTransaction(db, async (tx) => {
				const created = one(
					await tx
						.insert(events)
						.values({
							...event,
							startsAt: toDate(event.startsAt),
							endsAt: event.endsAt && toDate(event.endsAt),
						})
						.returning({ id: events.id }),
					'event insert',
				);
				await publish(
					tx,
					[
						realmEvents.postingCreated('event', {
							postingId: created.id,
							realmId: event.realmId,
							authorId: event.authorId,
						}),
					],
					now,
				);
				return ok({ id: created.id });
			});
		},

		async respond(
			realmId: string,
			eventId: string,
			userId: string,
			status: RsvpStatus,
		): Promise<Result<RsvpAnswer, RsvpError>> {
			if (!(await inRealm(db, realmId, eventId))) return err(notFound());
			// Its own transaction (a savepoint inside a caller's), because the capacity check needs the
			// event row locked until the RSVP is written: two people can't take the last place.
			return inTransaction(db, async (tx) => {
				const event = first(
					await tx
						.select({ capacity: events.capacity })
						.from(events)
						.where(eq(events.id, eventId))
						.for('update'),
				);
				if (!event) return err(notFound());

				const { capacity } = event;
				const tally = await goingTally(tx, { eventId, userId, status, capacity });
				if (!hasRoomFor(status, capacity, tally)) {
					return err(new EventFull('This event is full.'));
				}

				// The injected clock for the first answer too, not the column default.
				const respondedAt = toDate(clock.now());
				await tx
					.insert(eventRsvps)
					.values({ eventId, userId, status, respondedAt })
					.onConflictDoUpdate({
						target: [eventRsvps.eventId, eventRsvps.userId],
						set: { status, respondedAt },
					});
				return ok({ status });
			});
		},

		async withdraw(
			realmId: string,
			eventId: string,
			userId: string,
		): Promise<Result<Withdrawal, WithdrawError>> {
			if (!(await inRealm(db, realmId, eventId))) return err(notFound());
			return ok({ cleared: await removeRsvp(db, eventId, userId) });
		},
	};
}
