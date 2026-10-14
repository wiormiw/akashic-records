import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { captureLogger } from "@akashic/lib/testing";
import { silentLogger, type Logger } from "@akashic/lib/log";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { rateLimit } from "@/http/rate-limit.ts";
import { createMemoryCounters } from "@/integrations/counters.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";

const rule = { limit: 2, windowSeconds: 60, bucket: "t" };

const build = (logger: Logger = silentLogger(), trustProxy = false) => {
  const limiter = createRateLimiter({ counters: createMemoryCounters() });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("requestId", "r");
      const id = c.req.header("x-test-user");
      c.set("user", id ? { id, email: `${id}@x.test` } : null);
      await next();
    })
    .use(rateLimit(limiter, rule, { trustProxy, logger }))
    .get("/", (c) => c.text("ok"));
  app.onError(problemHandler(silentLogger()));
  return app;
};

describe("rate limit", () => {
  test("the third request in the window is 429 with retry-after", async () => {
    const app = build();
    expect((await app.request("/")).status).toBe(200);
    const second = await app.request("/");
    expect(second.status).toBe(200);
    expect(second.headers.get("ratelimit-remaining")).toBe("0");
    const third = await app.request("/");
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBeTruthy();
    expect(((await third.json()) as { code: string }).code).toBe("common.request.rate_limited");
  });

  test("a signed-in user is counted apart from the IP", async () => {
    const app = build();
    for (let i = 0; i < 3; i++) await app.request("/");
    expect((await app.request("/")).status).toBe(429);
    expect((await app.request("/", { headers: { "x-test-user": "u1" } })).status).toBe(200);
  });

  test("a refusal is logged with its bucket and count", async () => {
    const { logger, lines: warned } = captureLogger();
    const app = build(logger);
    for (let i = 0; i < 3; i++) await app.request("/");
    expect(warned[0]).toMatchObject({ msg: "rate limit exceeded", bucket: "t", count: 3 });
  });

  test("spoofed proxy headers are ignored when no proxy is trusted: one bucket", async () => {
    const app = build();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/", {
        headers: { "x-real-ip": `10.0.0.${i}`, "x-forwarded-for": `10.1.0.${i}` },
      });
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test("with a trusted proxy the right-most forwarded hop is the key", async () => {
    const app = build(silentLogger(), true);
    const hit = async (xff: string) =>
      (await app.request("/", { headers: { "x-forwarded-for": xff } })).status;
    // The left entries are the client's to forge; only the last hop is ours.
    expect(await hit("1.1.1.1, 9.9.9.9")).toBe(200);
    expect(await hit("2.2.2.2, 9.9.9.9")).toBe(200);
    expect(await hit("3.3.3.3, 9.9.9.9")).toBe(429);
    expect(await hit("3.3.3.3, 8.8.8.8")).toBe(200);
  });

  test("with a trusted proxy x-real-ip is the fallback when there is no forwarded chain", async () => {
    const app = build(silentLogger(), true);
    const hit = async (ip: string) =>
      (await app.request("/", { headers: { "x-real-ip": ip } })).status;
    expect(await hit("5.5.5.5")).toBe(200);
    expect(await hit("5.5.5.5")).toBe(200);
    expect(await hit("5.5.5.5")).toBe(429);
    expect(await hit("6.6.6.6")).toBe(200);
  });
});
