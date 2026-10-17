import { describe, expect, test } from 'bun:test';
import { getRecalls, getStandings, upvote } from './governance';

/**
 * The client's boundary behaviour, which is the part that decides what a broken API looks like.
 *
 * # What is worth testing in an API client
 *
 * Not that `fetch` was called with the right URL — that is the implementation restating itself.
 * What matters is the three answers a page can receive, because each one renders differently:
 *
 *   a parsed value      the page draws it
 *   null                the page shows an empty or a 404 state
 *   a thrown Error      the page shows the API's own wording
 *
 * The dangerous case is a fourth that must never happen: a response the schema does not match
 * being handed through anyway, so `undefined` reaches a component and surfaces as a blank cell or
 * a crash three files away from the cause.
 */

/** Replaces `fetch` for one call, restoring it afterwards however the test ends. */
async function withFetch<T>(
	stub: (url: string, init?: RequestInit) => Response | Promise<Response>,
	run: () => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;

	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		Promise.resolve(stub(String(input), init))) as typeof fetch;

	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

/** A JSON response, as the BFF would return one. */
const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});

const STANDINGS = {
	seats: 2,
	minimum: 3,
	members: [
		{
			userId: '01a09a8a-7a7b-710d-a168-b2a937d05f59',
			name: 'Alice',
			role: 2,
			upvotes: 4,
			seated: true,
			joinedAt: '2026-09-01T00:00:00.000Z',
		},
	],
};

describe('reading the standings', () => {
	test('a well-formed response is parsed', async () => {
		const result = await withFetch(
			() => json(STANDINGS),
			() => getStandings('weaboo', fetch),
		);

		expect(result?.seats).toBe(2);
		expect(result?.members[0]?.name).toBe('Alice');
	});

	test('a refusal is null, not an exception', async () => {
		// 404 is the ordinary answer for a realm that does not hold elections, and for a signed-in
		// non-member. The page turns null into its own 404; throwing here would make an expected
		// state look like a fault.
		const result = await withFetch(
			() => json({ detail: 'not found' }, 404),
			() => getStandings('weaboo', fetch),
		);

		expect(result).toBeNull();
	});

	test('a response missing a field is rejected rather than passed through', async () => {
		// The case this exists for. Without the schema, `seats` would be undefined and the page
		// would render "undefined seats" — a bug whose cause is three files from where it shows.
		const { seats: _omitted, ...missingSeats } = STANDINGS;

		const result = await withFetch(
			() => json(missingSeats),
			() => getStandings('weaboo', fetch),
		);

		expect(result).toBeNull();
	});

	test('a field of the wrong type is rejected', async () => {
		const wrongType = { ...STANDINGS, seats: 'two' };

		const result = await withFetch(
			() => json(wrongType),
			() => getStandings('weaboo', fetch),
		);

		expect(result).toBeNull();
	});

	test('a network failure is null, so a page renders rather than crashing', async () => {
		const result = await withFetch(
			() => {
				throw new Error('connection refused');
			},
			() => getStandings('weaboo', fetch),
		);

		expect(result).toBeNull();
	});

	test('an empty list is a list, not a refusal', async () => {
		// The difference matters: no recalls open renders a quiet page, where null renders a 404.
		const result = await withFetch(
			() => json([]),
			() => getRecalls('weaboo', fetch),
		);

		expect(result).toEqual([]);
	});
});

describe('writing', () => {
	test("a refusal throws with the API's own wording", async () => {
		// The API writes its messages to be read by a person. Repeating them beats anything a catch
		// block would invent.
		const detail = 'You cannot upvote yourself. A seat is something the realm gives you.';

		const failed = withFetch(
			() => json({ detail }, 400),
			() => upvote('weaboo', 'someone'),
		);

		expect(failed).rejects.toThrow(detail);
	});

	test('a refusal with no body still throws something readable', async () => {
		const failed = withFetch(
			() => new Response('', { status: 502 }),
			() => upvote('weaboo', 'someone'),
		);

		// A generic message, but one that names the status so a report is actionable.
		expect(failed).rejects.toThrow('502');
	});

	test('a success resolves with the payload', async () => {
		const result = await withFetch(
			() => json({ upvotes: 3, seats: 1, seated: [], unseated: [] }),
			() => upvote('weaboo', 'someone'),
		);

		expect(result).toEqual({ upvotes: 3, seats: 1, seated: [], unseated: [] });
	});
});
