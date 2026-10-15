import { Hono, type MiddlewareHandler } from "hono";
import type { Authorizer, Check } from "@akashic/authz";
import type { Db, Executor } from "@akashic/db";
import { silentLogger } from "@akashic/lib/log";
import type { Auth } from "@/auth/auth.ts";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { type RealmEnv, realmContext } from "@/http/realm-context.ts";
import { type Sessions, sessions } from "@/http/session.ts";
import type { ModuleRoutes } from "@/modules/module.ts";

/** Who may do what: platform admins, each caller's relations in any realm, and on objects. */
export interface Grants {
  platform: Set<string>;
  realm: Map<string, Set<string>>;
  /** Per caller, `type:objectId#relation` keys, as `grantOn` writes them. */
  objects?: Map<string, Set<string>>;
}

const objectKey = (type: string, objectId: string, relation: string) =>
  `${type}:${objectId}#${relation}`;

/** What a module's route factory is given to build its routes from. */
export interface Kit {
  sessions: Sessions;
  realmContext: MiddlewareHandler<RealmEnv>;
  /** The fake authorizer, for routes that check a relation on an object (`requireOn`). */
  authorizer: Authorizer;
}

/**
 * A module's routes mounted as app.ts mounts them, on `db`. The caller is whoever the x-user
 * header names (no header, no session); the authorizer answers from `grants` and records what it
 * was asked in `checks`.
 */
export function testApp(
  db: Executor,
  options: { routes: (kit: Kit) => ModuleRoutes; grants?: Grants },
) {
  const grants: Grants = options.grants ?? { platform: new Set(), realm: new Map() };
  const checks: Check[][] = [];
  const authorizer = {
    check: async (check: Check) =>
      grants.platform.has(check.userId) ||
      (grants.objects
        ?.get(check.userId)
        ?.has(objectKey(check.type, check.objectId, check.relation)) ??
        false),
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
  const routes = options.routes({
    sessions: kit,
    realmContext: realmContext({ db, authorizer }),
    authorizer,
  });
  const app = new Hono<AppEnv>().use(async (c, next) => {
    c.set("requestId", "test");
    c.set("signal", new AbortController().signal);
    await next();
  });
  if (routes.public) app.route("/api/public/v1", routes.public);
  if (routes.private) {
    app.route("/api/v1", new Hono<AppEnv>().use(kit.session).route("/", routes.private));
  }
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

  /** Lets `userId` have `relation` on one object, as `requireOn` asks it. */
  function grantOn(userId: string, relation: string, type: string, objectId: string) {
    grants.objects ??= new Map();
    const held = grants.objects.get(userId) ?? new Set<string>();
    held.add(objectKey(type, objectId, relation));
    grants.objects.set(userId, held);
  }

  return { call, grant, grantOn, grants, checks };
}
