import { expect, test } from "bun:test";
import { listen, stop } from "@/runtime.ts";

test("shutdown drains, then aborts, then releases, then stops", async () => {
  const steps: string[] = [];
  await stop({
    reason: "SIGTERM",
    drainMs: 1000,
    server: { stop: async (force) => void steps.push(force ? "force-close" : "stop-accepting") },
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: {
      beginDraining: () => steps.push("draining"),
      abort: () => steps.push("abort"),
      markStopped: () => steps.push("stopped"),
    },
  });
  expect(steps).toEqual(["draining", "stop-accepting", "abort", "dispose", "stopped"]);
});

test("in-flight work past the drain window is cut off before release", async () => {
  const steps: string[] = [];
  await stop({
    reason: "SIGTERM",
    drainMs: 10,
    server: {
      stop: (force) =>
        force ? (steps.push("force-close"), Promise.resolve()) : new Promise<void>(() => {}),
    },
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: { beginDraining: () => {}, abort: () => steps.push("abort"), markStopped: () => {} },
  });
  expect(steps).toEqual(["force-close", "abort", "dispose"]);
});

test("the lifecycle is marked stopped even when release fails", async () => {
  const steps: string[] = [];
  const failed = stop({
    reason: "SIGTERM",
    drainMs: 1000,
    server: { stop: async () => {} },
    container: {
      dispose: async () => {
        throw new Error("pool would not close");
      },
    },
    lifecycle: {
      beginDraining: () => {},
      abort: () => {},
      markStopped: () => steps.push("stopped"),
    },
  });
  await expect(failed).rejects.toThrow("pool would not close");
  expect(steps).toEqual(["stopped"]);
});

test("a server that cannot listen releases the graph before the error propagates", async () => {
  const steps: string[] = [];
  const failed = listen({
    serve: () => {
      throw new Error("EADDRINUSE");
    },
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: { abort: () => steps.push("abort") },
  });
  await expect(failed).rejects.toThrow("EADDRINUSE");
  expect(steps).toEqual(["abort", "dispose"]);
});

test("a server that listens is handed back, and nothing is released", async () => {
  const steps: string[] = [];
  const server = await listen({
    serve: () => "server",
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: { abort: () => steps.push("abort") },
  });
  expect(server).toBe("server");
  expect(steps).toEqual([]);
});
