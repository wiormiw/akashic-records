import { describe, expect, test } from "bun:test";
import { ConsumerStatus } from "rabbitmq-client";
import { silentLogger } from "@akashic/lib/log";
import { attemptOf, createDeliveryHandler, type Delivery } from "../src/consumer.ts";

const delivery = (headers: Record<string, unknown> = {}): Delivery => ({
  body: { realmId: "r1" },
  messageId: "e1",
  type: "realm.created",
  routingKey: "realm.created",
  headers,
});

/** A handler run whose republishes are recorded instead of sent. */
function world(handler: (payload: unknown) => Promise<void>, shutdown = new AbortController()) {
  const copies: { queue: string; headers: Record<string, unknown> }[] = [];
  const handle = createDeliveryHandler({
    queue: "work",
    handlers: { "realm.created": handler },
    retryQueue: "work.retry",
    deadQueue: "work.dead",
    maxAttempts: 3,
    republish: async (queue, _delivery, headers) => void copies.push({ queue, headers }),
    signal: () => new AbortController().signal,
    shutdown: shutdown.signal,
    log: silentLogger(),
  });
  return { handle, copies };
}

const failing = async () => {
  throw new Error("openfga down");
};

describe("event consumer", () => {
  test("a handled event is acked and nothing is copied", async () => {
    const seen: unknown[] = [];
    const w = world(async (payload) => void seen.push(payload));
    expect(await w.handle(delivery())).toBe(ConsumerStatus.ACK);
    expect(seen).toEqual([{ realmId: "r1" }]);
    expect(w.copies).toEqual([]);
  });

  test("a failure goes to the retry queue counted as the next attempt, and the original is acked", async () => {
    const w = world(failing);
    expect(await w.handle(delivery({ traceparent: "00-a-b-01" }))).toBe(ConsumerStatus.ACK);
    expect(w.copies).toEqual([
      {
        queue: "work.retry",
        headers: { traceparent: "00-a-b-01", "x-attempt": 2, "x-last-error": "openfga down" },
      },
    ]);
  });

  test("the last attempt's failure parks the event in the dead queue", async () => {
    const w = world(failing);
    await w.handle(delivery({ "x-attempt": 3 }));
    expect(w.copies.map((copy) => copy.queue)).toEqual(["work.dead"]);
  });

  test("an event with no handler is retried, then parked, not lost", async () => {
    const w = world(failing);
    const unknown = { ...delivery(), type: "realm.renamed", routingKey: "realm.renamed" };
    await w.handle(unknown);
    expect(w.copies[0]).toMatchObject({
      queue: "work.retry",
      headers: { "x-last-error": 'no handler for "realm.renamed"' },
    });
  });

  test("if the copy can't be made, the error reaches the client library, which requeues", async () => {
    const handle = createDeliveryHandler({
      queue: "work",
      handlers: { "realm.created": failing },
      retryQueue: "work.retry",
      deadQueue: "work.dead",
      maxAttempts: 3,
      republish: async () => {
        throw new Error("channel closed");
      },
      signal: () => new AbortController().signal,
      shutdown: new AbortController().signal,
      log: silentLogger(),
    });
    await expect(handle(delivery())).rejects.toThrow("channel closed");
  });

  test("a handler cut off by shutdown is requeued as it was, without spending an attempt", async () => {
    const shutdown = new AbortController();
    const w = world(async () => {
      shutdown.abort(new Error("shutting down: SIGTERM"));
      throw shutdown.signal.reason;
    }, shutdown);
    expect(await w.handle(delivery({ "x-attempt": 2 }))).toBe(ConsumerStatus.REQUEUE);
    expect(w.copies).toEqual([]);
  });

  test("the attempt is read from the header, and anything odd there counts as the first", () => {
    expect(attemptOf({ headers: {} })).toBe(1);
    expect(attemptOf({ headers: { "x-attempt": 4 } })).toBe(4);
    expect(attemptOf({ headers: { "x-attempt": "nonsense" } })).toBe(1);
    expect(attemptOf({ headers: { "x-attempt": 0 } })).toBe(1);
  });
});
