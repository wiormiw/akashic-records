import * as v from 'valibot';
import { API_BASE } from '$lib/config';

/**
 * Realms: the communities, and what each one runs.
 *
 * The directory is public — someone deciding whether to join has to be able to see what exists
 * first — so this reads the API's public router rather than going through the BFF.
 */

/** Modules a realm can switch on. Values are the API's smallints. */
export const REALM_MODULE = { jobs: 0, events: 1, market: 2, election: 3 } as const;

/** Labels in the order a realm card lists them. */
export const MODULE_LABELS: Record<number, string> = {
	[REALM_MODULE.jobs]: 'Jobs',
	[REALM_MODULE.events]: 'Events',
	[REALM_MODULE.market]: 'Marketplace',
	[REALM_MODULE.election]: 'Elections',
};

/** A realm as the directory shows it. */
export const RealmSummary = v.object({
	id: v.string(),
	slug: v.string(),
	name: v.string(),
	description: v.nullable(v.string()),
	category: v.nullable(v.string()),
	memberCount: v.number(),
	modules: v.array(v.number()),
});
export type RealmSummary = v.InferOutput<typeof RealmSummary>;

/** One event, as the public listing shows it — enough to decide whether to open it. */
export const EventTeaser = v.object({
	id: v.string(),
	title: v.string(),
	startsAt: v.string(),
	capacity: v.nullable(v.number()),
	/** Banner, or null for an event that has none. */
	imageUrl: v.nullable(v.string()),
	goingCount: v.number(),
});
export type EventTeaser = v.InferOutput<typeof EventTeaser>;

/**
 * Lists the realms.
 *
 * @param options `fetch` to use during SSR.
 * @returns Realms, most populous first, or an empty list when the API is unreachable — the
 *   landing page is copy with data in it and must render either way.
 *
 * @example
 * const realms = await listRealms({ fetch });
 */
export async function listRealms(
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<RealmSummary[]> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`${API_BASE}/api/public/v1/realms`);
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(RealmSummary), await response.json());
		return parsed.success ? parsed.output : [];
	} catch {
		return [];
	}
}

/**
 * Lists a realm's upcoming events.
 *
 * Public by design: the listing is what makes a community discoverable. The detail behind each
 * one needs a session and a membership.
 *
 * @param slug The realm.
 * @param options `limit` and the `fetch` to use during SSR.
 * @returns Teasers, soonest first, or an empty list when the realm has no events or does not run
 *   the module at all.
 *
 * @example
 * const events = await listRealmEvents('weaboo', { fetch, limit: 3 });
 */
export async function listRealmEvents(
	slug: string,
	options: { limit?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<EventTeaser[]> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(
			`${API_BASE}/api/public/v1/realms/${slug}/events?limit=${options.limit ?? 3}`,
		);
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(EventTeaser), await response.json());
		return parsed.success ? parsed.output : [];
	} catch {
		return [];
	}
}

/** What the signed-in caller may do in a realm. `role` is null when they are not a member. */
export const Standing = v.object({
	role: v.nullable(v.number()),
	permissions: v.array(v.string()),
});
export type Standing = v.InferOutput<typeof Standing>;

/** One event in full, for a member. */
export const EventDetail = v.object({
	...EventTeaser.entries,
	description: v.string(),
	endsAt: v.nullable(v.string()),
	location: v.nullable(v.string()),
	authorId: v.string(),
	authorName: v.string(),
	commentsEnabled: v.boolean(),
	yourRsvp: v.nullable(v.number()),
});
export type EventDetail = v.InferOutput<typeof EventDetail>;

/** RSVP answers, in the order they are offered. */
export const RSVP = { going: 0, interested: 1, declined: 2 } as const;

/** Labels for the three answers. */
export const RSVP_LABELS: { value: number; label: string }[] = [
	{ value: RSVP.going, label: 'Going' },
	{ value: RSVP.interested, label: 'Interested' },
	{ value: RSVP.declined, label: 'Not going' },
];

/**
 * Reads one realm.
 *
 * @param slug The realm.
 * @param options `fetch` to use during SSR.
 * @returns The realm, or null when there is no such realm.
 *
 * @example
 * const realm = await getRealm('weaboo', { fetch });
 */
