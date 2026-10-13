import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Authorizer } from "@akashic/authz";
import type { Db } from "@akashic/db";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";
import { createApp, type ApiEnv } from "@/app.ts";
import type { Auth } from "@/auth/auth.ts";
import { buildContainer } from "@/container.ts";
import type { AppEnv } from "@/http/env.ts";
import { createMemoryCounters } from "@/integrations/counters.ts";
import type { Mailer } from "@/integrations/mail.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";
import { testEnv } from "./env.ts";

// Only scopes are opened on it; nothing that connects is ever resolved.
const container = buildContainer(testEnv());
afterAll(() => container.dispose());

const rule = { limit: 100, windowSeconds: 60 };

let sessionLookups = 0;

const build = (session: { user: { id: string; email: string } } | null) => {
  const lifecycle = createLifecycle(silentLogger());
  lifecycle.markReady();
  return createApp({
    container,
    logger: silentLogger(),
    lifecycle,
    auth: {
      api: {
        getSession: async () => {
          sessionLookups += 1;
          return session;
        },
      },
    } as unknown as Auth,
    // The ban lookup finds no row: nobody is suspended.
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Db,
    authorizer: { check: async () => false } as unknown as Authorizer,
    mailer: {
      send: async () => {},
      health: () => ({ configured: false, healthy: false, lastFailure: null, failedAt: null }),
    } satisfies Mailer,
    limiter: createRateLimiter({ counters: createMemoryCounters() }),
    limits: {
      api: { ...rule, bucket: "api" },
      auth: { ...rule, bucket: "auth-read" },
      credentials: { ...rule, bucket: "auth" },
    },
    allowedOrigins: [],
    maxBodyBytes: 1024 * 1024,
    budgetMs: 5000,
    trustProxy: false,
    checks: { required: { database: async () => true }, optional: {} },
    modules: [
      {
        private: new Hono<ApiEnv>().get("/whoami", (c) => {
          const request = c.var.di.get("request");
          return c.text(`${request.id} ${request.user?.id}`);
        }),
        public: new Hono<ApiEnv>().get("/whoami", (c) =>
          c.text(String(c.var.di.get("request").user)),
        ),
        root: new Hono<AppEnv>().get("/socket", (c) => c.text("root")),
      },
    ],
  });
};

describe("app", () => {
  test("liveness and readiness", async () => {
    const app = build(null);
    expect((await app.request("/livez")).status).toBe(200);
    const ready = await app.request("/readyz");
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready", database: true });
  });

  test("a private route without a session is 401", async () => {
    const res = await build(null).request("/api/v1/whoami");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("auth.session.unauthenticated");
  });

  test("a private route resolves the request scope, caller included", async () => {
    const res = await build({ user: { id: "u1", email: "u1@x.test" } }).request("/api/v1/whoami", {
      headers: { "x-request-id": "req-1" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("req-1 u1");
  });

  test("an unknown route is the not-found problem, and carries a request id", async () => {
    const res = await build(null).request("/nope");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("common.route.not_found");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("a public route sees a visitor, without looking up a session", async () => {
    const app = build({ user: { id: "u1", email: "u1@x.test" } });
    sessionLookups = 0;
    const res = await app.request("/api/public/v1/whoami");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("null");
    expect(sessionLookups).toBe(0);
  });

  test("a module's root routes are mounted at the app root", async () => {
    const res = await build(null).request("/socket");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("root");
  });
});
