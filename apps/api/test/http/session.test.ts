import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Authorizer } from "@akashic/authz";
import type { Db } from "@akashic/db";
import { silentLogger } from "@akashic/lib/log";
import type { Auth } from "@/auth/auth.ts";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { sessions } from "@/http/session.ts";

const signedIn = { user: { id: "u1", email: "u1@x.test" } };

// The ban lookup answers with these rows; none means not suspended.
const fakeDb = (rows: unknown[]) => ({
  select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
});

const build = (session: typeof signedIn | null, allowed = true, banRows: unknown[] = []) => {
  const auth = { api: { getSession: async () => session } } as unknown as Auth;
  const authorizer = { check: async () => allowed } as unknown as Authorizer;
  const {
    session: required,
    maybeSession,
    platformAdmin,
  } = sessions({
    auth,
    db: fakeDb(banRows) as unknown as Db,
    authorizer,
  });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("requestId", "r");
      c.set("signal", new AbortController().signal);
      c.set("user", null);
      await next();
    })
    .get("/private", required, (c) => c.json({ user: c.get("user") }))
    .get("/either", maybeSession, (c) => c.json({ user: c.get("user") }))
    .get("/admin", platformAdmin, (c) => c.json({ user: c.get("user") }));
  app.onError(problemHandler(silentLogger()));
  return app;
};

describe("sessions", () => {
  test("session: 401 when signed out, the caller when signed in", async () => {
    const out = await build(null).request("/private");
    expect(out.status).toBe(401);
    expect(((await out.json()) as { code: string }).code).toBe("auth.session.unauthenticated");
    const inn = await build(signedIn).request("/private");
    expect(await inn.json()).toEqual({ user: { id: "u1", email: "u1@x.test" } });
  });

  test("maybeSession: a visitor is user null", async () => {
    const res = await build(null).request("/either");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  test("platformAdmin: 404 when the check is false, the caller when true", async () => {
    expect((await build(signedIn, false).request("/admin")).status).toBe(404);
    expect((await build(signedIn, true).request("/admin")).status).toBe(200);
  });

  test("a suspended account is refused with 403", async () => {
    const banned = [{ bannedAt: new Date(), reason: "x", until: null }];
    const res = await build(signedIn, true, banned).request("/private");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("auth.account.suspended");
  });
});
