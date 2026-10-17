import * as v from 'valibot';

/**
 * Realm self-government: the standings that decide moderator seats, and the votes that take them
 * away or remove a comment.
 *
 * Everything here goes through the BFF, because all of it needs the session cookie. The realm's
 * own permission checks decide who may do what; this module only shapes the requests.
 */

/** Which electorate votes on a recall, and therefore which threshold applies. */
export const RECALL_KIND = { members: 0, moderators: 1 } as const;

/** Where a vote sits. Shared by takedowns and recalls. */
export const VOTE_STATUS = { open: 0, carried: 1, refused: 2 } as const;

/** One member's position in the standings. */
export const Standing = v.object({
	userId: v.string(),
	name: v.string(),
	/** Their rank: 0 member, 1 verified, 2 moderator, 3 admin. */
	role: v.number(),
	upvotes: v.number(),
	/** Whether they currently hold one of the elected seats. */
	seated: v.boolean(),
	joinedAt: v.string(),
});
export type Standing = v.InferOutput<typeof Standing>;

/** The standings, plus what it takes to hold a seat. */
export const Standings = v.object({
	/** How many seats the realm has, from its member count. */
	seats: v.number(),
	/** Upvotes needed to hold one at all. */
	minimum: v.number(),
	members: v.array(Standing),
});
export type Standings = v.InferOutput<typeof Standings>;

/** A move to take a moderator's seat away. */
export const Recall = v.object({
	id: v.string(),
	realmId: v.string(),
	subject: v.nullable(v.object({ id: v.string(), name: v.string() })),
	kind: v.number(),
	reason: v.string(),
	proposedBy: v.nullable(v.object({ id: v.string(), name: v.string() })),
	status: v.number(),
	agrees: v.number(),
	refusals: v.number(),
	createdAt: v.string(),
});
export type Recall = v.InferOutput<typeof Recall>;

/** A proposal to remove a comment. */
export const Takedown = v.object({
	id: v.string(),
	realmId: v.string(),
	subjectKind: v.number(),
	subjectId: v.string(),
	reason: v.string(),
	proposedBy: v.nullable(v.object({ id: v.string(), name: v.string() })),
	status: v.number(),
	agrees: v.number(),
	refusals: v.number(),
	needed: v.number(),
	createdAt: v.string(),
});
export type Takedown = v.InferOutput<typeof Takedown>;

/** Reads one realm endpoint, or null when the caller may not see it. */
async function read<T extends v.GenericSchema>(
	path: string,
	schema: T,
	doFetch: typeof globalThis.fetch,
): Promise<v.InferOutput<T> | null> {
	try {
		const response = await doFetch(`/bff/api/v1/realms${path}`, {
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
 * Sends one request, surfacing the API's own wording on refusal.
 *
 * The API's messages are written to be read by a person -- "You cannot upvote yourself. A seat is
 * something the realm gives you." -- so repeating them beats inventing a generic failure string.
 */
async function write(path: string, method: string, body?: unknown): Promise<unknown> {
	const response = await fetch(`/bff/api/v1/realms${path}`, {
		method,
		headers: body
			? { 'content-type': 'application/json', accept: 'application/json' }
			: { accept: 'application/json' },
		body: body ? JSON.stringify(body) : undefined,
	});

	const payload = await response.json().catch(() => null);

	if (!response.ok) {
		throw new Error(payload?.detail ?? `That did not work (${response.status}).`);
	}

	return payload;
}

/** The standings for one realm. Null when the realm does not run elections, or on any refusal. */
export const getStandings = (
	slug: string,
	doFetch: typeof globalThis.fetch,
): Promise<Standings | null> => read(`/${slug}/standings`, Standings, doFetch);

/** Recalls waiting on a vote. */
export const getRecalls = (
	slug: string,
	doFetch: typeof globalThis.fetch,
): Promise<Recall[] | null> => read(`/${slug}/recalls`, v.array(Recall), doFetch);

/** Takedowns waiting on a vote. Moderators only; null for everybody else. */
export const getTakedowns = (
	slug: string,
	doFetch: typeof globalThis.fetch,
): Promise<Takedown[] | null> => read(`/${slug}/takedowns`, v.array(Takedown), doFetch);

/** Upvotes a member toward a seat. */
export const upvote = (slug: string, userId: string): Promise<unknown> =>
	write(`/${slug}/members/${userId}/upvote`, 'POST');

/** Takes an upvote back. */
export const withdrawUpvote = (slug: string, userId: string): Promise<unknown> =>
	write(`/${slug}/members/${userId}/upvote`, 'DELETE');

/** Moves to take a moderator's seat away. */
export const proposeRecall = (
	slug: string,
	userId: string,
	kind: number,
	reason: string,
): Promise<unknown> => write(`/${slug}/recalls`, 'POST', { userId, kind, reason });

/** Votes on a recall. */
export const voteOnRecall = (slug: string, id: string, agree: boolean): Promise<unknown> =>
	write(`/${slug}/recalls/${id}/vote`, 'POST', { agree });

/** Votes on a takedown. */
export const voteOnTakedown = (slug: string, id: string, agree: boolean): Promise<unknown> =>
	write(`/${slug}/takedowns/${id}/vote`, 'POST', { agree });

/** Takes a seat away directly. An admin's power, needing no vote. */
export const removeSeat = (slug: string, userId: string, reason: string): Promise<unknown> =>
	write(`/${slug}/members/${userId}/seat`, 'DELETE', { reason });
