import { alias } from 'drizzle-orm/pg-core';
import { and, asc, desc, eq, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type {
	Account,
	AuditRecord,
	Granted,
	PlatformCounts,
	PlatformRealm,
	Report,
} from '@akashic/contracts';
import { realmEvents } from '@akashic/contracts/events';
import {
	audit,
	auditEntries,
	inTransaction,
	publish,
	realmMembers,
	realms,
	roomMessages,
	roomReports,
	session,
	user,
} from '@akashic/db';
import { containing, first, one } from '@akashic/db/sql';
import { AuditAction, RealmRole } from '@akashic/lib/enums';
import { RealmNotFound, RouteNotFound, ValidationFailed } from '@akashic/lib/errors';
import { err, ok, type Result } from '@akashic/lib/result';
import { fromDate, toDate } from '@akashic/lib/time';
import type {
	AccountRef,
	AdminDeps,
	BanRequest,
	BanResult,
	GrantRealmAdminError,
	Reviewed,
	ReviewReportError,
	SetBanError,
} from './admin.types.ts';

// ---- Row readers -----------------------------------------------------------------------------

const maybeInstant = (date: Date | null) => (date ? fromDate(date) : null);
const person = (id: string | null, name: string | null, email: string | null) =>
	id ? { id, name: name ?? '', email: email ?? '' } : null;

const reporter = alias(user, 'reporter');
const accused = alias(user, 'accused');

/** The overview's columns, each cast to int in the SQL so the numbers arrive as numbers. */
type PlatformCountsRow = {
	realms: number;
	archived: number;
	orphaned: number;
	members: number;
	open_reports: number;
	audit_entries: number;
};

/** The platform's control panel: every realm, every account, the audit trail and reports. */
export function createAdminService(deps: AdminDeps) {
	const { db, clock } = deps;

	async function overview(): Promise<PlatformCounts> {
		// One statement, so the six counts come from one snapshot.
		const row = one(
			await db.execute<PlatformCountsRow>(sql`
      SELECT
        (SELECT count(*)::int FROM realm) AS realms,
        (SELECT count(*)::int FROM realm WHERE archived_at IS NOT NULL) AS archived,
        (SELECT count(*)::int FROM realm r WHERE NOT EXISTS (
           SELECT 1 FROM realm_member m WHERE m.realm_id = r.id AND m.role = ${RealmRole.admin}
         )) AS orphaned,
        (SELECT count(*)::int FROM "user") AS members,
        (SELECT count(*)::int FROM room_report WHERE reviewed_at IS NULL) AS open_reports,
        (SELECT count(*)::int FROM audit_entries) AS audit_entries
    `),
			'platform counts',
		);
		return {
			realms: row.realms,
			archived: row.archived,
			orphaned: row.orphaned,
			members: row.members,
			openReports: row.open_reports,
			auditEntries: row.audit_entries,
		};
	}

	async function listRealms(limit: number): Promise<PlatformRealm[]> {
		const rows = await db
			.select({
				id: realms.id,
				slug: realms.slug,
				name: realms.name,
				category: realms.category,
				archivedAt: realms.archivedAt,
				createdAt: realms.createdAt,
				memberCount: db.$count(realmMembers, eq(realmMembers.realmId, realms.id)),
				adminCount: db.$count(
					realmMembers,
					and(eq(realmMembers.realmId, realms.id), eq(realmMembers.role, RealmRole.admin)),
				),
				founderId: user.id,
				founderName: user.name,
				founderEmail: user.email,
			})
			.from(realms)
			.leftJoin(user, eq(user.id, realms.createdBy))
			.orderBy(desc(realms.createdAt))
			.limit(limit);
		return rows.map(({ founderId, founderName, founderEmail, ...row }) => ({
			...row,
			archivedAt: maybeInstant(row.archivedAt),
			createdAt: fromDate(row.createdAt),
			createdBy: person(founderId, founderName, founderEmail),
		}));
	}

	async function auditTrail(limit: number, entityType: string | undefined): Promise<AuditRecord[]> {
		const rows = await db
			.select({
				id: auditEntries.id,
				actorId: user.id,
				actorName: user.name,
				actorEmail: user.email,
				entityType: auditEntries.entityType,
				entityId: auditEntries.entityId,
				action: auditEntries.action,
				changes: auditEntries.changes,
				traceId: auditEntries.traceId,
				occurredAt: auditEntries.occurredAt,
			})
			.from(auditEntries)
			.leftJoin(user, eq(user.id, auditEntries.userId))
			.where(entityType ? eq(auditEntries.entityType, entityType) : undefined)
			.orderBy(desc(auditEntries.occurredAt))
			.limit(limit);
		return rows.map(({ actorId, actorName, actorEmail, ...row }) => ({
			...row,
			actor: person(actorId, actorName, actorEmail),
			changes: row.changes ?? null,
			occurredAt: fromDate(row.occurredAt),
		}));
	}

	async function reports(openOnly: boolean, limit: number): Promise<Report[]> {
		const rows = await db
			.select({
				id: roomReports.id,
				roomId: roomReports.roomId,
				messageId: roomReports.messageId,
				reason: roomReports.reason,
				disclosedText: roomReports.disclosedText,
				reviewedAt: roomReports.reviewedAt,
				createdAt: roomReports.createdAt,
				reporterId: reporter.id,
				reporterName: reporter.name,
				reporterEmail: reporter.email,
				accusedId: accused.id,
				accusedName: accused.name,
				accusedEmail: accused.email,
				// Null when the report names no message, or the message is gone.
				senderMatches: sql<boolean | null>`${roomMessages.senderId} = ${roomReports.accusedId}`,
			})
			.from(roomReports)
			.leftJoin(reporter, eq(reporter.id, roomReports.reporterId))
			.leftJoin(accused, eq(accused.id, roomReports.accusedId))
			.leftJoin(roomMessages, eq(roomMessages.id, roomReports.messageId))
			.where(openOnly ? isNull(roomReports.reviewedAt) : undefined)
			.orderBy(desc(isNull(roomReports.reviewedAt)), asc(roomReports.createdAt))
			.limit(limit);
		return rows.map(
			({
				reporterId,
				reporterName,
				reporterEmail,
				accusedId,
				accusedName,
				accusedEmail,
				...row
			}) => ({
				...row,
				reporter: person(reporterId, reporterName, reporterEmail),
				accused: person(accusedId, accusedName, accusedEmail),
				reviewedAt: maybeInstant(row.reviewedAt),
				createdAt: fromDate(row.createdAt),
			}),
		);
	}

	async function accounts(query: string, limit: number): Promise<Account[]> {
		const like = containing(query);
		const rows = await db
			.select({
				id: user.id,
				name: user.name,
				email: user.email,
				emailVerified: user.emailVerified,
				createdAt: user.createdAt,
				bannedAt: user.bannedAt,
				banReason: user.banReason,
				bannedUntil: user.bannedUntil,
				realmCount: db.$count(realmMembers, eq(realmMembers.userId, user.id)),
			})
			.from(user)
			.where(query ? or(ilike(user.name, like), ilike(user.email, like)) : undefined)
			.orderBy(desc(isNotNull(user.bannedAt)), desc(user.createdAt))
			.limit(limit);
		return rows.map((row) => ({
			...row,
			createdAt: fromDate(row.createdAt),
			bannedAt: maybeInstant(row.bannedAt),
			bannedUntil: maybeInstant(row.bannedUntil),
		}));
	}

	async function findAccountByEmail(email: string): Promise<AccountRef | undefined> {
		return first(
			await db
				.select({
					id: user.id,
					name: user.name,
					email: user.email,
					emailVerified: user.emailVerified,
				})
				.from(user)
				.where(eq(user.email, email))
				.limit(1),
		);
	}

	return {
		overview,
		realms: listRealms,
		audit: auditTrail,
		reports,
		accounts,

		async reviewReport(
			reportId: string,
			actorId: string,
		): Promise<Result<Reviewed, ReviewReportError>> {
			return inTransaction(db, async (tx) => {
				// Only an unreviewed report: a second review finds nothing waiting.
				const reviewed = await tx
					.update(roomReports)
					.set({ reviewedAt: toDate(clock.now()) })
					.where(and(eq(roomReports.id, reportId), isNull(roomReports.reviewedAt)))
					.returning({ id: roomReports.id });
				if (reviewed.length === 0) {
					return err(
						new RouteNotFound(
							'No report waiting under that id. It may already have been reviewed.',
						),
					);
				}
				await audit(tx, {
					actorId,
					entityType: 'room_report',
					entityId: reportId,
					action: AuditAction.moderated,
					changes: { reviewed: true },
				});
				return ok({ id: reportId });
			});
		},

		/** Makes an existing account an admin of a realm, joining them first if needed. */
		async grantRealmAdmin(
			slug: string,
			email: string,
			actorId: string,
		): Promise<Result<Granted, GrantRealmAdminError>> {
			const realm = first(
				await db.select({ id: realms.id }).from(realms).where(eq(realms.slug, slug)).limit(1),
			);
			if (!realm) return err(new RealmNotFound(`No realm called "${slug}".`));
			const account = await findAccountByEmail(email);
			if (!account) {
				return err(
					new RouteNotFound(
						`No account for ${email}. They have to register before they can be given a realm.`,
					),
				);
			}

			return inTransaction(db, async (tx) => {
				await tx
					.insert(realmMembers)
					.values({ realmId: realm.id, userId: account.id, role: RealmRole.admin })
					.onConflictDoUpdate({
						target: [realmMembers.realmId, realmMembers.userId],
						set: { role: RealmRole.admin },
					});
				await publish(
					tx,
					[realmEvents.memberChanged(realm.id, account.id, RealmRole.admin)],
					clock.now(),
				);
				await audit(tx, {
					actorId,
					entityType: 'realm',
					entityId: realm.id,
					action: AuditAction.roleChanged,
					changes: { grantedAdminTo: account.email, by: 'platform' },
				});
				return ok({ realmId: realm.id, userId: account.id, name: account.name });
			});
		},

		async setBan(
			userId: string,
			actorId: string,
			ban: BanRequest,
		): Promise<Result<BanResult, SetBanError>> {
			if (userId === actorId) {
				return err(
					new ValidationFailed(
						'You cannot suspend your own account: undoing it would need shell access to the deployment.',
					),
				);
			}
			if (ban.banned && !ban.reason) {
				return err(
					new ValidationFailed(
						'A reason is required. It is shown to the account, and an unexplained suspension looks like a broken product.',
					),
				);
			}

			return inTransaction(db, async (tx) => {
				const updated = await tx
					.update(user)
					.set(
						ban.banned
							? {
									bannedAt: toDate(clock.now()),
									banReason: ban.reason ?? '',
									bannedUntil: ban.until ? toDate(ban.until) : null,
								}
							: { bannedAt: null, banReason: null, bannedUntil: null },
					)
					.where(eq(user.id, userId))
					.returning({ id: user.id });
				if (updated.length === 0) {
					return err(new RouteNotFound('No such account.'));
				}
				// Signed-in sessions would otherwise outlive the ban until their cookie expires.
				if (ban.banned) await tx.delete(session).where(eq(session.userId, userId));
				await audit(tx, {
					actorId,
					entityType: 'user',
					entityId: userId,
					action: ban.banned ? AuditAction.moderated : AuditAction.updated,
					changes: ban.banned
						? { banned: true, reason: ban.reason, until: ban.until?.toString() ?? null }
						: { banned: false },
				});
				return ok({ banned: ban.banned });
			});
		},
	};
}
