import { createMiddleware } from 'hono/factory';
import { FgaType, PLATFORM_ID, Relation, type Authorizer } from '@akashic/authz';
import type { Db } from '@akashic/db';
import { ErrorCode, fail } from '@akashic/lib/errors';
import type { Auth } from '@/auth/auth.ts';
import { banMessage, banOf } from '@/auth/bans.ts';
import type { AppEnv, Caller } from './env.ts';

/**
 * `session` requires a signed-in caller, `maybeSession` allows visitors (`user: null`), and
 * `platformAdmin` requires platform authority. Bans are checked on every request.
 */
export function sessions(options: { auth: Auth; db: Db; authorizer: Authorizer }) {
	async function identify(headers: Headers, signal: AbortSignal): Promise<Caller> {
		const session = await options.auth.api.getSession({ headers });
		if (!session)
			throw fail.unauthorized(ErrorCode.auth.unauthenticated, 'Sign in to access this resource.');

		const ban = await banOf(options.db, session.user.id, { signal });
		if (ban) throw fail.forbidden(ErrorCode.auth.banned, banMessage(ban));

		return { id: session.user.id, email: session.user.email };
	}

	const session = createMiddleware<AppEnv>(async (c, next) => {
		c.set('user', await identify(c.req.raw.headers, c.get('signal')));
		await next();
	});

	const maybeSession = createMiddleware<AppEnv>(async (c, next) => {
		c.set('user', await identify(c.req.raw.headers, c.get('signal')).catch(() => null));
		await next();
	});

	/** Whether `userId` holds platform authority; routes that rank it above realm roles ask this. */
	const isPlatformAdmin = (userId: string, signal: AbortSignal): Promise<boolean> =>
		options.authorizer.check(
			{
				userId,
				relation: Relation.platform.administer,
				type: FgaType.platform,
				objectId: PLATFORM_ID,
			},
			signal,
		);

	// A 404 rather than a 403, so the admin surface doesn't announce itself.
	const platformAdmin = createMiddleware<AppEnv>(async (c, next) => {
		const signal = c.get('signal');
		// Behind `session` the caller is already identified and ban-checked: one lookup, not two.
		const user = c.get('user') ?? (await identify(c.req.raw.headers, signal));
		const allowed = await isPlatformAdmin(user.id, signal);
		// Word for word the router's own 404 (http/problem.ts), so the two can't be told apart.
		if (!allowed) {
			throw fail.notFound(ErrorCode.common.routeNotFound, `No route for ${c.req.path}.`);
		}
		c.set('user', user);
		await next();
	});

	return { session, maybeSession, platformAdmin, isPlatformAdmin };
}

export type Sessions = ReturnType<typeof sessions>;
