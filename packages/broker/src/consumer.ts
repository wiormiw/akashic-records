import { ConsumerStatus, type AsyncMessage } from "rabbitmq-client";
import { AppError } from "@akashic/lib/errors";
import { owned, type Lifecycle } from "@akashic/lib/lifecycle";
import type { Logger } from "@akashic/lib/log";
import { withConsumerSpan } from "@akashic/lib/tracing";
import type { Broker } from "./connection.ts";
import { consumerMetrics } from "./metrics.ts";

/** Delivery is at-least-once, so handlers must be idempotent: derive the outcome, don't apply a delta. */
export type EventHandler = (
  payload: unknown,
  signal: AbortSignal,
  meta: HandlerMeta,
) => Promise<void>;

/**
 * Which delivery a handler is running: `messageId` is the outbox event's id (empty if the broker
 * message carried none), stable across redeliveries, so a third party can dedupe on it.
 */
export interface HandlerMeta {
  readonly messageId: string;
  /** 1 for a first delivery, counted up each time it goes through retry. */
  readonly attempt: number;
}

/** The fields of a delivered message a handler run needs. */
export type Delivery = Pick<AsyncMessage, "body" | "messageId" | "type" | "routingKey" | "headers">;

const ATTEMPT_HEADER = "x-attempt";
const MAX_ERROR_LENGTH = 500;

/** Which run this is: 1 for a first delivery, counted up each time it goes through retry. */
export const attemptOf = (delivery: Pick<Delivery, "headers">): number => {
  const value = Number(delivery.headers?.[ATTEMPT_HEADER] ?? 1);
  return Number.isInteger(value) && value >= 1 ? value : 1;
};

/**
 * What the retry and dead copies say went wrong. Headers are readable by anyone with access to
 * the broker, and a driver's message can carry row values, so only an AppError (written for
 * clients) keeps its message; anything else is its name and code. The log keeps the full error.
 */
function describeError(error: unknown): string {
  if (error instanceof AppError)
    return `${error.code}: ${error.message}`.slice(0, MAX_ERROR_LENGTH);
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return (typeof code === "string" ? `${name} ${code}` : name).slice(0, MAX_ERROR_LENGTH);
}

export interface DeliveryDeps {
  /** The work queue, for span attributes and metric labels. */
  queue: string;
  handlers: Readonly<Record<string, EventHandler>>;
  retryQueue: string;
  deadQueue: string;
  maxAttempts: number;
  /** Republishes a copy to a queue and resolves on the broker's confirm. */
  republish(queue: string, delivery: Delivery, headers: Record<string, unknown>): Promise<void>;
  signal(): AbortSignal;
  /** The process's shutdown signal. A handler that fails once it aborts was cut off, not wrong. */
  shutdown: AbortSignal;
  log: Logger;
}

/**
 * Runs one delivery's handler. A failure is never sent back to the head of the queue, where it
 * would spin: it goes to the retry queue to wait, or, out of attempts, to the dead queue for a
 * person. The original is acked only once that copy is confirmed; if the copy can't be made, the
 * error propagates and the message is requeued. A failure during shutdown is requeued untouched.
 */
export function createDeliveryHandler(deps: DeliveryDeps) {
  // Once per handler, not per message.
  const retries = consumerMetrics.retries();
  const parkedCount = consumerMetrics.parked();

  const handle = async (delivery: Delivery, type: string) => {
    const handler = deps.handlers[type];
    if (!handler) {
      throw Object.assign(new Error(`no handler for "${type}"`), { code: "no_handler" });
    }
    const traceparent = delivery.headers?.["traceparent"];
    await withConsumerSpan(
      `consume ${type}`,
      typeof traceparent === "string" ? traceparent : undefined,
      () =>
        handler(delivery.body, deps.signal(), {
          messageId: delivery.messageId ?? "",
          attempt: attemptOf(delivery),
        }),
      {
        "messaging.system": "rabbitmq",
        "messaging.destination.name": deps.queue,
        "messaging.message.id": delivery.messageId ?? "",
        "messaging.operation": "process",
      },
      // Only shutdown is "cancelled": a handler that ran out of time failed, and retries.
      deps.shutdown,
    );
  };

  /** Copies a failed delivery to the retry queue, or to the dead queue once out of attempts. */
  const setAside = async (delivery: Delivery, type: string, error: unknown) => {
    const attempt = attemptOf(delivery);
    const parked = attempt >= deps.maxAttempts;
    const reason = describeError(error);
    await deps.republish(parked ? deps.deadQueue : deps.retryQueue, delivery, {
      ...delivery.headers,
      [ATTEMPT_HEADER]: attempt + 1,
      "x-last-error": reason.slice(0, MAX_ERROR_LENGTH),
    });
    const context = { id: delivery.messageId, type, attempt, err: error };
    if (parked) {
      parkedCount.add(1, { queue: deps.queue });
      deps.log.error(context, "event parked in the dead queue");
    } else {
      retries.add(1, { queue: deps.queue });
      deps.log.warn(context, "event handler failed, will retry");
    }
  };

  return async (delivery: Delivery): Promise<ConsumerStatus> => {
    const type = delivery.type ?? delivery.routingKey;
    try {
      await handle(delivery, type);
    } catch (error) {
      // Back to the queue as it was, for whichever consumer runs next: shutting down isn't the
      // handler failing, so it costs no attempt.
      if (deps.shutdown.aborted) return ConsumerStatus.REQUEUE;
      await setAside(delivery, type, error);
    }
    return ConsumerStatus.ACK;
  };
}

