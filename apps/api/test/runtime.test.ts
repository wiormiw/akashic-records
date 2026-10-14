import { expect, test } from "bun:test";
import { listen, releaseAll, stop } from "@/runtime.ts";

const consumers = (steps: string[]): AsyncDisposable => ({
  async [Symbol.asyncDispose]() {
    steps.push("consumers");
  },
});

test("shutdown drains, aborts, stops the consumers, releases, then stops", async () => {
  const steps: string[] = [];
  await stop({
    reason: "SIGTERM",
    drainMs: 1000,
    server: { stop: async (force) => void steps.push(force ? "force-close" : "stop-accepting") },
    consumers: consumers(steps),
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: {
      beginDraining: () => steps.push("draining"),
      abort: () => steps.push("abort"),
      markStopped: () => steps.push("stopped"),
    },
  });
  expect(steps).toEqual(["draining", "stop-accepting", "abort", "consumers", "dispose", "stopped"]);
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
    consumers: consumers(steps),
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: { beginDraining: () => {}, abort: () => steps.push("abort"), markStopped: () => {} },
  });
  expect(steps).toEqual(["force-close", "abort", "consumers", "dispose"]);
});

test("the lifecycle is marked stopped even when release fails", async () => {
  const steps: string[] = [];
  const failed = stop({
    reason: "SIGTERM",
    drainMs: 1000,
    server: { stop: async () => {} },
    consumers: consumers([]),
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

test("a server that cannot listen stops the consumers and releases the graph before the error propagates", async () => {
  const steps: string[] = [];
  const failed = listen({
    serve: () => {
      throw new Error("EADDRINUSE");
    },
    consumers: consumers(steps),
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: { abort: () => steps.push("abort") },
  });
  await expect(failed).rejects.toThrow("EADDRINUSE");
  expect(steps).toEqual(["abort", "consumers", "dispose"]);
});

test("a server that listens is handed back, and nothing is released", async () => {
  const steps: string[] = [];
  const server = await listen({
    serve: () => "server",
    consumers: consumers(steps),
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: { abort: () => steps.push("abort") },
  });
  expect(server).toBe("server");
  expect(steps).toEqual([]);
});

test("the container is released even when stopping a consumer fails", async () => {
  const steps: string[] = [];
  const failed = stop({
    reason: "SIGTERM",
    drainMs: 1000,
    server: { stop: async () => {} },
    consumers: {
      async [Symbol.asyncDispose]() {
        throw new Error("channel closed");
      },
    },
    container: { dispose: async () => void steps.push("dispose") },
    lifecycle: {
      beginDraining: () => {},
      abort: () => {},
      markStopped: () => steps.push("stopped"),
    },
  });
  await expect(failed).rejects.toThrow("channel closed");
  expect(steps).toEqual(["dispose", "stopped"]);
});

const disposable = (steps: string[], name: string, fails = false): AsyncDisposable => ({
  async [Symbol.asyncDispose]() {
    steps.push(name);
    if (fails) throw new Error(`${name} would not close`);
  },
});

test("releasing consumers stops every one, in reverse, even past a failure", async () => {
  const steps: string[] = [];
  const all = releaseAll([
    disposable(steps, "a"),
    disposable(steps, "b", true),
    disposable(steps, "c"),
  ]);
  await expect(all[Symbol.asyncDispose]()).rejects.toThrow("b would not close");
  expect(steps).toEqual(["c", "b", "a"]);
});

test("several failures to release are reported together", async () => {
  const steps: string[] = [];
  const all = releaseAll([disposable(steps, "a", true), disposable(steps, "b", true)]);
  const failure = await all[Symbol.asyncDispose]().then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors.map((e: Error) => e.message)).toEqual([
    "b would not close",
    "a would not close",
  ]);
  expect(steps).toEqual(["b", "a"]);
});
