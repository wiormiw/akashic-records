import { fileURLToPath } from "node:url";

export * from "./schema/index.ts";
export * as schema from "./schema/index.ts";
export { relations } from "./relations.ts";
export {
  createDb,
  type Database,
  type DatabaseOptions,
  type Db,
  type Executor,
  type Tx,
} from "./client.ts";

/** Where drizzle-kit writes migrations and the migrator reads them. */
export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
