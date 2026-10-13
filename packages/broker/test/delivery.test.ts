import { describe, expect, test } from "bun:test";
import { OutboxStatus, newOutboxEvent, type OutboxEvent } from "@akashic/db";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";
import { isBefore, mutableClock } from "@akashic/lib/time";
import { createOutbox, type OutboxTransport } from "../src/dispatcher.ts";
import { claimUntil, isClaimedUntil } from "../src/event.ts";
import type { OutboxStore } from "../src/store.ts";

/** The store's contract in memory: claims lease, and finish writes only while the lease holds. */
function memoryStore(onClaim?: () => void) {
  const rows = new Map<string, OutboxEvent>();
  const store: OutboxStore = {
    async claim(now, deadline, limit) {
      onClaim?.();
      const due = [...rows.values()]
        .filter((e) => e.status === OutboxStatus.pending && !isBefore(now, e.nextAttemptAt))
        .slice(0, limit)
        .map((e) => claimUntil(e, deadline));
      for (const e of due) rows.set(e.id, e);
      return due;
    },
    async finish(next, deadline) {
      const current = rows.get(next.id);
      if (!current || !isClaimedUntil(current, deadline)) return false;
      rows.set(next.id, next);
      return true;
    },
  };
  return { store, rows };
}

/** `send` stands in for the broker: resolving is its confirm, throwing is a nack or a timeout. */
function world(send: OutboxTransport, onClaim?: () => void) {
  const clock = mutableClock("2026-06-01T00:00:00Z");
  const { store, rows } = memoryStore(onClaim);
  const lifecycle = createLifecycle(silentLogger());
  const outbox = createOutbox({
    store,
    transport: send,
    clock,
    lifecycle,
    logger: silentLogger(),
    batchSize: 10,
    pollMs: 1000,
    concurrency: 2,
    sendTimeoutMs: 1000,
  });
  const event = newOutboxEvent({ type: "realm.created", payload: { realmId: "r1" } }, clock.now());
  rows.set(event.id, event);
  return { outbox, clock, lifecycle, row: () => rows.get(event.id)!, rows, store };
}

describe("outbox delivery", () => {
  test("a confirmed event is published, once, with what routes it", async () => {
    const seen: unknown[] = [];
    const w = world(
      async ({ id, routingKey, payload }) => void seen.push({ id, routingKey, payload }),
    );
    expect(await w.outbox.drainBatch()).toBe(1);
    expect(w.row()).toMatchObject({ status: OutboxStatus.published, publishedAt: w.clock.now() });
    expect(await w.outbox.drainBatch()).toBe(0);
    expect(seen).toEqual([
      { id: w.row().id, routingKey: "realm.created", payload: { realmId: "r1" } },
    ]);
  });

  test("a failure goes back to pending with a doubling delay, and is not due before it", async () => {
    const w = world(async () => {
      throw new Error("broker unreachable");
    });
    await w.outbox.drainBatch();
    expect(w.row()).toMatchObject({
      status: OutboxStatus.pending,
      attemptCount: 1,
      lastError: "broker unreachable",
      nextAttemptAt: w.clock.now().add({ seconds: 2 }),
    });
    expect(await w.outbox.drainBatch()).toBe(0);

    w.clock.advance({ seconds: 2 });
    await w.outbox.drainBatch();
    expect(w.row()).toMatchObject({
      attemptCount: 2,
      nextAttemptAt: w.clock.now().add({ seconds: 4 }),
    });
  });

  test("the eighth failure is the last: the event is parked as dead", async () => {
    const w = world(async () => {
      throw new Error("bad payload");
    });
    for (let attempt = 1; attempt <= 8; attempt++) {
      await w.outbox.drainBatch();
      w.clock.advance({ minutes: 15 });
    }
    expect(w.row()).toMatchObject({ status: OutboxStatus.dead, attemptCount: 8 });
    expect(await w.outbox.drainBatch()).toBe(0);
  });

  test("a send that outlives its lease loses the event to the next claim", async () => {
    let release = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const w = world(() => slow);

    const first = w.outbox.drainBatch();
    await Bun.sleep(0);
    // The lease runs out and another worker claims the event and publishes it.
    w.clock.advance({ minutes: 1 });
    const [reclaimed] = await w.store.claim(w.clock.now(), w.clock.now().add({ minutes: 1 }), 1);
    await w.store.finish(
      { ...reclaimed!, status: OutboxStatus.published },
      reclaimed!.nextAttemptAt,
    );

    release();
    await first;
    expect(w.row().status).toBe(OutboxStatus.published);
    expect(w.row().attemptCount).toBe(0);
  });

  test("disposing the outbox waits for the loop to stop", async () => {
    let claims = 0;
    const w = world(
      async () => {},
      () => void claims++,
    );
    w.rows.clear();
    w.outbox.start();
    while (claims === 0) await Bun.sleep(1);
    w.lifecycle.abort("test over");
    await w.outbox[Symbol.asyncDispose]();
    expect(claims).toBeGreaterThan(0); // it ran, and it has stopped without hanging
  });
});
