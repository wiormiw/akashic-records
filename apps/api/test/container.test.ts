import { describe, expect, test } from "bun:test";
import { buildContainer } from "@/container.ts";
import { testEnv } from "./env.ts";

describe("container", () => {
  test("overrides are the test's: the container never releases them", async () => {
    const released: string[] = [];
    const tracked = (name: string) => ({
      async [Symbol.asyncDispose]() {
        released.push(name);
      },
    });
    const c = buildContainer(testEnv())
      .override("telemetry", tracked("telemetry") as never)
      .override(
        "database",
        Object.assign(tracked("database"), {
          db: {} as never,
          sql: {} as never,
          ping: async () => true,
        }) as never,
      );
    await c.getAsync("telemetry");
    await c.getAsync("database");
    await c.dispose();
    expect(released).toEqual([]);
  });

  test("releases what it built in reverse order of creation", async () => {
    const c = buildContainer(testEnv({ REDIS_URL: "" }));
    c.get("logger");
    c.get("lifecycle");
    const redis = await c.getAsync("redis");
    const counters = await c.getAsync("counters");
    const order: string[] = [];
    const spy = (name: string, target: object) => {
      const original = (target as AsyncDisposable)[Symbol.asyncDispose].bind(target);
      Object.assign(target, {
        [Symbol.asyncDispose]: async () => {
          order.push(name);
          await original();
        },
      });
    };
    spy("redis", redis);
    spy("counters", counters);
    await c.dispose();
    expect(order).toEqual(["counters", "redis"]);
  });

  test("the retention sweep runs hourly over the room services, and disposal clears its timer", async () => {
    let swept = 0;
    const rooms = { moderation: { sweepExpired: async () => ++swept } };
    const c = buildContainer(testEnv()).override("rooms", rooms as never);
    const started: unknown[] = [];
    const cleared: unknown[] = [];
    const { setInterval: realSet, clearInterval: realClear } = globalThis;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const timer = realSet(fn, ms);
      started.push([timer, ms]);
      return timer;
    }) as typeof setInterval;
    globalThis.clearInterval = ((timer: Timer) => {
      cleared.push(timer);
      realClear(timer);
    }) as typeof clearInterval;
    try {
      const sweep = await c.getAsync("retentionSweep");
      expect(started).toHaveLength(1);
      const [timer, ms] = started[0] as [Timer, number];
      expect(ms).toBe(60 * 60 * 1000);
      await sweep.sweep();
      expect(swept).toBe(1);
      await c.dispose();
      expect(cleared).toContain(timer);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
