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
