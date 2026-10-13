import { expect, test } from "bun:test";
import { boundedFlush } from "@akashic/lib/telemetry";

test("a flush that hangs is abandoned at the timeout", async () => {
  const startedAt = performance.now();
  await boundedFlush(() => new Promise<void>(() => {}), 20);
  expect(performance.now() - startedAt).toBeLessThan(1000);
});

test("a flush that fails is swallowed", async () => {
  await boundedFlush(() => Promise.reject(new Error("collector down")), 1000);
});

test("a flush that finishes is waited for", async () => {
  let flushed = false;
  await boundedFlush(async () => {
    await Bun.sleep(5);
    flushed = true;
  }, 1000);
  expect(flushed).toBe(true);
});
