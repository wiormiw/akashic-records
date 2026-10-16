import { OutboxStatus, type OutboxEvent } from '@akashic/db';

// The event type and its constructor live in @akashic/db; these are the transitions the store writes.

const MAX_ERROR_LENGTH = 500;

/** Leases a pending event until `deadline`, so no other worker claims it meanwhile. */
export function claimUntil(event: OutboxEvent, deadline: Temporal.Instant): OutboxEvent {
	if (event.status !== OutboxStatus.pending) {
		throw new Error(`only a pending outbox event can be claimed; ${event.id} is ${event.status}`);
	}
	return { ...event, nextAttemptAt: deadline };
}

/** Whether the claim that leased it until `deadline` still holds it. */
export const isClaimedUntil = (event: OutboxEvent, deadline: Temporal.Instant): boolean =>
	event.status === OutboxStatus.pending && event.nextAttemptAt.equals(deadline);

export const markPublished = (event: OutboxEvent, at: Temporal.Instant): OutboxEvent => ({
	...event,
	status: OutboxStatus.published,
	publishedAt: at,
	lastError: null,
});

/** Counts the failed attempt, and either schedules the next or gives up for good. */
export const recordFailure = (
	event: OutboxEvent,
	retryAt: Temporal.Instant,
	error: string | null | undefined,
	exhausted: boolean,
): OutboxEvent => ({
	...event,
	attemptCount: event.attemptCount + 1,
	status: exhausted ? OutboxStatus.dead : OutboxStatus.pending,
	nextAttemptAt: retryAt,
	lastError: abbreviate(error),
});

/**
 * Gives a dead event a full set of attempts again, once whatever killed it has been fixed. Its
 * last error stays, so what went wrong is still on the row until it is published.
 */
export function revive(event: OutboxEvent, now: Temporal.Instant): OutboxEvent {
	if (event.status !== OutboxStatus.dead) {
		throw new Error(`only a dead outbox event can be revived; ${event.id} is ${event.status}`);
	}
	return { ...event, status: OutboxStatus.pending, attemptCount: 0, nextAttemptAt: now };
}

function abbreviate(error: string | null | undefined): string {
	const message = error?.trim() ? error : 'Unknown publish failure';
	return message.slice(0, MAX_ERROR_LENGTH);
}
