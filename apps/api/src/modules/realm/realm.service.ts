import { and, asc, desc, eq, sql } from "drizzle-orm";
import { type Member, type RealmEdit, realmEvents, type RealmSummary } from "@akashic/contracts";
import {
  audit,
  type Executor,
  inTransaction,
  publish,
  realmMembers,
  realmModules,
  realms,
  type Tx,
  user,
} from "@akashic/db";
import { pgVector } from "@akashic/db/sql";
import { AuditAction, RealmRole } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { type Clock, fromDate, toDate } from "@akashic/lib/time";
import { policy } from "@/config.ts";
import type { Embedder } from "@/integrations/embedder.ts";
import { createProposals } from "./realm.proposals.ts";
import { insertModules, liveSummaries, ofMember } from "./realm.queries.ts";
import { knownModules } from "./realm.rules.ts";

export interface FoundRealm {
  slug: string;
  name: string;
  description?: string | null | undefined;
  category?: string | null | undefined;
  modules: readonly number[];
}

export interface RealmDeps {
  db: Executor;
  embedder: Embedder;
  clock: Clock;
}

/**
 * The writes that found a realm, in the caller's transaction: the realm, its modules, the founder
 * as admin, and both facts announced. A taken slug is a conflict and writes nothing.
 */
export async function foundIn(
  tx: Tx,
  founderId: string,
  realm: FoundRealm,
  now: Temporal.Instant,
): Promise<Result<string>> {
  const [created] = await tx
    .insert(realms)
    .values({
      slug: realm.slug,
      name: realm.name,
      description: realm.description ?? null,
      category: realm.category ?? null,
      createdBy: founderId,
    })
    .onConflictDoNothing()
    .returning({ id: realms.id });
  if (!created) {
    return err(fail.conflict(ErrorCode.realm.duplicateSlug, `The slug "${realm.slug}" is taken.`));
  }
  await insertModules(tx, created.id, knownModules(realm.modules));
  await tx.insert(realmMembers).values({
    realmId: created.id,
    userId: founderId,
    role: RealmRole.admin,
  });
  await publish(
    tx,
    [
      realmEvents.created(created.id),
      realmEvents.memberChanged(created.id, founderId, RealmRole.admin),
    ],
    now,
  );
  return ok(created.id);
}