export async function getRealm(
	slug: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<RealmSummary | null> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`${API_BASE}/api/public/v1/realms/${slug}`);
		if (!response.ok) return null;

		const parsed = v.safeParse(RealmSummary, await response.json());
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}

/**
 * Reads what the signed-in caller may do in a realm.
 *
 * Asked of the API rather than derived from a role name here, so the page renders exactly the
 * controls the API will honour.
 *
 * @param slug The realm.
 * @param options `fetch` to use during SSR.
 * @returns Their standing, or a non-member standing when signed out or unreadable.
 *
 * @example
 * const { role, permissions } = await getStanding('weaboo', { fetch });
 */
export async function getStanding(
	slug: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<Standing> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const outsider: Standing = { role: null, permissions: [] };

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/me`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return outsider;

		const parsed = v.safeParse(Standing, await response.json());
		return parsed.success ? parsed.output : outsider;
	} catch {
		return outsider;
	}
}

/**
 * Joins or leaves a realm.
 *
 * @param slug The realm.
 * @param action Which way.
 * @returns Nothing.
 * @throws {Error} With the API's message — the sole admin is refused a departure, for one.
 *
 * @example
 * await membership('weaboo', 'join');
 */
export async function membership(slug: string, action: 'join' | 'leave'): Promise<void> {
	const response = await fetch(`/bff/api/v1/realms/${slug}/${action}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
		throw new Error(problem?.detail ?? `Could not ${action} this realm.`);
	}
}

/**
 * Reads one event in full. Requires a session and membership.
 *
 * @param slug The realm.
 * @param id The event.
 * @param options `fetch` to use during SSR.
 * @returns The event, or null when it does not exist, is in another realm, or the caller may not
 *   see it — all of which the page renders the same way, because they are the same to a reader.
 *
 * @example
 * const event = await getEvent('weaboo', id, { fetch });
 */
