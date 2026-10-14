import { and, eq, sql } from "drizzle-orm";
import type { EventDetail, EventSummary } from "@akashic/contracts";
import { eventRsvps, type Executor } from "@akashic/db";
import { RsvpStatus } from "@akashic/lib/enums";
import { fromDate } from "@akashic/lib/time";

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
export async function goingTally(
  tx: Executor,
  rsvp: { eventId: string; userId: string; status: RsvpStatus; capacity: number | null },
): Promise<{ going: number; already: boolean } | undefined> {
  if (rsvp.status !== RsvpStatus.going || rsvp.capacity === null) return undefined;
  const { eventId, userId } = rsvp;
  const [tally] = (await tx.execute(sql`
    SELECT
      (SELECT count(*)::int FROM event_rsvp
         WHERE event_id = ${eventId} AND status = ${RsvpStatus.going}) AS going,
      EXISTS (SELECT 1 FROM event_rsvp
         WHERE event_id = ${eventId} AND user_id = ${userId}
           AND status = ${RsvpStatus.going}) AS already
  `)) as unknown as { going: number; already: boolean }[];
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
