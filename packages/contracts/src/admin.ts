import * as v from 'valibot';
import { AuditAction, narrow } from '@akashic/lib/enums';
import { iso, isoOrNull, oneOf, PageLimit, Timestamp, trimmedAsSent } from './common.ts';

// The platform admin API contract. (Services hold a Temporal.Instant; the presenters render it.)

// ---- Requests --------------------------------------------------------------------------------

export const ListQuery = v.object({ limit: PageLimit });
export const AccountsQuery = v.object({
	limit: PageLimit,
	q: v.optional(trimmedAsSent({ maxLength: 120 })),
});
export const AuditQuery = v.object({
	limit: PageLimit,
	entityType: v.optional(trimmedAsSent({ maxLength: 40 })),
});
export const ReportsQuery = v.object({
	limit: PageLimit,
	state: v.optional(v.picklist(['open', 'all']), 'open'),
});
export const AdminSlugParam = v.object({ slug: trimmedAsSent({ minLength: 1, maxLength: 48 }) });
export const GrantBody = v.object({
	email: v.pipe(v.string(), v.maxLength(254), v.email()),
});
export const BanBody = v.object({
	banned: v.boolean(),
	reason: v.optional(trimmedAsSent({ minLength: 4, maxLength: 500 })),
	until: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});

// ---- What the services hold ------------------------------------------------------------------

/** An account, wherever one is attached to something. */
export interface Person {
	id: string;
	name: string;
	email: string;
}

export interface PlatformCounts {
	realms: number;
	archived: number;
	/** Realms nobody administers: the number here that asks for action. */
	orphaned: number;
	members: number;
	openReports: number;
	auditEntries: number;
}

export interface PlatformRealm {
	id: string;
	slug: string;
	name: string;
	category: string | null;
	memberCount: number;
	adminCount: number;
	archivedAt: Temporal.Instant | null;
	createdAt: Temporal.Instant;
	createdBy: Person | null;
}

export interface AuditRecord {
	id: string;
	actor: Person | null;
	entityType: string;
	entityId: string;
	action: number;
	changes: Record<string, unknown> | null;
	traceId: string | null;
	occurredAt: Temporal.Instant;
}

export interface Report {
	id: string;
	roomId: string;
	messageId: string | null;
	reason: string;
	disclosedText: string | null;
	reporter: Person | null;
	accused: Person | null;
	/** Whether the reported message was really sent by the accused. Null without a message. */
	senderMatches: boolean | null;
	reviewedAt: Temporal.Instant | null;
	createdAt: Temporal.Instant;
}

export interface Account {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	createdAt: Temporal.Instant;
	bannedAt: Temporal.Instant | null;
	banReason: string | null;
	bannedUntil: Temporal.Instant | null;
	realmCount: number;
}

// ---- Responses -------------------------------------------------------------------------------

const PersonView = v.object({ id: v.string(), name: v.string(), email: v.string() });

export const CountsView = v.object({
	realms: v.pipe(v.number(), v.integer()),
	archived: v.pipe(v.number(), v.integer()),
	orphaned: v.pipe(v.number(), v.integer()),
	members: v.pipe(v.number(), v.integer()),
	openReports: v.pipe(v.number(), v.integer()),
	auditEntries: v.pipe(v.number(), v.integer()),
});

export const PlatformRealmView = v.object({
	id: v.string(),
	slug: v.string(),
	name: v.string(),
	category: v.nullable(v.string()),
	memberCount: v.pipe(v.number(), v.integer()),
	adminCount: v.pipe(v.number(), v.integer()),
	archivedAt: v.nullable(Timestamp),
	createdAt: Timestamp,
	createdBy: v.nullable(PersonView),
});

export const AuditView = v.object({
	id: v.string(),
	actor: v.nullable(PersonView),
	entityType: v.string(),
	entityId: v.string(),
	action: oneOf(AuditAction),
	// Whatever the action changed: open-ended on purpose, so no detail of the record is dropped.
	changes: v.nullable(v.record(v.string(), v.unknown())),
	traceId: v.nullable(v.string()),
	occurredAt: Timestamp,
});

export const ReportView = v.object({
	id: v.string(),
	roomId: v.string(),
	messageId: v.nullable(v.string()),
	reason: v.string(),
	disclosedText: v.nullable(v.string()),
	reporter: v.nullable(PersonView),
	accused: v.nullable(PersonView),
	senderMatches: v.nullable(v.boolean()),
	reviewedAt: v.nullable(Timestamp),
	createdAt: Timestamp,
});

export const AccountView = v.object({
	id: v.string(),
	name: v.string(),
	email: v.string(),
	emailVerified: v.boolean(),
	createdAt: Timestamp,
	bannedAt: v.nullable(Timestamp),
	banReason: v.nullable(v.string()),
	bannedUntil: v.nullable(Timestamp),
	realmCount: v.pipe(v.number(), v.integer()),
});

export const GrantedView = v.object({ realmId: v.string(), userId: v.string(), name: v.string() });
export const BanView = v.object({ banned: v.boolean() });
export const ReviewedView = v.object({ id: v.string() });

export interface Granted {
	realmId: string;
	userId: string;
	name: string;
}

// ---- Presenters ------------------------------------------------------------------------------

const person = (p: Person | null) => p && { id: p.id, name: p.name, email: p.email };

export const presentCounts = (c: PlatformCounts): v.InferOutput<typeof CountsView> => ({
	realms: c.realms,
	archived: c.archived,
	orphaned: c.orphaned,
	members: c.members,
	openReports: c.openReports,
	auditEntries: c.auditEntries,
});

export const presentPlatformRealm = (
	r: PlatformRealm,
): v.InferOutput<typeof PlatformRealmView> => ({
	id: r.id,
	slug: r.slug,
	name: r.name,
	category: r.category,
	memberCount: r.memberCount,
	adminCount: r.adminCount,
	archivedAt: isoOrNull(r.archivedAt),
	createdAt: iso(r.createdAt),
	createdBy: person(r.createdBy),
});

export const presentAudit = (a: AuditRecord): v.InferOutput<typeof AuditView> => ({
	id: a.id,
	actor: person(a.actor),
	entityType: a.entityType,
	entityId: a.entityId,
	action: narrow(AuditAction, a.action),
	changes: a.changes,
	traceId: a.traceId,
	occurredAt: iso(a.occurredAt),
});

export const presentReport = (r: Report): v.InferOutput<typeof ReportView> => ({
	id: r.id,
	roomId: r.roomId,
	messageId: r.messageId,
	reason: r.reason,
	disclosedText: r.disclosedText,
	reporter: person(r.reporter),
	accused: person(r.accused),
	senderMatches: r.senderMatches,
	reviewedAt: isoOrNull(r.reviewedAt),
	createdAt: iso(r.createdAt),
});

export const presentAccount = (a: Account): v.InferOutput<typeof AccountView> => ({
	id: a.id,
	name: a.name,
	email: a.email,
	emailVerified: a.emailVerified,
	createdAt: iso(a.createdAt),
	bannedAt: isoOrNull(a.bannedAt),
	banReason: a.banReason,
	bannedUntil: isoOrNull(a.bannedUntil),
	realmCount: a.realmCount,
});
