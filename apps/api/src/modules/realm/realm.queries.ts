import { and, eq, type SQL, sql } from "drizzle-orm";
import type { RealmSummary } from "@akashic/contracts";
import { type Executor, realmMembers, realmModules, type Tx } from "@akashic/db";

// Query helpers the realm service shares between its methods.

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
