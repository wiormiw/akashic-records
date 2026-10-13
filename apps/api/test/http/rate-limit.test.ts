import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { silentLogger, type Logger } from "@akashic/lib/log";
import type { AppEnv } from "@/http/env.ts";
import { problemHandler } from "@/http/problem.ts";
import { rateLimit } from "@/http/rate-limit.ts";
import { createMemoryCounters } from "@/integrations/counters.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";

const rule = { limit: 2, windowSeconds: 60, bucket: "t" };

const build = (logger?: Logger) => {
  const limiter = createRateLimiter({ counters: createMemoryCounters() });
  const app = new Hono<AppEnv>()
    .use(async (c, next) => {
      c.set("requestId", "r");
      const id = c.req.header("x-test-user");
      c.set("user", id ? { id, email: `${id}@x.test` } : null);
      await next();
    })
    .use(rateLimit(limiter, rule, { trustProxy: false, ...(logger ? { logger } : {}) }))
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
    const warned: Record<string, unknown>[] = [];
    const logger = {
      child: () => logger,
      warn: (line: Record<string, unknown>) => void warned.push(line),
    } as unknown as Logger;
    const app = build(logger);
    for (let i = 0; i < 3; i++) await app.request("/");
    expect(warned[0]).toMatchObject({ bucket: "t", count: 3 });
  });
});
