import { and, eq, sql } from "drizzle-orm";
import { type EventDetail, type EventSummary, realmEvents } from "@akashic/contracts";
import { eventRsvps, events, type Executor, inTransaction, publish } from "@akashic/db";
import { RsvpStatus } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { fromDate, isBefore, toDate } from "@akashic/lib/time";
import type {
  EventsDeps,
  GoingTally,
  NewEvent,
  PostedEvent,
  RsvpAnswer,
  RsvpRequest,
  Withdrawal,
} from "./events.types.ts";

// ---- Queries ------------------------------------------------------------

interface SummaryRow {
  id: string;
  title: string;
  starts_at: Date;
  capacity: number | null;
  image_url: string | null;
  going: number;
}

interface DetailRow extends SummaryRow {
  description: string;
  ends_at: Date | null;
  location: string | null;
  author_id: string;
  author_name: string;
  comments_enabled: boolean;
  your_rsvp: number | null;
}

const summaryOf = (row: SummaryRow): EventSummary => ({
  id: row.id,
  title: row.title,
  startsAt: fromDate(new Date(row.starts_at)),
  capacity: row.capacity,
  imageUrl: row.image_url,
  goingCount: Number(row.going),
});

/** A realm's events soonest first, optionally only those still to come. */
export async function listEvents(
  db: Executor,
  realmId: string,
  upcomingOnly: boolean,
  limit: number,
): Promise<EventSummary[]> {
  const rows = (await db.execute(sql`
    SELECT e.id, e.title, e.starts_at, e.capacity, e.image_url,
      (SELECT count(*)::int FROM event_rsvp r
         WHERE r.event_id = e.id AND r.status = ${RsvpStatus.going}) AS going
    FROM event e
    WHERE e.realm_id = ${realmId} ${upcomingOnly ? sql`AND e.starts_at >= now()` : sql``}
    ORDER BY e.starts_at ASC
    LIMIT ${limit}
  `)) as unknown as SummaryRow[];
  return rows.map(summaryOf);
}

/** One event of the realm, with the viewer's own answer; undefined for another realm's event. */
export async function findEvent(
  db: Executor,
  realmId: string,
  eventId: string,
  viewerId: string,
): Promise<EventDetail | undefined> {
  const [row] = (await db.execute(sql`
    SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.location, e.capacity,
      e.image_url, e.author_id, u.name AS author_name, e.comments_enabled,
      (SELECT count(*)::int FROM event_rsvp r
         WHERE r.event_id = e.id AND r.status = ${RsvpStatus.going}) AS going,
      (SELECT r.status FROM event_rsvp r
         WHERE r.event_id = e.id AND r.user_id = ${viewerId}) AS your_rsvp
    FROM event e
    JOIN "user" u ON u.id = e.author_id
    WHERE e.id = ${eventId} AND e.realm_id = ${realmId}
    LIMIT 1
  `)) as unknown as DetailRow[];
  if (!row) return undefined;
  return {
    ...summaryOf(row),
    description: row.description,
    endsAt: row.ends_at ? fromDate(new Date(row.ends_at)) : null,
    location: row.location,
    authorId: row.author_id,
    authorName: row.author_name,
    commentsEnabled: row.comments_enabled,
    yourRsvp: row.your_rsvp,
  };
}

/**
 * Who is going, and whether this person already is: only asked when the answer can matter, a
 * place in a capped event. Run while the event row is locked.
 */
export async function goingTally(tx: Executor, rsvp: RsvpRequest): Promise<GoingTally | undefined> {
  if (rsvp.status !== RsvpStatus.going || rsvp.capacity === null) return undefined;
  const { eventId, userId } = rsvp;
  const [tally] = (await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM event_rsvp
         WHERE event_id = ${eventId} AND status = ${RsvpStatus.going}) AS going,
      EXISTS (SELECT 1 FROM event_rsvp
         WHERE event_id = ${eventId} AND user_id = ${userId}
           AND status = ${RsvpStatus.going}) AS already
  `)) as unknown as GoingTally[];
  return tally;
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
  tally: GoingTally | undefined,
): boolean {
  if (status !== RsvpStatus.going || capacity === null || !tally) return true;
  return tally.already || Number(tally.going) < capacity;
}

const notFound = () => fail.notFound(ErrorCode.event.notFound, "No such event in this realm.");

export function createEventService(deps: EventsDeps) {
  const { db, clock } = deps;

  return {
    browse: (realmId: string, upcomingOnly: boolean, limit: number): Promise<EventSummary[]> =>
      listEvents(db, realmId, upcomingOnly, limit),

    async read(realmId: string, eventId: string, viewerId: string): Promise<Result<EventDetail>> {
      const event = await findEvent(db, realmId, eventId, viewerId);
      return event ? ok(event) : err(notFound());
    },

    async post(event: NewEvent): Promise<Result<PostedEvent>> {
      const now = clock.now();
      if (isBefore(event.startsAt, now)) {
        return err(fail.validation(ErrorCode.event.past, "An event cannot start in the past."));
      }
      return inTransaction(db, async (tx) => {
        const [created] = await tx
          .insert(events)
          .values({
            ...event,
            startsAt: toDate(event.startsAt),
            endsAt: event.endsAt && toDate(event.endsAt),
          })
          .returning({ id: events.id });
        if (!created) throw new Error("event insert returned no row");
        await publish(
          tx,
          [
            realmEvents.postingCreated("event", {
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
    ): Promise<Result<RsvpAnswer>> {
      if (!(await findEvent(db, realmId, eventId, userId))) return err(notFound());
      // Its own transaction (a savepoint inside a caller's), because the capacity check needs the
      // event row locked until the RSVP is written: two people can't take the last place.
      return inTransaction(db, async (tx) => {
        const [event] = (await tx.execute(
          sql`SELECT capacity FROM event WHERE id = ${eventId} FOR UPDATE`,
        )) as unknown as { capacity: number | null }[];
        if (!event) return err(notFound());

        const { capacity } = event;
        const tally = await goingTally(tx, { eventId, userId, status, capacity });
        if (!hasRoomFor(status, capacity, tally)) {
          return err(fail.conflict(ErrorCode.event.full, "This event is full."));
        }

        await tx
          .insert(eventRsvps)
          .values({ eventId, userId, status })
          .onConflictDoUpdate({
            target: [eventRsvps.eventId, eventRsvps.userId],
            set: { status, respondedAt: new Date() },
          });
        return ok({ status });
      });
    },

    async withdraw(realmId: string, eventId: string, userId: string): Promise<Result<Withdrawal>> {
      if (!(await findEvent(db, realmId, eventId, userId))) return err(notFound());
      return ok({ cleared: await removeRsvp(db, eventId, userId) });
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;
