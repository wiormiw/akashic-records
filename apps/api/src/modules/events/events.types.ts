import type { MiddlewareHandler } from 'hono';
import type { RealmEnv } from '@/http/realm-context.ts';
import type { createEventService } from './events.service.ts';
import type { Executor } from '@akashic/db';
import type { RsvpStatus } from '@akashic/lib/enums';
import type { EventFull, EventInPast, EventNotFound } from '@akashic/lib/errors';
import type { Clock } from '@akashic/lib/time';

export type EventService = ReturnType<typeof createEventService>;

export interface EventsDeps {
	db: Executor;
	clock: Clock;
}

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

/** A posted event's id. */
export interface PostedEvent {
	id: string;
}

/** What one person answers to an event, and the event's capacity as read under its lock. */
export interface RsvpRequest {
	eventId: string;
	userId: string;
	status: RsvpStatus;
	capacity: number | null;
}

/** How many are going, and whether the asker already is. */
export type GoingTally = {
	going: number;
	already: boolean;
};

/** The answer an RSVP recorded. */
export interface RsvpAnswer {
	status: RsvpStatus;
}

/** Whether a withdrawal removed an answer. */
export interface Withdrawal {
	cleared: boolean;
}

// What each event service call can fail with.
export type ReadEventError = EventNotFound;
export type PostEventError = EventInPast;
export type RsvpError = EventNotFound | EventFull;
export type WithdrawError = EventNotFound;

/** What the events routes are built from. */
export interface EventsRoutesDeps {
	events: EventService;
	realmContext: MiddlewareHandler<RealmEnv>;
}

/** What the events module is built from: just what its routes need. */
export type EventsModuleDeps = EventsRoutesDeps;
