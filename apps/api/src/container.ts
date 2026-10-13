import { Container } from "@inferdi/inferdi";
import { createAuthorizer } from "@akashic/authz";
import {
  createBroker,
  createBrokerPublisher,
  createOutbox,
  createOutboxStore,
  EVENTS_EXCHANGE,
  observeOutbox,
  type Broker,
} from "@akashic/broker";
import { createDb, type Database } from "@akashic/db";
import { createLifecycle, owned, type Lifecycle } from "@akashic/lib/lifecycle";
import { createLogger, type Logger } from "@akashic/lib/log";
import { createTelemetry } from "@akashic/lib/telemetry";
import { systemClock, type Clock } from "@akashic/lib/time";
import { createAuth } from "@/auth/auth.ts";
import type { Env } from "@/config.ts";
import type { Caller } from "@/http/env.ts";
import { parseOrigins } from "@/http/security.ts";
import {
  createMemoryCounters,
  createRedisCounters,
  type CounterStore,
} from "@/integrations/counters.ts";
import { createEmbedder } from "@/integrations/embedder.ts";
import { createResendMailer, type Mailer } from "@/integrations/mail.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";
import { createRedis, type Redis } from "@/integrations/redis.ts";
import { createLocalRelay, createRedisRelay, type Relay } from "@/integrations/relay.ts";
import { createS3ImageStore } from "@/integrations/storage.ts";

/** What a request scope is given. Services that need the caller resolve it from here. */
export interface RequestScope {
  id: string;
  signal: AbortSignal;
  user: Caller | null;
}

/**
 * The composition root: the only place that constructs things, and the only file that imports
 * InferDI. Nothing here runs until resolved; `start` in runtime.ts resolves in startup order, and
 * disposal releases in reverse.
 */