export async function getEvent(
	slug: string,
	id: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<EventDetail | null> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/events/${id}`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return null;

		const parsed = v.safeParse(EventDetail, await response.json());
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}

/**
 * Answers an event.
 *
 * @param slug The realm.
 * @param id The event.
 * @param status One of {@link RSVP}, or null to withdraw an answer entirely.
 * @returns Nothing.
 * @throws {Error} `This event is full.` when the last seat went to somebody else.
 *
 * @example
 * await rsvp('weaboo', id, RSVP.going);
 * await rsvp('weaboo', id, null); // changed my mind about answering at all
 */
export async function rsvp(slug: string, id: string, status: number | null): Promise<void> {
	// null is "ignore me" — different from declining, and it has to give the seat back.
	const response = await fetch(`/bff/api/v1/realms/${slug}/events/${id}/rsvp`, {
		method: status === null ? 'DELETE' : 'PUT',
		headers: { 'content-type': 'application/json' },
		...(status === null ? {} : { body: JSON.stringify({ status }) }),
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
		throw new Error(problem?.detail ?? 'Could not record that.');
	}
}

/** What kind of arrangement a job is. */
/** What a job's status is called. Filled and closed are both shut, for different reasons. */
export const JOB_STATUS_LABELS: Record<number, string> = {
	1: 'Closed',
	2: 'Filled',
};

export const JOB_TYPE_LABELS: Record<number, string> = {
	0: 'Commission',
	1: 'Freelance',
	2: 'Full-time',
};

/** Where a listing is in its life. */
export const LISTING_STATUS_LABELS: Record<number, string> = {
	0: 'Available',
	1: 'Sold',
	2: 'Removed',
};

/** One job as the public listing shows it. */
export const JobTeaser = v.object({
	id: v.string(),
	title: v.string(),
	type: v.number(),
	budgetCents: v.nullable(v.number()),
	currency: v.string(),
	status: v.number(),
	createdAt: v.string(),
});
export type JobTeaser = v.InferOutput<typeof JobTeaser>;

/** The full posting, for a member. */
export const JobDetail = v.object({
	...JobTeaser.entries,
	description: v.string(),
	authorId: v.string(),
	authorName: v.string(),
	commentsEnabled: v.boolean(),
	hiringFlow: v.nullable(v.string()),
	hiredUserId: v.nullable(v.string()),
	/** Whether the reader currently has their hand up for it. */
	viewerInterested: v.boolean(),
});
export type JobDetail = v.InferOutput<typeof JobDetail>;

/** One listing as the public marketplace shows it. */
export const ListingTeaser = v.object({
	id: v.string(),
	title: v.string(),
	priceCents: v.number(),
	currency: v.string(),
	status: v.number(),
	/** Picture of the thing, or null. */
	imageUrl: v.nullable(v.string()),
	createdAt: v.string(),
});
export type ListingTeaser = v.InferOutput<typeof ListingTeaser>;

/** The full listing, for a member. */
export const ListingDetail = v.object({
	...ListingTeaser.entries,
	description: v.string(),
	sellerId: v.string(),
	sellerName: v.string(),
	commentsEnabled: v.boolean(),
	buyerId: v.nullable(v.string()),
	/** Whether the reader currently has their hand up for it. */
	viewerInterested: v.boolean(),
});
export type ListingDetail = v.InferOutput<typeof ListingDetail>;

/** One comment. A removed one keeps its place and loses its body. */
export const Comment = v.object({
	id: v.string(),
	body: v.string(),
	authorId: v.string(),
	authorName: v.string(),
	authorImage: v.nullable(v.string()),
	removed: v.boolean(),
	createdAt: v.string(),
});
export type Comment = v.InferOutput<typeof Comment>;

/**
 * Renders money the way the API stores it.
 *
 * The API keeps the smallest currency unit as an integer, so the conversion happens once, here,
 * rather than in every component that shows a price.
 *
 * @param cents Amount in the smallest unit.
 * @param currency ISO 4217 code.
 * @returns A localised amount, e.g. `Rp 450.000`.
 *
 * @example
 * money(45000000, 'IDR'); // "Rp 450.000"
 */
export function money(cents: number, currency: string): string {
	try {
		return new Intl.NumberFormat(undefined, {
			style: 'currency',
			currency,
			maximumFractionDigits: 0,
		}).format(cents / 100);
	} catch {
		// An unknown currency code should not blank a price.
		return `${(cents / 100).toLocaleString()} ${currency}`;
	}
}

/**
 * Reads a realm's public postings for one module.
 *
 * @param slug The realm.
 * @param kind Which module.
 * @param options `limit` and the `fetch` to use during SSR.
 * @returns Teasers, or an empty list when the realm does not run that module.
 *
 * @example
 * const jobs = await listPostings('weaboo', 'jobs', { fetch });
 */
export async function listPostings<K extends 'jobs' | 'listings'>(
	slug: string,
	kind: K,
	options: { limit?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<(K extends 'jobs' ? JobTeaser : ListingTeaser)[]> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const schema = kind === 'jobs' ? JobTeaser : ListingTeaser;

	try {
		const response = await doFetch(
			`${API_BASE}/api/public/v1/realms/${slug}/${kind}?limit=${options.limit ?? 20}`,
		);
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(schema), await response.json());
		return parsed.success ? (parsed.output as never) : [];
	} catch {
		return [];
	}
}

/**
 * Reads one posting in full. Requires a session and membership.
 *
 * @param slug The realm.
 * @param kind Which module.
 * @param id The posting.
 * @param options `fetch` to use during SSR.
 * @returns The posting, or null when it does not exist or the caller may not see it — which the
 *   page renders identically, because to a non-member they are the same fact.
 *
 * @example
 * const job = await getPosting('weaboo', 'jobs', id, { fetch });
 */
export async function getPosting(
	slug: string,
	kind: 'jobs' | 'listings',
	id: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<JobDetail | ListingDetail | null> {
	const doFetch = options.fetch ?? globalThis.fetch;
	const schema = kind === 'jobs' ? JobDetail : ListingDetail;

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/${kind}/${id}`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return null;

		const parsed = v.safeParse(schema, await response.json());
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}

