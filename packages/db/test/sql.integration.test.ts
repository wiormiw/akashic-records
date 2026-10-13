import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createDb } from "@akashic/db";
import { pgArray } from "../src/sql.ts";
import { silentLogger } from "@akashic/lib/log";

// Pins why pgArray() exists (CLAUDE.md trap 2): Drizzle on bun:sql expands a bound JS array into a
// parameter list. If a Drizzle upgrade changes that, the first test here fails and the rule can
// be revisited. Reads only; touches no rows. Skips when nothing answers at DATABASE_URL.

const database = createDb({
  url: Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic",
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)("array binds", () => {
  test("a JS array bound directly is expanded into a parameter list, not one array", async () => {
    const values = ["a", "b", "c"];
    // `($1, $2, $3)::text[]` is a row cast, which Postgres refuses; one array parameter would
    // have worked.
    await expect(
      Promise.resolve(database.db.execute(sql`SELECT ${values}::text[] AS got`)),
    ).rejects.toThrow(/\(\$1, \$2, \$3\)::text\[\]/);
  });

  test("pgArray() is one text parameter that casts to a real array", async () => {
    const rows = await database.db.execute<{ got: string[]; size: number }>(
      sql`SELECT ${pgArray(["a", 'b"q', "c,d"])}::text[] AS got, cardinality(${pgArray(["a", "b"])}::text[]) AS size`,
    );
    expect(rows[0]).toEqual({ got: ["a", 'b"q', "c,d"], size: 2 });
  });
});
