import * as v from 'valibot';

/**
 * The platform tier: running the deployment rather than running a community.
 *
 * Everything here goes through the BFF, and every route 404s for anybody who is not a platform
 * administrator. That is deliberate on the API's side — a 403 would confirm to somebody probing
 * that an administrative surface exists — and it shapes this module too: {@link getOverview}
 * returning null is the normal answer for almost everyone, not an error to report.
 */

/** An account, wherever one is attached to something. */
const Account = v.object({
	id: v.string(),
	name: v.string(),
	email: v.string(),
});

/** What is in the deployment, and what is waiting. */
export const Overview = v.object({
	realms: v.number(),
	archived: v.number(),
	/** Realms with nobody holding admin. The one figure here that is a call to action. */
	orphaned: v.number(),
	members: v.number(),
	openReports: v.number(),
	auditEntries: v.number(),
});
export type Overview = v.InferOutput<typeof Overview>;

/** A realm as the administrative list shows it — archived ones included. */
export const PlatformRealm = v.object({
	id: v.string(),
	slug: v.string(),
	name: v.string(),
	category: v.nullable(v.string()),
	memberCount: v.number(),
	adminCount: v.number(),
	archivedAt: v.nullable(v.string()),
	createdAt: v.string(),
	createdBy: v.nullable(Account),
});
export type PlatformRealm = v.InferOutput<typeof PlatformRealm>;

/**
 * What happened to something.
 *
 * Mirrors `AuditAction` in the API. Duplicated rather than shared because the two repositories
 * do not share a package — and the mapping is checked by the fallback below, which renders an
 * unknown number as itself rather than as a confident wrong word.
 */
export const AUDIT_ACTION: Record<number, string> = {
	0: 'created',
	1: 'updated',
	2: 'deleted',
	3: 'role changed',
	4: 'moderated',
};

/** One administrative act. */
export const AuditEntry = v.object({
	id: v.string(),
	actor: v.nullable(Account),
	entityType: v.string(),
	entityId: v.string(),
	action: v.number(),
	changes: v.nullable(v.record(v.string(), v.unknown())),
	traceId: v.nullable(v.string()),
	occurredAt: v.string(),
});
export type AuditEntry = v.InferOutput<typeof AuditEntry>;

/** One report against a direct message. */
export const Report = v.object({
	id: v.string(),
	roomId: v.string(),
	messageId: v.nullable(v.string()),
	reason: v.string(),
	/** What the reporter says was said. Their claim, never the server's knowledge. */
	disclosedText: v.nullable(v.string()),
	reporter: v.nullable(Account),
	accused: v.nullable(Account),
	/**
	 * Whether the reported message really came from the accused.
	 *
	 * The server holds only ciphertext, so it cannot check the words. It can check the envelope,
	 * which catches a report naming the wrong person — the one abuse the reporting feature itself
	 * makes possible. Null when no message is attached, or it has since been deleted.
	 */
	senderMatches: v.nullable(v.boolean()),
	reviewedAt: v.nullable(v.string()),
	createdAt: v.string(),
});
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
export const PlatformAccount = v.object({
	id: v.string(),
	name: v.string(),
	email: v.string(),
	emailVerified: v.boolean(),
	createdAt: v.string(),
	/** Null for an account in good standing. */
	bannedAt: v.nullable(v.string()),
	banReason: v.nullable(v.string()),
	/** Null on an indefinite ban, and meaningless when `bannedAt` is null. */
	bannedUntil: v.nullable(v.string()),
	realmCount: v.number(),
});
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
