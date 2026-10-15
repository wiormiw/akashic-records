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
import { parseOrigins } from "@/http/security.ts";
import {
  createMemoryCounters,
  createRedisCounters,
  type CounterStore,
} from "@/integrations/counters.ts";
import { createEmbedder, type Embedder } from "@/integrations/embedder.ts";
import { createResendMailer } from "@/integrations/mail.ts";
import { createRateLimiter } from "@/integrations/rate-limit.ts";
import { createRedis, type Redis } from "@/integrations/redis.ts";
import { createLocalRelay, createRedisRelay, type Relay } from "@/integrations/relay.ts";
import { createS3ImageStore } from "@/integrations/storage.ts";
import { createCommentService } from "@/modules/comments/comments.service.ts";
import { createEventService } from "@/modules/events/events.service.ts";
import { createAdminService } from "@/modules/admin/admin.service.ts";
import { createGovernanceServices } from "@/modules/governance/governance.module.ts";
import { createPostingServices } from "@/modules/postings/postings.module.ts";
import { createRealmService } from "@/modules/realm/realm.service.ts";
import { createRoomServices } from "@/modules/room/room.module.ts";
import type { RoomServices } from "@/modules/room/room.types.ts";
import { createUploadService } from "@/modules/upload/upload.service.ts";

const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/**
 * The composition root: the only place that constructs things, and the only file that imports
 * InferDI. Nothing here runs until resolved; `start` in runtime.ts resolves in startup order, and
 * disposal releases in reverse.
 */
export function buildContainer(env: Env) {
  return (
    new Container()
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
      .registerFactory("uploads", (c) => createUploadService({ store: c.get("storage") }))
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
        async (database: Database, clock: Clock, logger: Logger) =>
          createAuth({
            appName: "Akashic Records",
            cookiePrefix: "akashic",
            db: database.db,
            secret: env.BETTER_AUTH_SECRET,
            baseUrl: env.BETTER_AUTH_URL,
            trustedOrigins: parseOrigins(env.CORS_ORIGINS),
            clock,
            sessionExpiryDays: env.SESSION_EXPIRY_DAYS,
            sessionCacheS: env.SESSION_CACHE_S,
            secureCookies: env.NODE_ENV === "production",
            logger,
          }),
        ["database", "clock", "logger"] as const,
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
        "realms",
        async (database: Database, embedder: Embedder, clock: Clock) =>
          createRealmService({ db: database.db, embedder, clock }),
        ["database", "embedder", "clock"] as const,
      )
      .registerAsyncFactory(
        "events",
        async (database: Database, clock: Clock) => createEventService({ db: database.db, clock }),
        ["database", "clock"] as const,
      )
      .registerAsyncFactory(
        "postings",
        async (database: Database, embedder: Embedder, clock: Clock, logger: Logger) =>
          createPostingServices({ db: database.db, embedder, clock, logger }),
        ["database", "embedder", "clock", "logger"] as const,
      )
      .registerAsyncFactory(
        "comments",
        async (database: Database, clock: Clock) =>
          createCommentService({ db: database.db, clock }),
        ["database", "clock"] as const,
      )
      .registerAsyncFactory(
        "governance",
        async (database: Database, clock: Clock) =>
          createGovernanceServices({ db: database.db, clock }),
        ["database", "clock"] as const,
      )
      .registerAsyncFactory(
        "admin",
        async (database: Database, clock: Clock) => createAdminService({ db: database.db, clock }),
        ["database", "clock"] as const,
      )
      .registerAsyncFactory(
        "rooms",
        async (database: Database, clock: Clock) =>
          createRoomServices({ db: database.db, clock, ticketSecret: env.BETTER_AUTH_SECRET }),
        ["database", "clock"] as const,
      )
      // At startup and then hourly, deletes messages past a retention both people agreed to, so a
      // restart doesn't put the next sweep off an hour. Owned, so disposal clears the timer and
      // waits for a sweep in flight; unref'd, so it never holds the process open on its own.
      .registerAsyncFactory(
        "retentionSweep",
        async (rooms: RoomServices, logger: Logger) => {
          let running: Promise<void> = Promise.resolve();
          const sweep = () =>
            (running = rooms.moderation
              .sweepExpired()
              .then((removed) => {
                if (removed > 0) logger.info({ removed }, "swept messages past their retention");
              })
              .catch((error: unknown) => logger.error({ err: error }, "retention sweep failed")));
          const timer = setInterval(sweep, RETENTION_SWEEP_MS);
          timer.unref();
          void sweep();
          return owned({ sweep }, async () => {
            clearInterval(timer);
            await running;
          });
        },
        ["rooms", "logger"] as const,
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
            retentionDays: env.OUTBOX_RETENTION_DAYS,
          });
          // Started by `start` in runtime.ts, once it knows every consumer's queue to declare first.
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
