import { afterAll, describe, expect, test } from "bun:test";
import { Connection } from "rabbitmq-client";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";
import { recordSpans } from "../../lib/test/spans.ts";
import { createBroker } from "../src/connection.ts";
import { createEventConsumer, type EventHandler } from "../src/consumer.ts";
import { createBrokerPublisher } from "../src/publisher.ts";
import { deadCount, replayDead } from "../src/replay.ts";

// Tracing is registered so the publish span's traceparent travels the same whether or not another
// test file got there first (bun runs every file in one process).
recordSpans();

// Publisher and consumer against a real RabbitMQ. Every run declares its own exchange and queues
// and deletes them afterwards. Skips when no broker answers at RABBITMQ_URL.

const url = Bun.env.RABBITMQ_URL ?? "amqp://akashic:akashic@localhost:5672";
const probe = new Connection({ url, retryLow: 100, retryHigh: 200 });
const live = await probe.onConnect(2000).then(
  () => true,
  () => false,
);

const run = Bun.randomUUIDv7().slice(-8);
const exchange = `test.events.${run}`;
const queues: string[] = [];

afterAll(async () => {
  // Without a broker, onConnect's timeout has already closed the probe, and closing it a second
  // time never settles: the suite would fail its hook instead of skipping.
  if (!live) return;
  for (const queue of queues) await probe.queueDelete({ queue });
  await probe.exchangeDelete({ exchange });
  await probe.close();
});

/** A broker, a publisher and one consumer with `handlers`, retrying after 100ms, 3 attempts. */
async function world(name: string, handlers: Record<string, EventHandler>) {
  const queue = `test.${name}.${run}`;
  queues.push(queue, `${queue}.retry`, `${queue}.dead`);
  const lifecycle = createLifecycle(silentLogger());
  const broker = createBroker({ url, name: "akashic-test", logger: silentLogger() });
  await broker.connect(2000);
  const publisher = createBrokerPublisher({ broker, exchange, confirmTimeoutMs: 2000 });
  const consumer = createEventConsumer({
    broker,
    exchange,
    queue,
    handlers,
    prefetch: 2,
    handlerTimeoutMs: 2000,
    retryDelayMs: 100,
    maxAttempts: 3,
    lifecycle,
    logger: silentLogger(),
  });
  consumer.start();
  // Bindings are declared as the consumer starts; publish only once they exist.
  await Bun.sleep(300);

  const publish = (id: string, type: string, payload: unknown) =>
    publisher.publish({ id, type, routingKey: type, payload, headers: { traceparent: "x" } });
  return {
    queue,
    broker,
    publish,
    stop: async () => {
      lifecycle.abort("test over");
      await consumer[Symbol.asyncDispose]();
      await publisher.close();
      await broker.close();
    },
  };
}

/** How many messages wait in `queue`; zero while it doesn't exist yet. */
const depth = (queue: string) =>
  probe.queueDeclare({ queue, passive: true }).then(
    (ok) => ok.messageCount,
    () => 0,
  );

async function until(check: () => boolean | Promise<boolean>, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out waiting");
}

describe.skipIf(!live)("event broker", () => {
  test("a confirmed event reaches the handler for its type, with its payload", async () => {
    const seen: unknown[] = [];
    const w = await world("deliver", {
      "realm.created": async (payload) => void seen.push(payload),
    });
    await w.publish("e1", "realm.created", { realmId: "r1" });
    await until(() => seen.length === 1);
    expect(seen).toEqual([{ realmId: "r1" }]);
    await w.stop();
  });

  test("a failing handler is retried after the delay, and succeeds when it can", async () => {
    let calls = 0;
    const w = await world("retry", {
      "realm.created": async () => {
        calls++;
        if (calls === 1) throw new Error("openfga down");
      },
    });
    const started = Date.now();
    await w.publish("e2", "realm.created", { realmId: "r2" });
    await until(() => calls === 2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await w.stop();
  });

  test("past the last attempt the event is parked in the dead queue, headers telling why", async () => {
    let calls = 0;
    const w = await world("dead", {
      "realm.created": async () => {
        calls++;
        throw new Error("payload is malformed");
      },
    });
    await w.publish("e3", "realm.created", { realmId: "r3" });
    await until(async () => (await depth(`${w.queue}.dead`)) === 1);
    expect(calls).toBe(3);

    const parked = await probe.basicGet({ queue: `${w.queue}.dead`, noAck: true });
    expect(parked?.messageId).toBe("e3");
    expect(parked?.headers).toMatchObject({
      "x-attempt": 4,
      "x-last-error": "payload is malformed",
    });
    // The publish span's context replaces the stored one (here a stand-in "x").
    expect(String(parked?.headers?.traceparent)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    await w.stop();
  });

  test("a parked message replays onto its queue, and is handled once the fault is fixed", async () => {
    let broken = true;
    const handled: unknown[] = [];
    const w = await world("replay", {
      "realm.created": async (payload) => {
        if (broken) throw new Error("openfga down");
        handled.push(payload);
      },
    });
    await w.publish("e4", "realm.created", { realmId: "r4" });
    await until(async () => (await depth(`${w.queue}.dead`)) === 1);
    expect(await deadCount(w.broker, w.queue)).toBe(1);

    broken = false;
    expect(await replayDead(w.broker, w.queue, 10)).toBe(1);
    await until(() => handled.length === 1);
    expect(handled).toEqual([{ realmId: "r4" }]);
    expect(await deadCount(w.broker, w.queue)).toBe(0);
    await w.stop();
  });
});