export function createRealmService(deps: RealmDeps) {
  const { db, embedder, clock } = deps;

  /** Seeds the centroid from the realm's own description, so fit can be judged from day one. */
  async function seedCentroid(
    realmId: string,
    name: string,
    description: string | null | undefined,
  ): Promise<boolean> {
    const embedding = await embedder.embed([name, description].filter(Boolean).join("\n\n"));
    if (!embedding) return false;
    await db
      .update(realms)
      .set({
        centroid: sql`${pgVector(embedding)}::vector`,
        centroidSamples: sql`${realms.centroidSamples} + 1`,
        updatedAt: toDate(clock.now()),
      })
      .where(eq(realms.id, realmId));
    return true;
  }

  async function found(
    founderId: string,
    realm: FoundRealm,
  ): Promise<Result<{ id: string; slug: string }>> {
    const id = await inTransaction(db, (tx) => foundIn(tx, founderId, realm, clock.now()));
    if (!id.ok) return id;
    // After the commit: the model call is slow, optional, and no reason to hold a transaction.
    await seedCentroid(id.value, realm.name, realm.description);
    return ok({ id: id.value, slug: realm.slug });
  }

  return {
    seedCentroid,

    async browse(): Promise<RealmSummary[]> {
      return liveSummaries(
        db,
        sql`ORDER BY member_count DESC, r.created_at ASC LIMIT ${policy.pageSize}`,
      );
    },

    /** Live realms only. */
    async read(slug: string): Promise<Result<RealmSummary>> {
      const [realm] = await liveSummaries(db, sql`AND r.slug = ${slug} LIMIT 1`);
      return realm
        ? ok(realm)
        : err(fail.notFound(ErrorCode.realm.notFound, `No realm called "${slug}".`));
    },

    found,

    join(realmId: string, userId: string): Promise<Result<{ joined: true }>> {
      return inTransaction(db, async (tx) => {
        // A second join, even one racing this, finds the row and inserts nothing.
        const inserted = await tx
          .insert(realmMembers)
          .values({ realmId, userId, role: RealmRole.member })
          .onConflictDoNothing()
          .returning({ userId: realmMembers.userId });
        if (inserted.length === 0) {
          return err(
            fail.conflict(ErrorCode.realm.alreadyMember, "You are already in this realm."),
          );
        }
        await publish(
          tx,
          [realmEvents.memberChanged(realmId, userId, RealmRole.member)],
          clock.now(),
        );
        return ok({ joined: true as const });
      });
    },

    leave(
      realmId: string,
      userId: string,
      role: RealmRole | null,
    ): Promise<Result<{ left: true }>> {
      return inTransaction(db, async (tx) => {
        if (role === RealmRole.admin) {
          // Locked, so two admins leaving at once can't both see the other still there.
          const admins = await tx
            .select({ userId: realmMembers.userId })
            .from(realmMembers)
            .where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.role, RealmRole.admin)))
            .for("update");
          if (admins.length === 1) {
            return err(
              fail.conflict(
                ErrorCode.realm.soleAdmin,
                "You are the only admin. Promote someone else before leaving.",
              ),
            );
          }
        }
        const removed = await tx
          .delete(realmMembers)
          .where(ofMember(realmId, userId))
          .returning({ userId: realmMembers.userId });
        if (removed.length === 0) {
          return err(fail.notFound(ErrorCode.realm.notMember, "You are not in this realm."));
        }
        await publish(tx, [realmEvents.memberChanged(realmId, userId, null)], clock.now());
        return ok({ left: true as const });
      });
    },

    async roster(realmId: string): Promise<Member[]> {
      const rows = await db
        .select({
          userId: realmMembers.userId,
          role: realmMembers.role,
          displayName: realmMembers.displayName,
          name: user.name,
          image: user.image,
          joinedAt: realmMembers.joinedAt,
        })
        .from(realmMembers)
        .innerJoin(user, eq(user.id, realmMembers.userId))
        .where(eq(realmMembers.realmId, realmId))
        .orderBy(desc(realmMembers.role), asc(realmMembers.joinedAt))
        .limit(policy.pageSize);
      return rows.map((row) => ({ ...row, joinedAt: fromDate(row.joinedAt) }));
    },

    changeRole(
      realmId: string,
      actor: { id: string; role: RealmRole | null },
      targetId: string,
      role: RealmRole,
    ): Promise<Result<{ userId: string; role: RealmRole }>> {
      if (targetId === actor.id) {
        return Promise.resolve(
          err(fail.forbidden(ErrorCode.realm.forbidden, "You cannot change your own role.")),
        );
      }
      // Vouching makes someone verified; only an admin hands out staff roles.
      if (role >= RealmRole.moderator && actor.role !== RealmRole.admin) {
        return Promise.resolve(
          err(
            fail.forbidden(
              ErrorCode.realm.forbidden,
              "Only an admin can grant moderator or admin.",
            ),
          ),
        );
      }
      return inTransaction(db, async (tx) => {
        const updated = await tx
          .update(realmMembers)
          .set({ role })
          .where(ofMember(realmId, targetId))
          .returning({ userId: realmMembers.userId });
        if (updated.length === 0) {
          return err(fail.notFound(ErrorCode.realm.notMember, "That person is not in this realm."));
        }
        await publish(tx, [realmEvents.memberChanged(realmId, targetId, role)], clock.now());
        await audit(tx, {
          actorId: actor.id,
          entityType: "realm_member",
          entityId: targetId,
          action: AuditAction.roleChanged,
          changes: { realmId, role },
        });
        return ok({ userId: targetId, role });
      });
    },

    async edit(
      realmId: string,
      actorId: string,
      edit: RealmEdit,
    ): Promise<Result<{ changed: string[] }>> {
      const { modules, ...values } = edit;
      const changed = Object.keys(edit).filter((key) => edit[key as keyof RealmEdit] !== undefined);
      if (changed.length === 0) return ok({ changed });

      return inTransaction(db, async (tx) => {
        const updated = await tx
          .update(realms)
          .set({ ...values, updatedAt: toDate(clock.now()) })
          .where(eq(realms.id, realmId))
          .returning({ id: realms.id });
        if (updated.length === 0) {
          return err(fail.notFound(ErrorCode.realm.notFound, "No such realm."));
        }
        if (modules) {
          await tx.delete(realmModules).where(eq(realmModules.realmId, realmId));
          await insertModules(tx, realmId, knownModules(modules));
        }
        await audit(tx, {
          actorId,
          entityType: "realm",
          entityId: realmId,
          action: AuditAction.updated,
          changes: Object.fromEntries(changed.map((key) => [key, edit[key as keyof RealmEdit]])),
        });
        return ok({ changed });
      });
    },

    archive(
      realmId: string,
      actorId: string,
      archived: boolean,
    ): Promise<Result<{ archived: boolean }>> {
      const now = clock.now();
      return inTransaction(db, async (tx) => {
        const updated = await tx
          .update(realms)
          .set({ archivedAt: archived ? toDate(now) : null, updatedAt: toDate(now) })
          .where(eq(realms.id, realmId))
          .returning({ id: realms.id });
        if (updated.length === 0) {
          return err(fail.notFound(ErrorCode.realm.notFound, "No such realm."));
        }
        await audit(tx, {
          actorId,
          entityType: "realm",
          entityId: realmId,
          action: archived ? AuditAction.deleted : AuditAction.updated,
          changes: { archived },
        });
        return ok({ archived });
      });
    },

    ...createProposals({ db, clock, foundIn, seedCentroid }),
  };
}

export type RealmService = ReturnType<typeof createRealmService>;
