import type { Db, Tx } from "./client.ts";

const ROLLBACK = Symbol("rollback");

/** Runs `work` in a transaction that is always rolled back: a test's writes never persist. */
export async function withRollback(db: Db, work: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await work(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}
