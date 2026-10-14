import { and, eq, sql } from "drizzle-orm";
import { outboxMessages, type Tx, user } from "@akashic/db";
import { fixedClock } from "@akashic/lib/time";

// What every module's tests share. A module's own `world()` stays beside its tests.

export const databaseUrl =
  Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";

export const clock = fixedClock("2026-06-01T12:00:00Z");

/** A fresh, verified account. */
export async function person(tx: Tx, name = "Member"): Promise<string> {
  const id = Bun.randomUUIDv7();
  await tx.insert(user).values({ id, name, email: `${id}@example.test`, emailVerified: true });
  return id;
}

export const uniqueSlug = (prefix = "t") => `${prefix}-${Bun.randomUUIDv7().slice(-12)}`;

/** The outbox rows of `type` about `realmId`. */
export async function outbox(tx: Tx, type: string, realmId: string) {
  return tx
    .select({ payload: outboxMessages.payload })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.messageType, type),
        sql`${outboxMessages.payload}->>'realmId' = ${realmId}`,
      ),
    );
}
