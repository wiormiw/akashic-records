import { describe, expect, mock, test } from "bun:test";
import { createLifecycle, handleSignals, owned } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";

describe("lifecycle", () => {
  test("draining fails readiness but keeps the root signal live until abort", () => {
    const life = createLifecycle(silentLogger());
    life.markReady();
    life.beginDraining("SIGTERM");
    expect(life.isReady()).toBe(false);
    expect(life.signal.aborted).toBe(false);
    life.abort("SIGTERM");
    expect(life.signal.aborted).toBe(true);
    expect(life.isAlive()).toBe(true);
    life.markStopped();
    expect(life.isAlive()).toBe(false);
  });

  test("a linked signal aborts with the root", () => {
    const life = createLifecycle(silentLogger());
    const linked = life.linkedSignal(60_000);
    life.abort("done");
    expect(linked.aborted).toBe(true);
  });

  test("owned values release when disposed", async () => {
    const release = mock(async () => {});
    const value = owned({ name: "pool" }, release);
    await value[Symbol.asyncDispose]();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("handleSignals", () => {
  test("the first signal shuts down once; a second exits at once", async () => {
    const events = new EventTarget();
    const exits: number[] = [];
    let finish!: () => void;
    const shutdown = mock(() => new Promise<void>((resolve) => (finish = resolve)));

    handleSignals({
      shutdown,
      hardExitMs: 60_000,
      logger: silentLogger(),
      exit: (code) => void exits.push(code),
      on: (signal, listener) => events.addEventListener(signal, listener),
    });

    events.dispatchEvent(new Event("SIGTERM"));
    events.dispatchEvent(new Event("SIGTERM"));
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([1]);

    finish();
    await Bun.sleep(0);
    expect(exits).toEqual([1, 0]);
  });
});

describe("owned", () => {
  test("wrapping an already-owned value releases the inner first, then the outer", async () => {
    const order: string[] = [];
    const inner = owned({}, () => void order.push("inner"));
    const outer = owned(inner, () => void order.push("outer"));
    await outer[Symbol.asyncDispose]();
    expect(order).toEqual(["inner", "outer"]);
  });

  test("disposing twice releases once", async () => {
    let released = 0;
    const value = owned({}, () => void released++);
    await Promise.all([value[Symbol.asyncDispose](), value[Symbol.asyncDispose]()]);
    await value[Symbol.asyncDispose]();
    expect(released).toBe(1);
  });
});
