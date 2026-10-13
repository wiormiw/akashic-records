import { afterAll, describe, expect, test } from "bun:test";
import { silentLogger } from "@akashic/lib/log";
import { createDb } from "@akashic/db";

const url = Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic";
const database = createDb({
  url,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)("database", () => {
  test("statement timeout is enforced by Postgres", async () => {
    const limited = createDb({
      url,
      poolMax: 1,
      idleTimeoutS: 5,
      connectTimeoutS: 2,
      logger: silentLogger(),
      limits: { statementTimeoutMs: 50, lockTimeoutMs: 50, idleInTransactionTimeoutMs: 1000 },
    });
    try {
      // Bun SQL queries are lazy thenables; `expect().rejects` on one spins forever, so wrap it.
      await expect(Promise.resolve(limited.sql`SELECT pg_sleep(1)`)).rejects.toThrow(
        /statement timeout/,
      );
    } finally {
      await limited[Symbol.asyncDispose]();
    }
  });
});
