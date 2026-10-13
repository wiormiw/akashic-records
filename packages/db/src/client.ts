import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Logger } from "@akashic/lib/log";
import { relations } from "./relations.ts";

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  idleTimeoutS: number;
  connectTimeoutS: number;
  /**
   * Server-side limits, set on every connection. Postgres cancels the statement and frees the
   * connection. Omitted for scripts, which may legitimately run long.
   */
  limits?: {
    statementTimeoutMs: number;
    lockTimeoutMs: number;
    idleInTransactionTimeoutMs: number;
  };
  logger: Logger;
}

const connect = (sql: SQL) => drizzle({ client: sql, relations });

export type Db = ReturnType<typeof connect>;
/** Drizzle's transaction handle. Outbox events and audit entries take only this. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** The pool or an open transaction. */
export type Executor = Db | Tx;

export interface Database extends AsyncDisposable {
  db: Db;
  sql: SQL;
  /** Proves the connection works. It does not prove the schema is migrated. */
  ping(): Promise<boolean>;
}

/** Opens a pool. Nothing connects until the first query; `ping` at startup fails fast. */
export function createDb(options: DatabaseOptions): Database {
  const log = options.logger.child({ component: "db" });
  const sql = new SQL({
    url: options.url,
    max: options.poolMax,
    // Infrastructure closes idle connections without telling the client; recycle first.
    idleTimeout: options.idleTimeoutS,
    maxLifetime: 60 * 30,
    connectionTimeout: options.connectTimeoutS,
    ...(options.limits && {
      connection: {
        statement_timeout: options.limits.statementTimeoutMs,
        lock_timeout: options.limits.lockTimeoutMs,
        idle_in_transaction_session_timeout: options.limits.idleInTransactionTimeoutMs,
      },
    }),
  });

  return {
    db: connect(sql),
    sql,
    async ping() {
      try {
        await sql`SELECT 1`;
        return true;
      } catch (error) {
        log.error({ err: error }, "database ping failed");
        return false;
      }
    },
    async [Symbol.asyncDispose]() {
      await sql.close({ timeout: 5 });
      log.info("connection pool closed");
    },
  };
}