/**
 * Reads a thread.
 *
 * @param slug The realm.
 * @param kind Which module the subject belongs to.
 * @param id The subject.
 * @param options `fetch` to use during SSR.
 * @returns Comments oldest first, or an empty list when the thread cannot be read.
 *
 * @example
 * const thread = await listComments('weaboo', 'listings', id, { fetch });
 */
export async function listComments(
	slug: string,
	kind: 'events' | 'jobs' | 'listings',
	id: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<Comment[]> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/${kind}/${id}/comments`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(Comment), await response.json());
		return parsed.success ? parsed.output : [];
	} catch {
		return [];
	}
}

/**
 * Adds a comment.
 *
 * @param slug The realm.
 * @param kind Which module the subject belongs to.
 * @param id The subject.
 * @param body What to say.
 * @returns Nothing.
 * @throws {Error} When the thread is closed, or the subject is not in this realm.
 *
 * @example
 * await addComment('weaboo', 'listings', id, 'Still available?');
 */
export async function addComment(
	slug: string,
	kind: 'events' | 'jobs' | 'listings',
	id: string,
	body: string,
): Promise<void> {
	const response = await fetch(`/bff/api/v1/realms/${slug}/${kind}/${id}/comments`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ body }),
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
		throw new Error(problem?.detail ?? 'Could not post that.');
	}
}

/**
 * Sends one write to a realm.
 *
 * @param path Below `/bff/api/v1/realms/`.
 * @param body What to send.
 * @returns What the API answered, parsed as `{ id }` when it created something.
 * @throws {Error} With the API's own wording, which explains the refusal better than a status.
 *
 * @example
 * const { id } = await write(`${slug}/listings`, { title, description, priceCents });
 */
async function write(path: string, body: unknown): Promise<{ id: string }> {
	const response = await fetch(`/bff/api/v1/realms/${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	const answer = (await response.json().catch(() => null)) as {
		id?: string;
		detail?: string;
	} | null;

	if (!response.ok) throw new Error(answer?.detail ?? 'Could not post that.');
	return { id: answer?.id ?? '' };
}

/**
 * Posts a job.
 *
 * @param slug The realm.
 * @param body Title, description, and the terms.
 * @returns The new posting's id.
 *
 * @example
 * const { id } = await createJob('weaboo', { title, description, type: 0 });
 */
export async function createJob(
	slug: string,
	body: {
		title: string;
		description: string;
		type: number;
		budgetCents?: number;
		hiringFlow?: string;
	},
): Promise<{ id: string }> {
	return write(`${slug}/jobs`, body);
}

/**
 * Lists something for sale.
 *
 * @param slug The realm.
 * @param body Title, description and price.
 * @returns The new listing's id.
 *
 * @example
 * const { id } = await createListing('weaboo', { title, description, priceCents: 4500000 });
 */
export async function createListing(
	slug: string,
	body: { title: string; description: string; priceCents: number; imageUrl?: string },
): Promise<{ id: string }> {
	return write(`${slug}/listings`, body);
}

/**
 * Schedules an event.
 *
 * @param slug The realm.
 * @param body Title, description, when, and optionally where and how many.
 * @returns The new event's id.
 *
 * @example
 * const { id } = await createEvent('weaboo', { title, description, startsAt });
 */
export async function createEvent(
	slug: string,
	body: {
		title: string;
		description: string;
		startsAt: string;
		endsAt?: string;
		location?: string;
		capacity?: number;
		imageUrl?: string;
	},
): Promise<{ id: string }> {
	return write(`${slug}/events`, body);
}

/**
 * Records that a job was filled, or a listing sold.
 *
 * The API decides the race: the first caller to name a counterpart wins and every other open
 * interest is settled as declined. A second call is refused rather than silently overwriting.
 *
 * @param slug The realm.
 * @param kind Which module the posting belongs to.
 * @param id The posting.
 * @param withUserId Who was hired, or who bought it.
 * @throws {Error} When it was already settled, or the caller does not own the posting.
 *
 * @example
 * await settle('weaboo', 'listings', id, buyerId);
 */
export async function settle(
	slug: string,
	kind: 'jobs' | 'listings',
	id: string,
	withUserId: string,
): Promise<void> {
	const field = kind === 'jobs' ? 'userId' : 'buyerId';
	await write(`${slug}/${kind}/${id}/${kind === 'jobs' ? 'hire' : 'deal'}`, {
		[field]: withUserId,
	});
}

/** One person with their hand up for a posting. */
export const Interest = v.object({
	id: v.string(),
	userId: v.string(),
	userName: v.string(),
	note: v.nullable(v.string()),
	status: v.number(),
	createdAt: v.string(),
});
export type Interest = v.InferOutput<typeof Interest>;

/**
 * Reads who has their hand up.
 *
 * Only the poster and a moderator may ask; anyone else gets an empty list, which is the same
 * answer as nobody being interested and reveals no more than that.
 *
 * @param slug The realm.
 * @param kind Which module the posting belongs to.
 * @param id The posting.
 * @param options `fetch` to use during SSR.
 * @returns The open interests, oldest first.
 *
 * @example
 * const applicants = await listInterest('weaboo', 'jobs', id, { fetch });
 */
export async function listInterest(
	slug: string,
	kind: 'jobs' | 'listings',
	id: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<Interest[]> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/${kind}/${id}/interest`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(Interest), await response.json());
		return parsed.success ? parsed.output : [];
	} catch {
		return [];
	}
}

/**
 * Puts a hand up, or takes it down.
 *
 * Expressing interest is not the same act as opening a room: it is public to the poster, it is
 * what the Hire and Deal buttons choose from, and it can be withdrawn.
 *
 * @param slug The realm.
 * @param kind Which module the posting belongs to.
 * @param id The posting.
 * @param note Something to say with it, or null to withdraw.
 * @returns Nothing.
 * @throws {Error} With the API's wording — a closed posting takes no more applicants.
 *
 * @example
 * await setInterest('weaboo', 'jobs', id, 'Portfolio in my profile.');
 * await setInterest('weaboo', 'jobs', id, null);
 */
export async function setInterest(
	slug: string,
	kind: 'jobs' | 'listings',
	id: string,
	note: string | null,
): Promise<void> {
	const response = await fetch(`/bff/api/v1/realms/${slug}/${kind}/${id}/interest`, {
		method: note === null ? 'DELETE' : 'POST',
		headers: { 'content-type': 'application/json' },
		...(note === null ? {} : { body: JSON.stringify(note === '' ? {} : { note }) }),
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
		throw new Error(problem?.detail ?? 'Could not do that.');
	}
}

/** One member as the roster shows them. Never an email — a roster says who is here. */
export const Member = v.object({
	userId: v.string(),
	name: v.string(),
	/** What they chose to be called in this realm, if anything. */
	displayName: v.nullable(v.string()),
	image: v.nullable(v.string()),
	role: v.number(),
	joinedAt: v.string(),
});
export type Member = v.InferOutput<typeof Member>;

/** What each rank is called, in rank order. */
export const ROLE_LABELS: Record<number, string> = {
	0: 'Member',
	1: 'Verified',
	2: 'Moderator',
	3: 'Admin',
};

/**
 * Reads the member roster.
 *
 * @param slug The realm.
 * @param options `fetch` to use during SSR.
 * @returns Members, highest rank first, or an empty list for a non-member.
 *
 * @example
 * const members = await listMembers('weaboo', { fetch });
 */
export async function listMembers(
	slug: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<Member[]> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/members`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(Member), await response.json());
		return parsed.success ? parsed.output : [];
	} catch {
		return [];
	}
}

