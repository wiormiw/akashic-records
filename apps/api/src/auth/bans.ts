import { eq } from 'drizzle-orm';
import { user, type Executor } from '@akashic/db';
import { first } from '@akashic/db/sql';
import { fromDate } from '@akashic/lib/time';

/** An account's current suspension. `until` null means until lifted by hand. */
export interface Ban {
	reason: string;
	until: Date | null;
}

/** How a suspension is described to the person it applies to. */
export const banMessage = (ban: Ban): string =>
	ban.until
		? `This account is suspended until ${ban.until.toISOString()}. ${ban.reason}`
		: `This account is suspended. ${ban.reason}`;

/** The suspension columns of one account row. */
export interface BanColumns {
	bannedAt: Date | null;
	reason: string | null;
	until: Date | null;
}

/** The ban a stored row describes at `now`. Apart from the query so it is tested without one. */
export function banFrom(row: BanColumns | undefined, now: Temporal.Instant): Ban | undefined {
	if (!row?.bannedAt) return undefined;
	if (row.until && Temporal.Instant.compare(fromDate(row.until), now) <= 0) return undefined;
	return { reason: row.reason ?? 'No reason was recorded.', until: row.until };
}

/** The suspension in force at `now`, if any. Expiry is judged on read, so no job lifts bans. */
export async function banOf(
	db: Executor,
	userId: string,
	{ now = Temporal.Now.instant(), signal }: { now?: Temporal.Instant; signal?: AbortSignal } = {},
): Promise<Ban | undefined> {
	signal?.throwIfAborted();
	const row = first(
		await db
			.select({ bannedAt: user.bannedAt, reason: user.banReason, until: user.bannedUntil })
			.from(user)
			.where(eq(user.id, userId)),
	);
	return banFrom(row, now);
}
