import { Hono } from "hono";
import type { Authorizer, Check } from "@akashic/authz";
import type { Db, Executor } from "@akashic/db";
import { silentLogger } from "@akashic/lib/log";
import type { Auth } from "@/auth/auth.ts";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { realmContext } from "@/http/realm-context.ts";
import { sessions } from "@/http/session.ts";
import { createRealmRoutes } from "@/modules/realm/realm.routes.ts";
import { createRealmService } from "@/modules/realm/realm.service.ts";
import { clock, noEmbedder } from "./fixtures.ts";

/** Who may do what: platform admins, and each caller's relations in any realm. */
export interface Grants {
  platform: Set<string>;
  realm: Map<string, Set<string>>;
}

/**
 * The realm routes mounted as app.ts mounts them, on `db`. The caller is whoever the x-user header
 * names (no header, no session); the authorizer answers from `grants`.
 */
export function realmApp(db: Executor) {
  const grants: Grants = { platform: new Set(), realm: new Map() };
  const checks: Check[][] = [];
  const authorizer = {
    check: async (check: Check) => grants.platform.has(check.userId),
    checkMany: async (asked: readonly Check[]) => {
      checks.push([...asked]);
      return asked.map((check) => grants.realm.get(check.userId)?.has(check.relation) ?? false);
    },
  } as unknown as Authorizer;
  const auth = {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-user");
        return id ? { user: { id, email: `${id}@example.test` } } : null;
      },
    },
  } as unknown as Auth;

  const kit = sessions({ auth, db: db as Db, authorizer });
  const routes = createRealmRoutes({
    realms: createRealmService({ db, embedder: noEmbedder, clock }),
    sessions: kit,
    realmContext: realmContext({ db, authorizer }),
  });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("requestId", "test");
      c.set("signal", new AbortController().signal);
      await next();
    })
    .route("/api/public/v1", routes.public!)
    .route("/api/v1", new Hono<AppEnv>().use(kit.session).route("/", routes.private!));
  app.onError(problemHandler(silentLogger()));

  async function call(
    method: string,
    path: string,
    options: { as?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = {};
    if (options.as) headers["x-user"] = options.as;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await app.request(path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    return { status: response.status, body: await response.json() };
  }

  return { call, grants, checks };
}