export interface EventConsumerOptions {
  broker: Broker;
  /** The topic exchange events are published to. */
  exchange: string;
  /** This consumer's queue; `<queue>.retry` and `<queue>.dead` are declared beside it. */
  queue: string;
  /** By event type, which is also the routing key the queue binds. */
  handlers: Readonly<Record<string, EventHandler>>;
  prefetch: number;
  handlerTimeoutMs: number;
  retryDelayMs: number;
  maxAttempts: number;
  lifecycle: Lifecycle;
  logger: Logger;
}

export interface EventConsumer {
  /** Declares the queues and starts consuming; disposing it stops it and waits for handlers running. */
  start(): void;
}

export function createEventConsumer(
  options: EventConsumerOptions,
): EventConsumer & AsyncDisposable {
  const { broker, exchange, queue, lifecycle } = options;
  const log = options.logger.child({ component: "event-consumer", queue });
  const retryQueue = `${queue}.retry`;
  const deadQueue = `${queue}.dead`;

  let release: () => Promise<void> = async () => {};

  const consumer: EventConsumer = {
    start() {
      const sideQueues = [
        {
          queue: retryQueue,
          durable: true,
          // A fixed delay: a TTL'd message leaves only from the head, so mixed delays would
          // hold each other up. Expired, it goes back to the work queue.
          arguments: {
            "x-message-ttl": options.retryDelayMs,
            "x-dead-letter-exchange": "",
            "x-dead-letter-routing-key": queue,
          },
        },
        { queue: deadQueue, durable: true },
      ];
      // The publisher declares these only before its first send, which is the first failure;
      // declared now, the dead queue is there to watch before anything lands in it.
      Promise.all(
        sideQueues.map((declaration) => broker.connection.queueDeclare(declaration)),
      ).catch((err: unknown) =>
        log.warn({ err }, "could not declare the retry and dead queues yet"),
      );
      const republisher = broker.connection.createPublisher({
        confirm: true,
        maxAttempts: 2,
        queues: sideQueues,
      });

      const handle = createDeliveryHandler({
        queue,
        handlers: options.handlers,
        retryQueue,
        deadQueue,
        maxAttempts: options.maxAttempts,
        republish: (target, delivery, headers) =>
          republisher.send(
            {
              routingKey: target,
              messageId: delivery.messageId,
              type: delivery.type,
              contentType: "application/json",
              durable: true,
              headers,
            },
            delivery.body,
          ),
        signal: () => lifecycle.linkedSignal(options.handlerTimeoutMs),
        shutdown: lifecycle.signal,
        log,
      });

      const subscription = broker.connection.createConsumer(
        {
          queue,
          queueOptions: { durable: true },
          qos: { prefetchCount: options.prefetch },
          // Only reached when the copy to retry or dead couldn't be made: keep the message.
          requeue: true,
          exchanges: [{ exchange, type: "topic", durable: true }],
          queueBindings: Object.keys(options.handlers).map((routingKey) => ({
            queue,
            exchange,
            routingKey,
          })),
        },
        handle,
      );
      subscription.on("error", (err) => log.warn({ err }, "consumer error"));
      log.info({ types: Object.keys(options.handlers) }, "consuming");

      release = async () => {
        await subscription.close();
        await republisher.close();
      };
    },
  };
  return owned(consumer, () => release());
}