export function buildContainer(env: Env) {
  return (
    new Container()
      .declareScopeInputs<{ request: RequestScope }>()
      .registerValue("env", env)
      .registerValue("clock", systemClock as Clock)
      .registerFactory("telemetry", () =>
        createTelemetry({
          serviceName: env.OTEL_SERVICE_NAME,
          environment: env.NODE_ENV,
          endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
          metricIntervalMs: env.OTEL_METRIC_INTERVAL_MS,
        }),
      )
      .registerFactory("logger", () =>
        createLogger({
          level: env.LOG_LEVEL,
          service: env.OTEL_SERVICE_NAME,
          environment: env.NODE_ENV,
        }),
      )
      .registerFactory("lifecycle", (c) => createLifecycle(c.get("logger")))
      .registerAsyncFactory(
        "database",
        async (logger: Logger) => {
          const database = createDb({
            url: env.DATABASE_URL,
            poolMax: env.DB_POOL_MAX,
            idleTimeoutS: env.DB_IDLE_TIMEOUT_S,
            connectTimeoutS: env.DB_CONNECT_TIMEOUT_S,
            limits: {
              statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS,
              lockTimeoutMs: env.DB_LOCK_TIMEOUT_MS,
              idleInTransactionTimeoutMs: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
            },
            logger,
          });
          // A failed factory is never handed to the container, so it closes its own pool.
          if (!(await database.ping())) {
            await database[Symbol.asyncDispose]();
            throw new Error("database unreachable at startup");
          }
          return database;
        },
        ["logger"] as const,
      )
      .registerAsyncFactory(
        "redis",
        async (logger: Logger) => {
          const redis = createRedis({ url: env.REDIS_URL, logger });
          await redis.connect();
          return owned(redis, () => redis.close());
        },
        ["logger"] as const,
      )
      .registerAsyncFactory(
        "broker",
        async (logger: Logger) => {
          const broker = createBroker({ url: env.RABBITMQ_URL, name: "akashic-api", logger });
          await broker.connect();
          return owned(broker, () => broker.close());
        },
        ["logger"] as const,
      )
      .registerFactory("authorizer", (c) =>
        createAuthorizer({
          apiUrl: env.FGA_API_URL,
          storeId: env.FGA_STORE_ID,
          modelId: env.FGA_MODEL_ID,
          timeoutMs: env.FGA_TIMEOUT_MS,
          logger: c.get("logger"),
        }),
      )
      .registerFactory("embedder", (c) =>
        createEmbedder({
          provider: env.AI_PROVIDER,
          apiKey: env.AI_API_KEY,
          baseUrl: env.AI_BASE_URL,
          model: env.AI_EMBED_MODEL,
          timeoutMs: env.AI_TIMEOUT_MS,
          attempts: env.AI_ATTEMPTS,
          logger: c.get("logger"),
        }),
      )
      .registerFactory("storage", (c) =>
        createS3ImageStore({
          bucket: env.S3_BUCKET,
          region: env.S3_REGION,
          endpoint: env.S3_ENDPOINT,
          publicUrl: env.S3_PUBLIC_URL,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          logger: c.get("logger"),
        }),
      )
      .registerFactory("mailer", (c) =>
        createResendMailer({
          apiKey: env.RESEND_API_KEY,
          from: env.MAIL_FROM,
          timeoutMs: env.MAIL_TIMEOUT_MS,
          logLinks: env.NODE_ENV !== "production",
          logger: c.get("logger"),
          signal: c.get("lifecycle").signal,
        }),
      )
      .registerAsyncFactory(
        "auth",
        async (database: Database, mailer: Mailer, logger: Logger) =>
          createAuth({
            appName: "Akashic Records",
            cookiePrefix: "akashic",
            db: database.db,
            secret: env.BETTER_AUTH_SECRET,
            baseUrl: env.BETTER_AUTH_URL,
            trustedOrigins: parseOrigins(env.CORS_ORIGINS),
            mailer,
            sessionExpiryDays: env.SESSION_EXPIRY_DAYS,
            sessionCacheS: env.SESSION_CACHE_S,
            secureCookies: env.NODE_ENV === "production",
            logger,
          }),
        ["database", "mailer", "logger"] as const,
      )
      // With Redis every replica shares counts and room traffic; without it this instance is
      // assumed to be the only one. Registered on its own so the memory store's sweep is released.
      .registerAsyncFactory(
        "counters",
        async (redis: Redis, lifecycle: Lifecycle, logger: Logger): Promise<CounterStore> =>
          redis.client
            ? createRedisCounters({ redis: redis.client, logger })
            : createMemoryCounters({ signal: lifecycle.signal }),
        ["redis", "lifecycle", "logger"] as const,
      )
      .registerAsyncFactory(
        "rateLimiter",
        async (counters: CounterStore) => createRateLimiter({ counters }),
        ["counters"] as const,
      )
      .registerAsyncFactory(
        "relay",
        async (redis: Redis, logger: Logger): Promise<Relay> =>
          redis.client
            ? createRedisRelay({ redis: redis.client, channel: "akashic:room-relay", logger })
            : createLocalRelay({ logger }),
        ["redis", "logger"] as const,
      )
      .registerAsyncFactory(
        "outbox",
        async (
          database: Database,
          broker: Broker,
          lifecycle: Lifecycle,
          logger: Logger,
          clock: Clock,
        ) => {
          const publisher = createBrokerPublisher({
            broker,
            exchange: EVENTS_EXCHANGE,
            confirmTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS,
          });
          const gauges = observeOutbox(database.db);
          const outbox = createOutbox({
            store: createOutboxStore(database.db),
            transport: (event) =>
              publisher.publish({
                id: event.id,
                type: event.eventType,
                routingKey: event.routingKey,
                payload: event.payload,
                headers: event.headers,
              }),
            clock,
            lifecycle,
            logger,
            batchSize: env.OUTBOX_BATCH_SIZE,
            pollMs: env.OUTBOX_POLL_MS,
            concurrency: env.OUTBOX_CONCURRENCY,
            sendTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS,
          });
          if (env.OUTBOX_DISPATCHER_ENABLED) outbox.start();
          // `owned` runs the outbox's own disposal (stop the loop, wait for it) before these, so
          // nothing is mid-publish when the publisher closes.
          return owned(outbox, async () => {
            await publisher.close();
            await gauges[Symbol.asyncDispose]();
          });
        },
        ["database", "broker", "lifecycle", "logger", "clock"] as const,
      )
  );
}

export type AppContainer = ReturnType<typeof buildContainer>;

/** A request's scope: the root graph plus the request itself, which services may resolve. */
export const requestScope = (root: AppContainer, request: RequestScope) =>
  root.createScope({ request });

export type RequestContainer = ReturnType<typeof requestScope>;
