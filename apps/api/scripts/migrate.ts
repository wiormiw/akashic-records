import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as v from "valibot";
import { migrationsFolder } from "@akashic/db";
import { loadEnv, url } from "@akashic/lib/config";

// Needs only the database URL, so it can run as a release step without the app's secrets.
if (import.meta.main) {
  const env = loadEnv(v.object({ DATABASE_URL: url() }), Bun.env);
  const client = new SQL({ url: env.DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle({ client }), { migrationsFolder });
    console.log("migrations applied");
  } finally {
    await client.close();
  }
}
