import { sql } from "drizzle-orm";
import { type EventDetail, type EventSummary, realmEvents } from "@akashic/contracts";
import { eventRsvps, events, type Executor, inTransaction, publish } from "@akashic/db";
import type { RsvpStatus } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { type Clock, isBefore, toDate } from "@akashic/lib/time";
import { findEvent, goingTally, listEvents, removeRsvp } from "./events.queries.ts";
import { hasRoomFor } from "./events.rules.ts";

export interface NewEvent {
  realmId: string;
  authorId: string;
  title: string;
  description: string;
  startsAt: Temporal.Instant;
  endsAt?: Temporal.Instant | undefined;
  location?: string | undefined;
  imageUrl?: string | undefined;
  capacity?: number | undefined;
}

export interface EventsDeps {
  db: Executor;
  clock: Clock;
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

    async post(event: NewEvent): Promise<Result<{ id: string }>> {
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
    ): Promise<Result<{ status: RsvpStatus }>> {
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

    async withdraw(
      realmId: string,
      eventId: string,
      userId: string,
    ): Promise<Result<{ cleared: boolean }>> {
      if (!(await findEvent(db, realmId, eventId, userId))) return err(notFound());
      return ok({ cleared: await removeRsvp(db, eventId, userId) });
    },
  };
}

export type EventService = ReturnType<typeof createEventService>;
