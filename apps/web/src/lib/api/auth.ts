import * as v from 'valibot';

/**
 * Sign-in, sign-up and sign-out, spoken through the BFF proxy so the session cookie belongs to
 * this origin.
 *
 * better-auth owns the endpoints; this file only names them and states what comes back.
 */

/** The signed-in reader, as the layout needs them. */
export const SessionUser = v.object({
	id: v.string(),
	email: v.string(),
	name: v.optional(v.nullable(v.string())),
	image: v.optional(v.nullable(v.string())),
	/** Sign-in is refused until this is true, so a session implies a verified address. */
	emailVerified: v.optional(v.boolean(), false),
	/** ISO-8601. Drives "member since" and the founding-member badge. */
	createdAt: v.optional(v.nullable(v.string())),
});
export type SessionUser = v.InferOutput<typeof SessionUser>;

/** Credentials, validated before a request is spent on them. */
export const Credentials = v.object({
	email: v.pipe(v.string(), v.trim(), v.email('That does not look like an email address.')),
	password: v.pipe(v.string(), v.minLength(8, 'Passwords are at least 8 characters.')),
});
export type Credentials = v.InferOutput<typeof Credentials>;

/** Sign-up also takes a display name. */
export const Registration = v.object({
	...Credentials.entries,
	name: v.pipe(v.string(), v.trim(), v.minLength(1, 'Tell us what to call you.')),
});
export type Registration = v.InferOutput<typeof Registration>;

/**
 * Posts to a better-auth endpoint through the proxy.
 *
 * @param path Endpoint under `/api/auth`, e.g. `sign-in/email`.
 * @param body JSON payload.
 * @returns Nothing on success — the useful result is the cookie the response set.
 * @throws {Error} With better-auth's own message, which is written for a reader ("Invalid email
 *   or password") rather than for a log.
 *
 * @example
 * await authPost('sign-in/email', { email, password });
 */
async function authPost(path: string, body: unknown): Promise<void> {
	const response = await fetch(`/bff/api/auth/${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (response.ok) return;

	const problem = (await response.json().catch(() => null)) as { message?: string } | null;
	throw new Error(problem?.message ?? 'That did not work. Try again.');
}

/**
 * Signs in with email and password.
 *
 * @param credentials Already-validated email and password.
 * @returns Nothing; the session cookie is set on this origin.
 * @throws {Error} When the credentials are refused.
 *
 * @example
 * await signIn({ email, password });
 * await goto('/realms');
 */
export const signIn = (credentials: Credentials): Promise<void> =>
	authPost('sign-in/email', credentials);

/**
 * Creates an account and signs in.
 *
 * @param registration Name, email and password.
 * @returns Nothing; better-auth signs the new account in unless verification is required.
 * @throws {Error} When the email is taken or the password is refused.
 *
 * @example
 * await signUp({ name, email, password });
 */
export const signUp = (registration: Registration): Promise<void> =>
	authPost('sign-up/email', registration);

/**
 * Ends the session on the server and clears the cookie.
 *
 * @returns Nothing.
 * @throws {Error} Only if the API is unreachable — an already-expired session still succeeds.
 *
 * @example
 * await signOut();
 * await invalidateAll();
 */
export const signOut = (): Promise<void> => authPost('sign-out', {});

/**
 * Sends the verification link again.
 *
 * The address is passed explicitly because an unverified user has no session to infer it from —
 * sign-in is what better-auth refuses until they are verified.
 *
 * @param email Where to send it.
 * @param callbackURL Where the link should land once the token is accepted.
 * @returns Nothing. Succeeds even for an unknown address, which is deliberate: answering
 *   differently would turn this into a way to test whether an email has an account.
 * @throws {Error} Only when the request itself fails.
 *
 * @example
 * await resendVerification(email);
 */
export const resendVerification = (email: string, callbackURL = '/verified'): Promise<void> =>
	authPost('send-verification-email', { email, callbackURL });
