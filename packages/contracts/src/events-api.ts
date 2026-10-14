import * as v from "valibot";
import { narrow, RsvpStatus } from "@akashic/lib/enums";
import { iso, isoOrNull, ListLimit, oneOf, Timestamp, trimmedAsSent } from "./common.ts";

// The events API contract: what realm events and RSVPs accept and answer. (`events.ts` is the
// outbox's event catalogue, a different thing.)

export const CreateEventBody = v.object({
  title: trimmedAsSent({ minLength: 3, maxLength: 140 }),
  description: trimmedAsSent({ minLength: 1, maxLength: 4000 }),
  startsAt: Timestamp,
  endsAt: v.optional(Timestamp),
  location: v.optional(trimmedAsSent({ maxLength: 200 })),
  imageUrl: v.optional(v.pipe(v.string(), v.maxLength(500), v.url())),
  capacity: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100_000))),
});

export const ListEventsQuery = v.object({
  when: v.optional(v.picklist(["upcoming", "all"]), "upcoming"),
  limit: ListLimit,
});

export const RsvpBody = v.object({ status: oneOf(RsvpStatus) });

/** One event as the listing shows it. */
export interface EventSummary {
  id: string;
  title: string;
  startsAt: Temporal.Instant;
  capacity: number | null;
  imageUrl: string | null;
  goingCount: number;
}

export interface EventDetail extends EventSummary {
  description: string;
  endsAt: Temporal.Instant | null;
  location: string | null;
  authorId: string;
  authorName: string;
  commentsEnabled: boolean;
  /** The viewer's own RSVP, if any. */
  yourRsvp: number | null;
}

export const EventSummaryView = v.object({
  id: v.string(),
  title: v.string(),
  startsAt: Timestamp,
  capacity: v.nullable(v.number()),
  imageUrl: v.nullable(v.string()),
  goingCount: v.number(),
});

export const EventView = v.object({
  ...EventSummaryView.entries,
  description: v.string(),
  endsAt: v.nullable(Timestamp),
  location: v.nullable(v.string()),
  authorId: v.string(),
  authorName: v.string(),
  commentsEnabled: v.boolean(),
  /** The viewer's own RSVP, if any. */
  yourRsvp: v.nullable(oneOf(RsvpStatus)),
});

export const RsvpView = v.object({ status: oneOf(RsvpStatus) });
export const ClearedView = v.object({ cleared: v.boolean() });

export function presentEventSummary(event: EventSummary): v.InferInput<typeof EventSummaryView> {
  return {
    id: event.id,
    title: event.title,
    startsAt: iso(event.startsAt),
    capacity: event.capacity,
    imageUrl: event.imageUrl,
    goingCount: event.goingCount,
  };
}

export function presentEvent(event: EventDetail): v.InferInput<typeof EventView> {
  return {
    ...presentEventSummary(event),
    description: event.description,
    endsAt: isoOrNull(event.endsAt),
    location: event.location,
    authorId: event.authorId,
    authorName: event.authorName,
    commentsEnabled: event.commentsEnabled,
    yourRsvp: event.yourRsvp === null ? null : narrow(RsvpStatus, event.yourRsvp),
  };
}
