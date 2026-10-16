// Temporal.Instant is the time type everywhere; Date appears only at the driver edge.

export interface Clock {
	now(): Temporal.Instant;
}

export const systemClock: Clock = { now: () => Temporal.Now.instant() };

/** A clock stopped at `iso`. For tests. */
export function fixedClock(iso: string): Clock {
	const instant = Temporal.Instant.from(iso);
	return { now: () => instant };
}

/** A clock a test can move forward. */
export function mutableClock(iso: string): Clock & { advance(by: Temporal.DurationLike): void } {
	let instant = Temporal.Instant.from(iso);
	return {
		now: () => instant,
		advance(by) {
			instant = instant.add(by);
		},
	};
}

export const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

export const fromDate = (date: Date): Temporal.Instant =>
	Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** `a < b`. Instants have no `<`: it compares object references and is always false. */
export const isBefore = (a: Temporal.Instant, b: Temporal.Instant): boolean =>
	Temporal.Instant.compare(a, b) < 0;
