import { and, asc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { matchedRoutes } from 'hono/route';
import { FgaType, Relation, type Authorizer } from '@akashic/authz';
import { realmMembers, realmModules, realms, type Executor } from '@akashic/db';
import { narrow, RealmModule, RealmRole } from '@akashic/lib/enums';
import {
	ModuleDisabled,
	RealmArchived,
	RealmForbidden,
	RealmNotFound,
	RouteNotFound,
} from '@akashic/lib/errors';
import type { AppEnv } from './env.ts';

/** What the caller may do in the realm named by the path, answered by the authorizer. */
export interface RealmPermissions {
	post: boolean;
	postJob: boolean;
	postEvent: boolean;
	participate: boolean;
	moderate: boolean;
	vouch: boolean;
	administer: boolean;
}

/** The realm named by `:slug`, and where the caller stands in it. */
export interface RealmContext {
	realmId: string;
	realmSlug: string;
	realmRole: RealmRole | null;
	realmModules: RealmModule[];
	permissions: RealmPermissions;
}

/** What routes under `/realms/:slug` carry once `realmContext` has run. */
export interface RealmEnv extends AppEnv {
	Variables: AppEnv['Variables'] & { realm: RealmContext };
}

const CHECKS = Object.entries(Relation.realm) as [keyof RealmPermissions, string][];

const NOTHING: RealmPermissions = {
	post: false,
	postJob: false,
	postEvent: false,
	participate: false,
	moderate: false,
	vouch: false,
	administer: false,
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const FORBIDDEN = 'You are not allowed to do that here.';

/**
 * The pattern of the route that will answer, such as `/realms/:slug/jobs`. Applied per route, the
 * middleware's own entry is that route; `use`d on a prefix, its entry is the prefix's `*`, so the
 * next method route matched is the one.
 */
function handlerPattern(c: Context): string {
	const routes = matchedRoutes(c);
	const own = routes[c.req.routeIndex];
	const route =
		own && own.method !== 'ALL'
			? own
			: routes.slice(c.req.routeIndex).find((r) => r.method !== 'ALL');
	return route?.path ?? '';
}

/**
 * Resolves `/realms/:slug` to the realm, the caller's role in it, and their permissions. An
 * archived realm stays readable, and only its administrators may act (to restore it).
 */
export function realmContext(options: { db: Executor; authorizer: Authorizer }) {
	const { db, authorizer } = options;

	return createMiddleware<RealmEnv>(async (c, next) => {
		const slug = c.req.param('slug');
		if (!slug) throw new RouteNotFound('No realm in this path.');

		const realm = await findBySlug(db, slug);
		if (!realm) throw new RealmNotFound(`No realm called "${slug}".`);

		// The realm root stays writable so an administrator can restore it. Judged on the route's
		// pattern, not the path: `/realms/join/join` ends with its slug but is the join route.
		const atRoot = /\/:slug\/?$/.test(handlerPattern(c));
		if (realm.archivedAt && !SAFE_METHODS.has(c.req.method) && !atRoot) {
			throw new RealmArchived(
				`"${realm.slug}" has been retired. Its contents are readable, but nothing new can be posted.`,
			);
		}

		const user = c.get('user');
		const signal = c.get('signal');
		const [modules, realmRole, permissions] = await Promise.all([
			modulesOf(db, realm.id),
			user ? roleOf(db, realm.id, user.id) : null,
			user ? permissionsIn(authorizer, realm.id, user.id, signal) : NOTHING,
		]);

		c.set('realm', {
			realmId: realm.id,
			realmSlug: realm.slug,
			realmRole,
			realmModules: modules,
			permissions: realm.archivedAt
				? { ...NOTHING, administer: permissions.administer }
				: permissions,
		});
		await next();
	});
}

async function findBySlug(db: Executor, slug: string) {
	const [row] = await db
		.select({ id: realms.id, slug: realms.slug, name: realms.name, archivedAt: realms.archivedAt })
		.from(realms)
		.where(eq(realms.slug, slug))
		.limit(1);
	return row;
}

async function modulesOf(db: Executor, realmId: string): Promise<RealmModule[]> {
	const rows = await db
		.select({ module: realmModules.module })
		.from(realmModules)
		.where(eq(realmModules.realmId, realmId))
		.orderBy(asc(realmModules.module));
	return rows.map((row) => narrow(RealmModule, row.module));
}

async function roleOf(db: Executor, realmId: string, userId: string): Promise<RealmRole | null> {
	const [row] = await db
		.select({ role: realmMembers.role })
		.from(realmMembers)
		.where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId)))
		.limit(1);
	return row ? narrow(RealmRole, row.role) : null;
}

async function permissionsIn(
	authorizer: Authorizer,
	realmId: string,
	userId: string,
	signal: AbortSignal,
): Promise<RealmPermissions> {
	const answers = await authorizer.checkMany(
		CHECKS.map(([, relation]) => ({ userId, relation, type: FgaType.realm, objectId: realmId })),
		signal,
	);
	return Object.fromEntries(
		CHECKS.map(([name], i) => [name, answers[i] ?? false]),
	) as unknown as RealmPermissions;
}

/** Refuses callers without `permission` in the realm. */
export const requirePermission = (permission: keyof RealmPermissions) =>
	createMiddleware<RealmEnv>(async (c, next) => {
		if (!c.get('realm').permissions[permission]) {
			throw new RealmForbidden(FORBIDDEN);
		}
		await next();
	});

const MODULE_NAMES: Record<RealmModule, string> = {
	[RealmModule.jobs]: 'job postings',
	[RealmModule.events]: 'events',
	[RealmModule.market]: 'a marketplace',
	[RealmModule.election]: 'elections',
};

/** Refuses when the realm doesn't run `module`. */
export const requireModule = (module: RealmModule) =>
	createMiddleware<RealmEnv>(async (c, next) => {
		if (!c.get('realm').realmModules.includes(module)) {
			throw new ModuleDisabled(`This realm does not run ${MODULE_NAMES[module]}.`);
		}
		await next();
	});

/** Checks `relation` on the object named by the path's `:id`. */
export const requireOn = (authorizer: Authorizer, relation: string, type: FgaType) =>
	createMiddleware<RealmEnv>(async (c, next) => {
		const user = c.get('user');
		const objectId = c.req.param('id');
		if (!user || !objectId) throw new RealmForbidden(FORBIDDEN);
		const allowed = await authorizer.check(
			{ userId: user.id, relation, type, objectId },
			c.get('signal'),
		);
		if (!allowed) throw new RealmForbidden(FORBIDDEN);
		await next();
	});
