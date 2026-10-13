import { describe, expect, test } from "bun:test";
import { createMemoryCounters } from "@/integrations/counters.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";

describe("memory counters", () => {
  const rule = { limit: 2, windowSeconds: 60, bucket: "test" };

  test("count within a window and roll over after it", async () => {
    await using counters = createMemoryCounters();
    const limiter = createRateLimiter({ counters });
    const t0 = Temporal.Instant.from("2026-01-01T00:00:00Z");

    expect((await limiter.hit(rule, "ip:1", t0))?.count).toBe(1);
    expect((await limiter.hit(rule, "ip:1", t0.add({ seconds: 30 })))?.resetSeconds).toBe(30);
    expect((await limiter.hit(rule, "ip:1", t0.add({ seconds: 61 })))?.count).toBe(1);
  });

  test("an aborted signal or disposal stops the sweep", async () => {
    const controller = new AbortController();
    const counters = createMemoryCounters({ signal: controller.signal });
    controller.abort();
    await counters[Symbol.asyncDispose]();
    await counters[Symbol.asyncDispose]();
  });
});
