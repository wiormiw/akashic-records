import * as v from 'valibot';
import {
	AccountView,
	AuditView,
	CountsView,
	PlatformRealmView,
	ReportView,
} from '@akashic/contracts';
import { AuditAction } from '@akashic/lib/enums';

/**
 * The platform tier: running the deployment rather than running a community.
 *
 * Everything here goes through the BFF, and every route 404s for anybody who is not a platform
 * administrator. That is deliberate on the API's side — a 403 would confirm to somebody probing
 * that an administrative surface exists — and it shapes this module too: {@link getOverview}
 * returning null is the normal answer for almost everyone, not an error to report.
 */

/** What is in the deployment, and what is waiting. */
export const Overview = CountsView;
export type Overview = v.InferOutput<typeof Overview>;

/** A realm as the administrative list shows it — archived ones included. */
export const PlatformRealm = PlatformRealmView;
export type PlatformRealm = v.InferOutput<typeof PlatformRealm>;

/** What happened to something, in words. Keyed by the API's `AuditAction`. */
export const AUDIT_ACTION: Record<AuditAction, string> = {
	[AuditAction.created]: 'created',
	[AuditAction.updated]: 'updated',
	[AuditAction.deleted]: 'deleted',
	[AuditAction.roleChanged]: 'role changed',
	[AuditAction.moderated]: 'moderated',
};

/** One administrative act. */
export const AuditEntry = AuditView;
export type AuditEntry = v.InferOutput<typeof AuditEntry>;

/** One report against a direct message. */
export const Report = ReportView;
export type Report = v.InferOutput<typeof Report>;

/** Reads one administrative endpoint, or null when the caller is not a platform administrator. */
async function read<T extends v.GenericSchema>(
	path: string,
	schema: T,
	doFetch: typeof globalThis.fetch,
): Promise<v.InferOutput<T> | null> {
	try {
		const response = await doFetch(`/bff/api/v1/admin${path}`, {
			headers: { accept: 'application/json' },
		});

		// 404 is the ordinary answer for everybody without platform authority, so it is not
		// distinguished from any other failure here. The page turns null into its own 404.
		if (!response.ok) return null;

		const parsed = v.safeParse(schema, await response.json());
		return parsed.success ? parsed.output : null;
	} catch {
		return null;
	}
}

/**
 * The overview, which doubles as the "may I see this at all" probe.
 *
 * @param fetch The load event's fetch, so the session cookie travels during SSR.
 * @returns The counts, or null when the caller is not a platform administrator.
 *
 * @example
 * const overview = await getOverview(fetch);
 * if (!overview) error(404, 'Not found.');
 */
export const getOverview = (doFetch: typeof globalThis.fetch): Promise<Overview | null> =>
	read('', Overview, doFetch);

/** Every realm, archived ones included. */
export const getRealms = (doFetch: typeof globalThis.fetch): Promise<PlatformRealm[] | null> =>
	read('/realms?limit=200', v.array(PlatformRealm), doFetch);

/** The audit trail, newest first. */
export const getAudit = (doFetch: typeof globalThis.fetch): Promise<AuditEntry[] | null> =>
	read('/audit?limit=100', v.array(AuditEntry), doFetch);

/** The report queue. */
export const getReports = (
	doFetch: typeof globalThis.fetch,
	state: 'open' | 'all' = 'open',
): Promise<Report[] | null> => read(`/reports?state=${state}&limit=100`, v.array(Report), doFetch);

/**
 * Marks a report as looked at.
 *
 * "Reviewed" means a human read it, and nothing more. Most reports end with a moderator
 * deciding no action was warranted, and a queue that can only be cleared by punishing somebody
 * is a queue that punishes somebody.
 *
 * @param reportId The report.
 * @throws {Error} When the API refuses, with its own wording.
 */
export async function reviewReport(reportId: string): Promise<void> {
	const response = await fetch(`/bff/api/v1/admin/reports/${reportId}/review`, {
		method: 'POST',
		headers: { accept: 'application/json' },
	});

	if (!response.ok) {
		const problem = await response.json().catch(() => null);
		throw new Error(problem?.detail ?? 'That did not work.');
	}
}

/**
 * Puts an administrator back into a realm that has lost its own.
 *
 * @param slug The realm.
 * @param email The account to promote. They need not already be a member.
 * @throws {Error} When the API refuses, with its own wording.
 */
export async function grantRealmAdmin(slug: string, email: string): Promise<void> {
	const response = await fetch(`/bff/api/v1/admin/realms/${slug}/admins`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ email }),
	});

	if (!response.ok) {
		const problem = await response.json().catch(() => null);
		throw new Error(problem?.detail ?? 'That did not work.');
	}
}

/* -------------------------------------------------------------------------------------------
 * People.
 * ---------------------------------------------------------------------------------------- */

/** An account as the people list shows it. */
export const PlatformAccount = AccountView;
export type PlatformAccount = v.InferOutput<typeof PlatformAccount>;

/** The accounts, suspended ones first. */
export const getAccounts = (
	doFetch: typeof globalThis.fetch,
	query = '',
): Promise<PlatformAccount[] | null> =>
	read(
		`/accounts?limit=200${query ? `&q=${encodeURIComponent(query)}` : ''}`,
		v.array(PlatformAccount),
		doFetch,
	);

/**
 * Suspends an account, or lifts the suspension.
 *
 * @param id The account.
 * @param ban Null to lift; otherwise a reason, which is shown to them, and an optional end date.
 * @throws {Error} With the API's own wording on refusal.
 */
export async function setBan(
	id: string,
	ban: { reason: string; until: string | null } | null,
): Promise<void> {
	const response = await fetch(`/bff/api/v1/admin/accounts/${id}/ban`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(
			ban
				? { banned: true, reason: ban.reason, ...(ban.until ? { until: ban.until } : {}) }
				: { banned: false },
		),
	});

	if (!response.ok) {
		const problem = await response.json().catch(() => null);
		throw new Error(problem?.detail ?? 'That did not work.');
	}
}
