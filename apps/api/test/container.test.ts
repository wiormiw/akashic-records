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
});
