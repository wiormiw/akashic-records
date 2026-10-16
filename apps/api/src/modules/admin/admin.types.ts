import type { Executor } from '@akashic/db';
import type { RealmNotFound, RouteNotFound, ValidationFailed } from '@akashic/lib/errors';
import type { Clock } from '@akashic/lib/time';
import type { Sessions } from '@/http/session.ts';
import type { AdminService } from './admin.service.ts';

/** What the admin service is built from. */
export interface AdminDeps {
	db: Executor;
	clock: Clock;
}

export type { AdminService };

/** What the admin routes are built from: every route sits behind the platform-admin session. */
export interface AdminRoutesDeps {
	admin: AdminService;
	sessions: Sessions;
}

export type AdminModuleDeps = AdminRoutesDeps;

/** A suspension as asked for. A reason is required to ban; `until` null or absent is indefinite. */
export interface BanRequest {
	banned: boolean;
	reason?: string;
	until?: Temporal.Instant;
}

/** The raw row a raw SQL query returns: columns arrive untyped. */
export type Row = Record<string, unknown>;

/** What reviewing a report answers. */
export interface Reviewed {
	id: string;
}

/** What a suspension answers: whether the account is now banned. */
export interface BanResult {
	banned: boolean;
}

/** The account a grant names. */
export interface AccountRef {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
}

// ---- Errors ----------------------------------------------------------------------------------

// What each admin service call can fail with. A missing report or account is the router's 404.
export type ReviewReportError = RouteNotFound;
export type GrantRealmAdminError = RealmNotFound | RouteNotFound;
export type SetBanError = ValidationFailed | RouteNotFound;
