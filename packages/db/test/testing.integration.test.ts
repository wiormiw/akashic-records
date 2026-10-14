import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { AuditAction } from "@akashic/lib/enums";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { silentLogger } from "@akashic/lib/log";
import { err, ok } from "@akashic/lib/result";
import { audit, auditEntries, createDb, inTransaction } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";

const url = Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";
const database = createDb({
  url,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();

describe.skipIf(!live)("withRollback", () => {
  test("what a test writes is gone afterwards, and inTransaction nests as a savepoint", async () => {
    const entityId = Bun.randomUUIDv7();
    await withRollback(database.db, async (tx) => {
      const inner = await inTransaction(tx, async (t) => {
        await audit(t, {
          actorId: null,
          entityType: "test",
          entityId,
          action: AuditAction.created,
        });
        return err(fail.conflict(ErrorCode.realm.duplicateSlug, "x"));
      });
      expect(inner.ok).toBe(false);
      // The savepoint rolled back the inner write; the outer transaction is still usable.
      expect(
        await tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId)),
      ).toEqual([]);
      await inTransaction(tx, async (t) => {
        await audit(t, {
          actorId: null,
          entityType: "test",
          entityId,
          action: AuditAction.created,
        });
        return ok(undefined);
      });
      expect(
        (await tx.select().from(auditEntries).where(eq(auditEntries.entityId, entityId))).length,
      ).toBe(1);
    });
    expect(
      await database.db.select().from(auditEntries).where(eq(auditEntries.entityId, entityId)),
    ).toEqual([]);
    await database[Symbol.asyncDispose]();
  });
});
