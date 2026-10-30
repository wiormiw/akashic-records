import * as v from 'valibot';
import { SessionUser } from '#lib/api/auth.ts';
import { API_BASE } from '#lib/config.ts';
import type { Handle } from '@sveltejs/kit/hooks';

/**
 * Resolves the session once per request, so every page and layout can read `locals.user`.
 *
 * Asking the API rather than decoding the cookie here: the cookie is signed with a secret this
 * process does not have, and duplicating session logic is how the two drift apart.
 *
 * The distinction that matters is between *no session* and *could not check*. A 401 means signed
 * out. A timeout, a 429 or a 500 means the answer is unknown — and treating unknown as signed out
 * is what strands a reader on the sign-in page while their cookie is perfectly valid, unable even
 * to sign out. Guards read `sessionUnavailable` and say so instead of pretending.
 *
 * @example
 * // in a load function
 * if (!locals.user && locals.sessionUnavailable) error(503, 'Could not reach the account service.');
 */
export const handle: Handle = async ({ event, resolve }) => {
	const cookie = event.request.headers.get('cookie');

	if (!cookie) {
		event.locals.user = null;
		event.locals.sessionUnavailable = false;
		return resolve(event);
	}

	const resolved = await fetchUser(cookie);
	event.locals.user = resolved.user;
	event.locals.sessionUnavailable = resolved.unavailable;

	return resolve(event);
};

/** One resolved session check: who it is, and whether the answer is trustworthy. */
interface Resolution {
	user: App.Locals['user'];
	/** True when the check itself failed, so `user: null` means "unknown", not "signed out". */
	unavailable: boolean;
}

/**
 * A very short cache of session lookups, keyed by the cookie header.
 *
 * A server-rendered page checks the session on every request, including the ones the browser
 * fires while prefetching links — which is a lot of identical questions about an answer that
 * changes on the order of days. Two seconds removes the burst without letting a sign-out linger
 * anywhere a reader would notice.
 */
const cache = new Map<string, { at: number; resolution: Resolution }>();
const CACHE_MS = 2000;

/**
 * Asks better-auth who the cookie belongs to.
 *
 * @param cookie The incoming `Cookie` header, forwarded verbatim.
 * @returns The user, and whether the check succeeded at all.
 *
 * @example
 * const { user, unavailable } = await fetchUser('better-auth.session_token=...');
 */
async function fetchUser(cookie: string): Promise<Resolution> {
	const hit = cache.get(cookie);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.resolution;

	const resolution = await askApi(cookie);

	// Only a definite answer is worth caching; a failed check should be retried on the next
	// request rather than held onto.
	if (!resolution.unavailable) {
		// Bounded: this is a per-process map and sessions are long-lived, so it would otherwise
		// grow with every distinct cookie the node has ever seen.
		if (cache.size > 500) cache.clear();
		cache.set(cookie, { at: Date.now(), resolution });
	}

	return resolution;
}

/**
 * The actual call, with failures classified rather than flattened.
 *
 * @param cookie The incoming `Cookie` header.
 * @returns The resolution. A 401 or an unreadable body is "signed out"; anything else is
 *   "unknown", because the reader may well be signed in and the service simply did not answer.
 *
 * @example
 * await askApi(cookie); // { user: null, unavailable: true } when the API returns 429
 */
async function askApi(cookie: string): Promise<Resolution> {
	try {
		const response = await fetch(`${API_BASE}/api/auth/get-session`, {
			headers: { cookie, accept: 'application/json' },
			signal: AbortSignal.timeout(3000),
		});

		if (response.status === 401 || response.status === 403) {
			return { user: null, unavailable: false };
		}

		if (!response.ok) return { user: null, unavailable: true };

		const parsed = v.safeParse(v.object({ user: SessionUser }), await response.json());

		// better-auth answers 200 with a null body for a cookie that no longer resolves, which is
		// a definite "signed out" rather than a failure.
		return { user: parsed.success ? parsed.output.user : null, unavailable: false };
	} catch {
		return { user: null, unavailable: true };
	}
}
