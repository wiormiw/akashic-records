import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { auditEntries, createDb, outboxMessages, realmMembers, realms, user } from "@akashic/db";
import { RealmRole } from "@akashic/lib/enums";
import { silentLogger } from "@akashic/lib/log";
import { realmApp } from "./app.ts";
import { databaseUrl, uniqueSlug } from "../../support/fixtures.ts";

// Two demotions at once need two connections, so this can't run inside one rolled-back
// transaction: it commits its own uniquely named rows and deletes exactly those afterwards.

const database = createDb({
  url: databaseUrl,
  poolMax: 8,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)("two admins demoting each other at once", () => {
  test("exactly one succeeds, so the realm keeps an admin", async () => {
    const { db } = database;
    const tag = Bun.randomUUIDv7();
    const [first, second] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    const slug = uniqueSlug("role-race");
    let realmId: string | undefined;
    try {
      await db.insert(user).values([
        { id: first, name: "First", email: `role-race-first-${tag}@example.test` },
        { id: second, name: "Second", email: `role-race-second-${tag}@example.test` },
      ]);
      const [realm] = await db
        .insert(realms)
        .values({ slug, name: "Role race", createdBy: first })
        .returning({ id: realms.id });
      realmId = realm!.id;
      await db.insert(realmMembers).values([
        { realmId, userId: first, role: RealmRole.admin },
        { realmId, userId: second, role: RealmRole.admin },
      ]);

      const { call, grants } = realmApp(db);
      grants.realm.set(first, new Set(["can_vouch"]));
      grants.realm.set(second, new Set(["can_vouch"]));
      const answers = await Promise.all([
        call("PATCH", `/api/v1/realms/${slug}/members/${second}`, {
          as: first,
          body: { role: RealmRole.member },
        }),
        call("PATCH", `/api/v1/realms/${slug}/members/${first}`, {
          as: second,
          body: { role: RealmRole.member },
        }),
      ]);

      expect(answers.map((a) => a.status).sort()).toEqual([200, 403]);
      const admins = await db
        .select({ userId: realmMembers.userId })
        .from(realmMembers)
        .where(and(eq(realmMembers.realmId, realmId), eq(realmMembers.role, RealmRole.admin)));
      expect(admins).toHaveLength(1);
    } finally {
      if (realmId) {
        await db
          .delete(outboxMessages)
          .where(sql`${outboxMessages.payload}->>'realmId' = ${realmId}`);
        // Members cascade from the realm.
        await db.delete(realms).where(eq(realms.id, realmId));
      }
      await db.delete(auditEntries).where(sql`${auditEntries.userId} IN (${first}, ${second})`);
      await db.delete(user).where(sql`${user.id} IN (${first}, ${second})`);
    }
  });
});
