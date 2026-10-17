import type { SessionUser } from '$lib/api/auth';

/**
 * How a profile is put together from what the API already knows.
 *
 * No profile table: the handle is derived from the user id and the badges from the session. A
 * stored badge would need a job to keep it true, and a badge that lies is worse than none.
 */

/** Where a badge comes from: the account, or (later) a role held in a realm. */
export type BadgeSource = 'account' | 'realm';

/** A badge, as rendered. `earned` false means it is shown greyed out as something to aim at. */
export interface Badge {
	slug: string;
	label: string;
	description: string;
	earned: boolean;
	source: BadgeSource;
	/** Set for `realm` badges: which realm granted it. */
	realm?: string;
	/** Which palette colour it uses. Verified is the only one that reads as an assurance. */
	tone: 'primary' | 'accent' | 'neutral';
}

/**
 * A stable four-digit discriminator, so two readers called "Kaz" are still distinguishable.
 *
 * Derived from the user id rather than stored: UUIDv7 is already unique and never changes, so
 * the tag needs no column, no uniqueness check and no migration.
 *
 * @param userId The user's UUID.
 * @returns Four digits, e.g. `"4213"`. Stable for the life of the account.
 *
 * @example
 * discriminator('01a04247-63a7-7467-9bfa-4109f4cc0ee0'); // "0ee0"
 */
export function discriminator(userId: string): string {
	const tail = userId.replaceAll('-', '').slice(-4);
	return tail || '0000';
}

/**
 * The display handle: a name and its discriminator.
 *
 * @param user The signed-in reader.
 * @returns Something like `Kaz#0ee0`, falling back to the email's local part when no name is set.
 *
 * @example
 * handle({ id, email: 'kaz@example.com', name: null }); // "kaz#0ee0"
 */
export function handle(user: SessionUser): string {
	const name = user.name?.trim() || user.email.split('@')[0] || 'reader';
	return `${name}#${discriminator(user.id)}`;
}

/**
 * Initials for the fallback avatar, when the account has no image.
 *
 * @param user The signed-in reader.
 * @returns One or two uppercase letters.
 *
 * @example
 * initials({ name: 'Wijoyo Raharjo', ... }); // "WR"
 */
export function initials(user: SessionUser): string {
	const source = user.name?.trim() || user.email;
	const parts = source.split(/[\s@._-]+/u).filter(Boolean);

	return (parts[0]?.[0] ?? '?').concat(parts[1]?.[0] ?? '').toUpperCase();
}

/** Every badge, earned or not, in display order. Realm roles will join these later. */
export function badgesFor(user: SessionUser): Badge[] {
	return [
		{
			slug: 'verified',
			label: 'Verified',
			description: 'Email address confirmed.',
			earned: user.emailVerified,
			source: 'account',
			tone: 'primary',
		},
	];
}

/**
 * "Member since March 2026", or nothing when the account has no creation date.
 *
 * @param createdAt ISO-8601 timestamp from the session.
 * @returns A month and year, or an empty string.
 *
 * @example
 * memberSince('2026-08-27T08:12:49.957Z'); // "August 2026"
 */
export function memberSince(createdAt: string | null | undefined): string {
	if (!createdAt) return '';

	const date = new Date(createdAt);
	if (Number.isNaN(date.getTime())) return '';

	return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