/**
 * Sends one moderation action.
 *
 * @param path Below `/bff/api/v1/realms/`.
 * @param method Which verb the endpoint takes.
 * @param body What to send, if anything.
 * @returns Nothing.
 * @throws {Error} With the API's wording — a moderator promoting somebody to admin is refused
 *   there, and the reason is worth showing verbatim.
 */
async function moderate(path: string, method: string, body?: unknown): Promise<void> {
	const response = await fetch(`/bff/api/v1/realms/${path}`, {
		method,
		headers: { 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

	if (!response.ok) {
		const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
		throw new Error(problem?.detail ?? 'Could not do that.');
	}
}

/**
 * Changes somebody's role.
 *
 * @param slug The realm.
 * @param userId Whose role.
 * @param role The new rank.
 * @returns Nothing.
 * @throws {Error} When the caller may not grant that rank, or is changing their own.
 *
 * @example
 * await setRole('weaboo', userId, 1);
 */
export async function setRole(slug: string, userId: string, role: number): Promise<void> {
	return moderate(`${slug}/members/${userId}`, 'PATCH', { role });
}

/**
 * Removes a comment.
 *
 * The comment keeps its place as a tombstone rather than vanishing: a thread that silently loses
 * a message reads as a bug to everyone who saw it.
 *
 * @param slug The realm.
 * @param id The comment.
 * @returns Nothing.
 *
 * @example
 * await removeComment('weaboo', commentId);
 */
export async function removeComment(slug: string, id: string): Promise<void> {
	return moderate(`${slug}/comments/${id}`, 'DELETE');
}

/**
 * Closes a posting, or takes it down.
 *
 * The poster may do this to their own; a moderator may do it to anyone's.
 *
 * @param slug The realm.
 * @param kind Which module the posting belongs to.
 * @param id The posting.
 * @param status The new status — closed for a job, removed for a listing.
 * @returns Nothing.
 *
 * @example
 * await setPostingStatus('weaboo', 'jobs', id, 1);
 */
export async function setPostingStatus(
	slug: string,
	kind: 'jobs' | 'listings',
	id: string,
	status: number,
): Promise<void> {
	return moderate(`${slug}/${kind}/${id}`, 'PATCH', { status });
}

/** One posting the automated fit check could not decide. */
export const Review = v.object({
	id: v.string(),
	subjectKind: v.number(),
	subjectId: v.string(),
	/** Cosine distance from the realm's centroid when it was queued. Lower is a better fit. */
	distance: v.number(),
	createdAt: v.string(),
});
export type Review = v.InferOutput<typeof Review>;

/**
 * Reads what is waiting for a moderator.
 *
 * @param slug The realm.
 * @param options `fetch` to use during SSR.
 * @returns Undecided entries, oldest first, or an empty list for anyone who may not moderate.
 *
 * @example
 * const waiting = await listReviews('weaboo', { fetch });
 */
export async function listReviews(
	slug: string,
	options: { fetch?: typeof globalThis.fetch } = {},
): Promise<Review[]> {
	const doFetch = options.fetch ?? globalThis.fetch;

	try {
		const response = await doFetch(`/bff/api/v1/realms/${slug}/review`, {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return [];

		const parsed = v.safeParse(v.array(Review), await response.json());
		return parsed.success ? parsed.output : [];
	} catch {
		return [];
	}
}

/**
 * Keeps or removes a queued posting.
 *
 * Keeping teaches the realm — its centroid moves toward what was kept — so this is the moderation
 * action that compounds rather than the one that only tidies.
 *
 * @param slug The realm.
 * @param entryId The queue entry.
 * @param kept Whether the posting stays.
 * @returns Nothing.
 * @throws {Error} When somebody else already decided it.
 *
 * @example
 * await decideReview('weaboo', entryId, true);
 */
export async function decideReview(slug: string, entryId: string, kept: boolean): Promise<void> {
	await moderate(`${slug}/review/${entryId}`, 'POST', { kept });
}

/**
 * Founds a realm.
 *
 * The founder becomes its admin, which is the only way an admin exists — there is no path that
 * grants the rank to somebody who did not either found the realm or get promoted by one.
 *
 * @param body Its slug, name, and the modules it starts with.
 * @returns The new realm's slug, which is what the URL uses.
 * @throws {Error} With the API's wording — a taken slug says so.
 *
 * @example
 * const { slug } = await createRealm({ slug: 'tcg', name: 'TCG Traders', modules: [0, 2] });
 */
export async function createRealm(body: {
	slug: string;
	name: string;
	description?: string;
	category?: string;
	modules: number[];
}): Promise<{ slug: string }> {
	const response = await fetch('/bff/api/v1/realms', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	const answer = (await response.json().catch(() => null)) as {
		slug?: string;
		detail?: string;
	} | null;

	if (!response.ok || !answer?.slug) {
		throw new Error(answer?.detail ?? 'Could not create that realm.');
	}

	return { slug: answer.slug };
}
