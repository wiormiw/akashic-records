import { OutboxStatus, type OutboxEvent } from "@akashic/db";
import { mapLimitedSettled } from "@akashic/lib/concurrency";
import { owned, type Lifecycle } from "@akashic/lib/lifecycle";
import type { Logger } from "@akashic/lib/log";
import type { Clock } from "@akashic/lib/time";
import { traced } from "@akashic/lib/tracing";
import { markPublished, recordFailure } from "./event.ts";
import type { OutboxStore } from "./store.ts";

/**
 * Hands one event on: resolves once whatever is downstream has it (the broker's confirm), and
 * rejects otherwise. Delivery is at least once, so the same event may be handed on again.
 */
export type OutboxTransport = (event: OutboxEvent) => Promise<void>;

const outboxPolicy = {
  maxAttempts: 8,
  backoffBaseSeconds: 2,
  backoffCapSeconds: 900,
} as const;

/** 2s, 4s, 8s ... capped at 15 minutes. */
const backoffSeconds = (attempts: number): number =>
  Math.min(outboxPolicy.backoffBaseSeconds ** attempts, outboxPolicy.backoffCapSeconds);

// The database keeps microseconds and a Date carries milliseconds; a deadline with more precision
// than that would never compare equal to itself once stored.
const toMillis = (instant: Temporal.Instant) =>
  Temporal.Instant.fromEpochMilliseconds(instant.epochMilliseconds);

/**
 * Resolves after `ms`, or at once when `signal` aborts, so a polling loop never holds the grace
 * period open. Either way the timer and the listener are released: the signal outlives every
 * sleep, and a listener left behind per poll would grow without bound.
 */
export function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export interface OutboxOptions {
  store: OutboxStore;
  transport: OutboxTransport;
  clock: Clock;
  lifecycle: Lifecycle;
  logger: Logger;
  batchSize: number;
  pollMs: number;
  concurrency: number;
  sendTimeoutMs: number;
}

export interface Outbox {
  /** Claims and processes one batch. Returns how many were claimed. */
  drainBatch(): Promise<number>;
  /** Polls until the lifecycle aborts. Disposing the outbox then waits for the loop to stop. */
  start(): void;
}

export function createOutbox(options: OutboxOptions): Outbox & AsyncDisposable {
  const { store, transport, clock, lifecycle } = options;
  const log = options.logger.child({ component: "outbox" });

  // Long enough for every send in a batch to finish; a pod that dies mid-batch releases its
  // events once the lease runs out.
  const leaseSeconds = Math.max(Math.ceil((options.sendTimeoutMs * 3) / 1000), 30);

  const deliver = (event: OutboxEvent) =>
    traced(
      `outbox.publish ${event.eventType}`,
      {
        "messaging.message.id": event.id,
        "messaging.operation": "publish",
        "messaging.destination.name": event.routingKey,
      },
      () => transport(event),
    );

  function failed(event: OutboxEvent, error: unknown): OutboxEvent {
    const attempts = event.attemptCount + 1;
    const next = recordFailure(
      event,
      clock.now().add({ seconds: backoffSeconds(attempts) }),
      error instanceof Error ? error.message : String(error),
      attempts >= outboxPolicy.maxAttempts,
    );
    const context = { id: event.id, eventType: event.eventType, attempts, err: error };
    if (next.status === OutboxStatus.dead) log.error(context, "event parked as dead");
    else log.warn(context, "dispatch failed, will retry");
    return next;
  }

  /** `claimed` is leased until its nextAttemptAt; the outcome is written only while that holds. */
  async function processOne(claimed: OutboxEvent): Promise<void> {
    let next: OutboxEvent;
    try {
      await deliver(claimed);
      next = markPublished(claimed, clock.now());
    } catch (error) {
      next = failed(claimed, error);
    }
    if (!(await store.finish(next, claimed.nextAttemptAt))) {
      log.warn({ id: claimed.id, eventType: claimed.eventType }, "lease lost; outcome dropped");
    }
  }

  // Aborts with the lifecycle, or when the outbox is disposed without one.
  const halt = new AbortController();
  const signal = AbortSignal.any([lifecycle.signal, halt.signal]);

  const sleep = (ms: number) => abortableSleep(signal, ms);

  let stopped: Promise<void> = Promise.resolve();

  const outbox: Outbox = {
    async drainBatch() {
      const now = clock.now();
      // Claimed before the span: an empty poll every pollMs would otherwise be most traces.
      const claimed = await store.claim(
        now,
        toMillis(now.add({ seconds: leaseSeconds })),
        options.batchSize,
      );
      if (claimed.length === 0) return 0;

      return traced(
        "outbox.drain",
        { "akashic.outbox.batch_size": options.batchSize },
        async (span) => {
          span.setAttribute("akashic.outbox.claimed", claimed.length);

          // Settled, not all: one poisonous event must not abandon the rest of the batch.
          const results = await mapLimitedSettled(claimed, options.concurrency, async (event) => {
            if (signal.aborted) return;
            await processOne(event);
          });

          const unexpected = results.filter((r) => r.status === "rejected").length;
          if (unexpected > 0) span.setAttribute("akashic.outbox.unexpected_failures", unexpected);
          return claimed.length;
        },
      );
    },

    start() {
      stopped = runDispatcher({
        drain: () => outbox.drainBatch(),
        sleep,
        signal,
        batchSize: options.batchSize,
        pollMs: options.pollMs,
        log,
      });
    },
  };

  return owned(outbox, async () => {
    halt.abort();
    await stopped;
  });
}

/**
 * The polling loop, apart from the database so its pacing can be tested: a full batch means more
 * is waiting, so it drains again at once; otherwise it sleeps a poll; a failure backs off longer.
 */
export async function runDispatcher(options: {
  drain: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal;
  batchSize: number;
  pollMs: number;
  log: Logger;
}): Promise<void> {
  const { drain, sleep, signal, log } = options;
  log.info({ batchSize: options.batchSize, pollMs: options.pollMs }, "dispatcher started");

  while (!signal.aborted) {
    try {
      if ((await drain()) < options.batchSize) await sleep(options.pollMs);
    } catch (error) {
      if (signal.aborted) break;
      log.error({ err: error }, "dispatcher iteration failed, backing off");
      await sleep(Math.min(options.pollMs * 5, 10_000));
    }
  }

  log.info("dispatcher stopped");
}
