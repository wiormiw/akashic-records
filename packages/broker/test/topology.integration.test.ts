import { afterAll, describe, expect, test } from "bun:test";
import { Connection } from "rabbitmq-client";
import { OutboxStatus, type OutboxEvent } from "@akashic/db";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";
import { systemClock } from "@akashic/lib/time";
import { createBroker } from "../src/connection.ts";
import { createOutbox } from "../src/dispatcher.ts";
import { createBrokerPublisher } from "../src/publisher.ts";
import type { OutboxStore } from "../src/store.ts";
import { declareTopology } from "../src/topology.ts";

// A fresh broker: the exchange and the consumer's queue don't exist yet, and an event is already
// pending in the outbox. The store is in memory, so nothing touches the database; the exchange and
// queues are this run's own, deleted afterwards. Skips when no broker answers at RABBITMQ_URL.

const url = Bun.env.RABBITMQ_URL ?? "amqp://akashic:akashic@localhost:5672";
const probe = new Connection({ url, retryLow: 100, retryHigh: 200 });
const live = await probe.onConnect(2000).then(
  () => true,
  () => false,
);

const run = Bun.randomUUIDv7().slice(-8);
const exchange = `test.topology.${run}`;
const queue = `test.topology.${run}`;

afterAll(async () => {
  if (!live) return;
  for (const name of [queue, `${queue}.retry`, `${queue}.dead`])
    await probe.queueDelete({ queue: name });
  await probe.exchangeDelete({ exchange });
  await probe.close();
});

/** One pending event, handed out once; records what was finished. */
function oneEventStore(event: OutboxEvent) {
  let pending: OutboxEvent[] = [event];
  const finished: OutboxEvent[] = [];
  const store: OutboxStore = {
    async claim() {
      const claimed = pending;
      pending = [];
      return claimed;
    },
    async finish(next) {
      finished.push(next);
      return true;
    },
    async prune() {
      return 0;
    },
  };
  return { store, finished };
}

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting");
}

describe.skipIf(!live)("consumer topology", () => {
  test("an event pending before startup lands in the consumer's queue, not nowhere", async () => {
    const now = systemClock.now();
    const event: OutboxEvent = {
      id: Bun.randomUUIDv7(),
      eventType: "test.created",
      routingKey: "test.created",
      payload: { n: 1 },
      headers: null,
      status: OutboxStatus.pending,
      attemptCount: 0,
      nextAttemptAt: now,
      createdAt: now,
      publishedAt: null,
      lastError: null,
    };
    const { store, finished } = oneEventStore(event);
    const lifecycle = createLifecycle(silentLogger());
    const broker = createBroker({ url, name: "akashic-test", logger: silentLogger() });
    await broker.connect(2000);
    const publisher = createBrokerPublisher({ broker, exchange, confirmTimeoutMs: 2000 });
    const outbox = createOutbox({
      store,
      transport: (e) =>
        publisher.publish({
          id: e.id,
          type: e.eventType,
          routingKey: e.routingKey,
          payload: e.payload,
          headers: e.headers,
        }),
      clock: systemClock,
      lifecycle,
      logger: silentLogger(),
      batchSize: 10,
      pollMs: 50,
      concurrency: 1,
      sendTimeoutMs: 2000,
      retentionDays: 7,
    });

    // No consumer runs: the topology alone must be enough for the event to be kept.
    outbox.start({
      prepare: () =>
        declareTopology(broker, [
          { exchange, queue, routingKeys: ["test.created"], retryDelayMs: 100 },
        ]),
    });
    try {
      await until(() => finished.length === 1);
      expect(finished[0]?.status).toBe(OutboxStatus.published);
      await until(
        async () => (await probe.queueDeclare({ queue, passive: true })).messageCount === 1,
      );
      const message = await probe.basicGet({ queue, noAck: true });
      expect(message?.messageId).toBe(event.id);
      // The side queues exist too, before anything fails.
      await probe.queueDeclare({ queue: `${queue}.retry`, passive: true });
      await probe.queueDeclare({ queue: `${queue}.dead`, passive: true });
    } finally {
      lifecycle.abort("test over");
      await outbox[Symbol.asyncDispose]();
      await publisher.close();
      await broker.close();
    }
  });
});
