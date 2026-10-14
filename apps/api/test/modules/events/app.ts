import { Hono } from "hono";
import type { Authorizer, Check } from "@akashic/authz";
import type { Db, Executor } from "@akashic/db";
import { silentLogger } from "@akashic/lib/log";
import type { Auth } from "@/auth/auth.ts";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { realmContext } from "@/http/realm-context.ts";
import { sessions } from "@/http/session.ts";
import { createEventsRoutes } from "@/modules/events/events.routes.ts";
import { createEventService } from "@/modules/events/events.service.ts";
import { clock } from "./fixtures.ts";

/** Each caller's relations in any realm: what the authorizer answers. */
export interface Grants {
  realm: Map<string, Set<string>>;
}

/**
 * The events routes mounted as app.ts mounts them, on `db`. The caller is whoever the x-user
 * header names (no header, no session); the authorizer answers from `grants`.
 */
export function eventsApp(db: Executor) {
  const grants: Grants = { realm: new Map() };
  const authorizer = {
    check: async () => false,
    checkMany: async (asked: readonly Check[]) =>
      asked.map((check) => grants.realm.get(check.userId)?.has(check.relation) ?? false),
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
  const routes = createEventsRoutes({
    events: createEventService({ db, clock }),
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

  /** Lets `userId` do `relations` in every realm. */
  const grant = (userId: string, ...relations: string[]) =>
    grants.realm.set(userId, new Set(relations));

  return { call, grant };
}
