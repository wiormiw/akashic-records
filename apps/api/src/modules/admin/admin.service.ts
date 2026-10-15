import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type {
  Account,
  AuditRecord,
  Granted,
  PlatformCounts,
  PlatformRealm,
  Report,
} from "@akashic/contracts";
import { realmEvents } from "@akashic/contracts";
import {
  audit,
  auditEntries,
  inTransaction,
  publish,
  realmMembers,
  realms,
  roomReports,
  session,
  user,
} from "@akashic/db";
import { containing } from "@akashic/db/sql";
import { AuditAction, RealmRole } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { fromDate, toDate } from "@akashic/lib/time";
import type { AccountRef, AdminDeps, BanRequest, Row } from "./admin.types.ts";

// ---- Row readers -----------------------------------------------------------------------------

const instant = (value: unknown) => fromDate(new Date(String(value)));
const maybeInstant = (value: unknown) => (value ? instant(value) : null);
const int = (value: unknown) => Number(value ?? 0);
const person = (id: unknown, name: unknown, email: unknown) =>
  id ? { id: String(id), name: String(name ?? ""), email: String(email ?? "") } : null;

/** The platform's control panel: every realm, every account, the audit trail and reports. */
export function createAdminService(deps: AdminDeps) {
  const { db, clock } = deps;

  async function overview(): Promise<PlatformCounts> {
    const [row = {}] = (await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM realm) AS realms,
        (SELECT count(*)::int FROM realm WHERE archived_at IS NOT NULL) AS archived,
        (SELECT count(*)::int FROM realm r WHERE NOT EXISTS (
           SELECT 1 FROM realm_member m WHERE m.realm_id = r.id AND m.role = ${RealmRole.admin}
         )) AS orphaned,
        (SELECT count(*)::int FROM "user") AS members,
        (SELECT count(*)::int FROM room_report WHERE reviewed_at IS NULL) AS open_reports,
        (SELECT count(*)::int FROM audit_entries) AS audit_entries
    `)) as unknown as Row[];
    return {
      realms: int(row.realms),
      archived: int(row.archived),
      orphaned: int(row.orphaned),
      members: int(row.members),
      openReports: int(row.open_reports),
      auditEntries: int(row.audit_entries),
    };
  }

  async function listRealms(limit: number): Promise<PlatformRealm[]> {
    const rows = (await db.execute(sql`
      SELECT r.id, r.slug, r.name, r.category, r.archived_at, r.created_at,
        (SELECT count(*)::int FROM realm_member m WHERE m.realm_id = r.id) AS member_count,
        (SELECT count(*)::int FROM realm_member m
           WHERE m.realm_id = r.id AND m.role = ${RealmRole.admin}) AS admin_count,
        u.id AS founder_id, u.name AS founder_name, u.email AS founder_email
      FROM realm r
      LEFT JOIN "user" u ON u.id = r.created_by
      ORDER BY r.created_at DESC
      LIMIT ${limit}
    `)) as unknown as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      slug: String(row.slug),
      name: String(row.name),
      category: (row.category as string | null) ?? null,
      memberCount: Number(row.member_count),
      adminCount: Number(row.admin_count),
      archivedAt: maybeInstant(row.archived_at),
      createdAt: instant(row.created_at),
      createdBy: person(row.founder_id, row.founder_name, row.founder_email),
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
    const rows = (await db.execute(sql`
      SELECT rr.id, rr.room_id, rr.message_id, rr.reason, rr.disclosed_text,
        rr.reviewed_at, rr.created_at,
        rep.id AS reporter_id, rep.name AS reporter_name, rep.email AS reporter_email,
        acc.id AS accused_id, acc.name AS accused_name, acc.email AS accused_email,
        (SELECT m.sender_id = rr.accused_id FROM room_message m WHERE m.id = rr.message_id)
          AS sender_matches
      FROM room_report rr
      LEFT JOIN "user" rep ON rep.id = rr.reporter_id
      LEFT JOIN "user" acc ON acc.id = rr.accused_id
      ${openOnly ? sql`WHERE rr.reviewed_at IS NULL` : sql``}
      ORDER BY rr.reviewed_at IS NULL DESC, rr.created_at ASC
      LIMIT ${limit}
    `)) as unknown as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      roomId: String(row.room_id),
      messageId: (row.message_id as string | null) ?? null,
      reason: String(row.reason),
      disclosedText: (row.disclosed_text as string | null) ?? null,
      reporter: person(row.reporter_id, row.reporter_name, row.reporter_email),
      accused: person(row.accused_id, row.accused_name, row.accused_email),
      senderMatches: (row.sender_matches as boolean | null) ?? null,
      reviewedAt: maybeInstant(row.reviewed_at),
      createdAt: instant(row.created_at),
    }));
  }

  async function accounts(query: string, limit: number): Promise<Account[]> {
    const like = containing(query);
    const rows = (await db.execute(sql`
      SELECT u.id, u.name, u.email, u.email_verified, u.created_at,
        u.banned_at, u.ban_reason, u.banned_until,
        (SELECT count(*)::int FROM realm_member m WHERE m.user_id = u.id) AS realm_count
      FROM "user" u
      ${query ? sql`WHERE u.name ILIKE ${like} OR u.email ILIKE ${like}` : sql``}
      ORDER BY (u.banned_at IS NOT NULL) DESC, u.created_at DESC
      LIMIT ${limit}
    `)) as unknown as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      email: String(row.email),
      emailVerified: Boolean(row.email_verified),
      createdAt: instant(row.created_at),
      bannedAt: maybeInstant(row.banned_at),
      banReason: (row.ban_reason as string | null) ?? null,
      bannedUntil: maybeInstant(row.banned_until),
      realmCount: Number(row.realm_count),
    }));
  }

  async function findAccountByEmail(email: string): Promise<AccountRef | undefined> {
    const [row] = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
      })
      .from(user)
      .where(eq(user.email, email))
      .limit(1);
    return row;
  }

  return {
    overview,
    realms: listRealms,
    audit: auditTrail,
    reports,
    accounts,

    async reviewReport(reportId: string, actorId: string): Promise<Result<{ id: string }>> {
      return inTransaction(db, async (tx) => {
        // Only an unreviewed report: a second review finds nothing waiting.
        const reviewed = await tx
          .update(roomReports)
          .set({ reviewedAt: toDate(clock.now()) })
          .where(and(eq(roomReports.id, reportId), isNull(roomReports.reviewedAt)))
          .returning({ id: roomReports.id });
        if (reviewed.length === 0) {
          return err(
            fail.notFound(
              ErrorCode.common.routeNotFound,
              "No report waiting under that id. It may already have been reviewed.",
            ),
          );
        }
        await audit(tx, {
          actorId,
          entityType: "room_report",
          entityId: reportId,
          action: AuditAction.moderated,
          changes: { reviewed: true },
        });
        return ok({ id: reportId });
      });
    },

    /** Makes an existing account an admin of a realm, joining them first if needed. */
    async grantRealmAdmin(slug: string, email: string, actorId: string): Promise<Result<Granted>> {
      const [realm] = await db
        .select({ id: realms.id })
        .from(realms)
        .where(eq(realms.slug, slug))
        .limit(1);
      if (!realm) return err(fail.notFound(ErrorCode.realm.notFound, `No realm called "${slug}".`));
      const account = await findAccountByEmail(email);
      if (!account) {
        return err(
          fail.notFound(
            ErrorCode.common.routeNotFound,
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
          entityType: "realm",
          entityId: realm.id,
          action: AuditAction.roleChanged,
          changes: { grantedAdminTo: account.email, by: "platform" },
        });
        return ok({ realmId: realm.id, userId: account.id, name: account.name });
      });
    },

    async setBan(
      userId: string,
      actorId: string,
      ban: BanRequest,
    ): Promise<Result<{ banned: boolean }>> {
      if (userId === actorId) {
        return err(
          fail.validation(
            ErrorCode.common.validation,
            "You cannot suspend your own account: undoing it would need shell access to the deployment.",
          ),
        );
      }
      if (ban.banned && !ban.reason) {
        return err(
          fail.validation(
            ErrorCode.common.validation,
            "A reason is required. It is shown to the account, and an unexplained suspension looks like a broken product.",
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
                  banReason: ban.reason ?? "",
                  bannedUntil: ban.until ? toDate(ban.until) : null,
                }
              : { bannedAt: null, banReason: null, bannedUntil: null },
          )
          .where(eq(user.id, userId))
          .returning({ id: user.id });
        if (updated.length === 0) {
          return err(fail.notFound(ErrorCode.common.routeNotFound, "No such account."));
        }
        // Signed-in sessions would otherwise outlive the ban until their cookie expires.
        if (ban.banned) await tx.delete(session).where(eq(session.userId, userId));
        await audit(tx, {
          actorId,
          entityType: "user",
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

export type AdminService = ReturnType<typeof createAdminService>;
