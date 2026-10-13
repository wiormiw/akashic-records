import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";
import { problemHandler } from "@/http/problem.ts";
import { healthRoutes, metaRoutes } from "@/http/meta.ts";
import type { AppEnv } from "@/http/env.ts";
import type { Auth } from "@/auth/auth.ts";
import { authRoutes } from "@/http/auth-routes.ts";
import { createMemoryCounters } from "@/integrations/counters.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";

describe("health", () => {
  const build = (ready: boolean, required = true, optional = true) => {
    const lifecycle = createLifecycle(silentLogger());
    if (ready) lifecycle.markReady();
    return new Hono<AppEnv>().route(
      "/",
      healthRoutes({
        lifecycle,
        required: { db: async () => required },
        optional: { redis: async () => optional },
      }),
    );
  };

  test("livez is ok while the process runs", async () => {
    const res = await build(true).request("/livez");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("readyz: draining, degraded, ready-degraded, ready", async () => {
    const draining = await build(false).request("/readyz");
    expect(draining.status).toBe(503);
    expect(await draining.json()).toEqual({ status: "draining" });
    const degraded = await build(true, false).request("/readyz");
    expect(degraded.status).toBe(503);
    expect(await degraded.json()).toEqual({ status: "degraded", db: false, redis: true });
    expect(await (await build(true, true, false).request("/readyz")).json()).toEqual({
      status: "ready-degraded",
      db: true,
      redis: false,
    });
    expect(await (await build(true).request("/readyz")).json()).toEqual({
      status: "ready",
      db: true,
      redis: true,
    });
  });
});

describe("meta", () => {
  const mailer = {
    send: async () => {},
    health: () => ({
      configured: true,
      healthy: false,
      lastFailure: "boom",
      failedAt: Temporal.Instant.from("2026-01-01T00:00:00Z"),
    }),
  };
  const app = new Hono<AppEnv>().route("/", metaRoutes({ service: "akashic", mailer }));

  test("/mail-status serialises the instant", async () => {
    expect(await (await app.request("/mail-status")).json()).toEqual({
      configured: true,
      healthy: false,
      lastFailure: "boom",
      failedAt: "2026-01-01T00:00:00Z",
    });
  });

  test("/ describes the API", async () => {
    const body = (await (await app.request("/")).json()) as { service: string; api: string };
    expect(body.service).toBe("akashic");
    expect(body.api).toBe("/api/v1");
  });
});

describe("auth routes", () => {
  const build = (credentialsLimit: number) => {
    const auth = {
      handler: async (r: Request) => new Response(new URL(r.url).pathname),
    } as unknown as Auth;
    const routes = authRoutes({
      auth,
      limiter: createRateLimiter({ counters: createMemoryCounters() }),
      ordinary: { limit: 100, windowSeconds: 60, bucket: "o" },
      credentials: { limit: credentialsLimit, windowSeconds: 60, bucket: "c" },
      trustProxy: false,
      logger: silentLogger(),
    });
    return new Hono<AppEnv>().route("/", routes).onError(problemHandler(silentLogger()));
  };

  test("hands /api/auth/* to better-auth with the full path", async () => {
    const res = await build(5).request("/api/auth/get-session");
    expect(await res.text()).toBe("/api/auth/get-session");
  });

  test("credential paths get the tighter budget, other paths don't", async () => {
    const app = build(1);
    const post = () => app.request("/api/auth/sign-in/email", { method: "POST" });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    expect((await app.request("/api/auth/get-session")).status).toBe(200);
  });
});
