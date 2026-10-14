import { and, eq, type SQL, sql } from "drizzle-orm";
import { realmEvents, type RealmSummary } from "@akashic/contracts";
import { type Executor, publish, realmMembers, realmModules, realms, type Tx } from "@akashic/db";
import { RealmRole } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { err, ok, type Result } from "@akashic/lib/result";
import { knownModules } from "./realm.rules.ts";

// Query helpers the realm service and its proposals share. Writers take the transaction.

type SummaryRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  member_count: number;
  modules: number[] | null;
};

const toSummary = (row: SummaryRow): RealmSummary => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  category: row.category,
  memberCount: Number(row.member_count),
  modules: row.modules ?? [],
});

/** Live realms with their member counts and modules; `rest` filters further, orders and limits. */
export async function liveSummaries(db: Executor, rest: SQL): Promise<RealmSummary[]> {
  const rows = (await db.execute(sql`
    SELECT
      r.id, r.slug, r.name, r.description, r.category,
      (SELECT count(*)::int FROM realm_member m WHERE m.realm_id = r.id) AS member_count,
      (SELECT coalesce(array_agg(rm.module ORDER BY rm.module), '{}')
         FROM realm_module rm WHERE rm.realm_id = r.id) AS modules
    FROM realm r
    WHERE r.archived_at IS NULL
    ${rest}
  `)) as unknown as SummaryRow[];
  return rows.map(toSummary);
}

export async function insertModules(tx: Tx, realmId: string, modules: readonly number[]) {
  if (modules.length === 0) return;
  await tx.insert(realmModules).values(modules.map((module) => ({ realmId, module })));
}

export const ofMember = (realmId: string, userId: string) =>
  and(eq(realmMembers.realmId, realmId), eq(realmMembers.userId, userId));

export interface FoundRealm {
  slug: string;
  name: string;
  description?: string | null | undefined;
  category?: string | null | undefined;
  modules: readonly number[];
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
