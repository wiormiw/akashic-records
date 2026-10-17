import type { SessionUser } from '$lib/api/auth';

declare global {
	namespace App {
		interface Locals {
			/** The signed-in reader, resolved once per request in `hooks.server.ts`. */
			user: SessionUser | null;
			/**
			 * True when the session check failed rather than answering. A null `user` alongside this
			 * means "unknown", so a guard must not redirect to sign-in as though they were signed out.
			 */
			sessionUnavailable: boolean;
		}
	}
}

/** Present so `declare global` above is treated as a module augmentation rather than a script. */
export type AppLocals = App.Locals;
