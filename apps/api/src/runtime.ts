import { createEventConsumer, EVENTS_EXCHANGE } from "@akashic/broker";
import { owned, type Lifecycle } from "@akashic/lib/lifecycle";
import { createApp } from "@/app.ts";
import type { AppContainer } from "@/container.ts";
import { realmContext } from "@/http/realm-context.ts";
import { parseOrigins } from "@/http/security.ts";
import { sessions } from "@/http/session.ts";
import { buildModules } from "@/modules/index.ts";
import type { HttpKit } from "@/modules/module.ts";

/** Releases each in reverse order of creation. */
const releaseAll = (disposables: AsyncDisposable[]) =>
  owned({}, async () => {
    for (const disposable of disposables.toReversed()) await disposable[Symbol.asyncDispose]();
  });

/**
 * Builds the graph in startup order: config, telemetry, logger, database, redis, broker, the rest,
 * the outbox, the modules, then their consumers. Disposal releases in reverse, so telemetry
 * flushes last. If any step fails, everything already built is released before the error
 * propagates. The consumers live outside the container: `stop` releases them before it.
 */
export async function start(container: AppContainer, build = buildModules) {
  const started: AsyncDisposable[] = [];
  try {
    const env = container.get("env");
    await container.getAsync("telemetry");
    const logger = container.get("logger");
    const lifecycle = container.get("lifecycle");
    const database = await container.getAsync("database");
    const redis = await container.getAsync("redis");
    const broker = await container.getAsync("broker");
    const authorizer = container.get("authorizer");
    // Built now, though nothing uses them yet, so a missing setting is logged at startup.
    container.get("embedder");
    container.get("storage");
    const mailer = container.get("mailer");
    const auth = await container.getAsync("auth");
    const limiter = await container.getAsync("rateLimiter");
    await container.getAsync("relay");
    // Last of the graph: it starts publishing, and is the first thing the container releases.
    await container.getAsync("outbox");

    const db = database.db;
    const http: HttpKit = {
      sessions: sessions({ auth, db, authorizer }),
      realmContext: realmContext({ db, authorizer }),
      limiter,
      logger,
    };
    const modules = await build(container, http);

    for (const { consumer } of modules) {
      if (!consumer) continue;
      const running = createEventConsumer({
        broker,
        exchange: EVENTS_EXCHANGE,
        queue: consumer.queue,
        handlers: consumer.handlers,
        prefetch: env.OUTBOX_CONCURRENCY,
        handlerTimeoutMs: env.OUTBOX_HANDLER_TIMEOUT_MS,
        retryDelayMs: env.RABBITMQ_RETRY_DELAY_MS,
        maxAttempts: env.RABBITMQ_MAX_ATTEMPTS,
        lifecycle,
        logger,
      });
      started.push(running);
      running.start();
    }

    const app = createApp({
      logger,
      lifecycle,
      auth,
      sessions: http.sessions,
      mailer,
      limiter,
      limits: {
        api: { bucket: "api", limit: env.RATE_LIMIT_MAX, windowSeconds: env.RATE_LIMIT_WINDOW_S },
        auth: {
          bucket: "auth-read",
          limit: env.RATE_LIMIT_MAX,
          windowSeconds: env.RATE_LIMIT_WINDOW_S,
        },
        credentials: {
          bucket: "auth",
          limit: env.AUTH_RATE_LIMIT_MAX,
          windowSeconds: env.AUTH_RATE_LIMIT_WINDOW_S,
        },
      },
      allowedOrigins: parseOrigins(env.CORS_ORIGINS),
      maxBodyBytes: env.MAX_BODY_BYTES,
      budgetMs: env.REQUEST_TIMEOUT_MS,
      trustProxy: env.TRUST_PROXY,
      // The broker is optional for readiness: requests still work, and the outbox holds events.
      checks: {
        required: { database: database.ping },
        optional: { redis: redis.ping, rabbitmq: broker.ping },
      },
      modules: modules.map((module) => module.routes),
    });
    return { app, env, logger, lifecycle, consumers: releaseAll(started) };
  } catch (error) {
    try {
      await releaseAll(started)[Symbol.asyncDispose]();
    } finally {
      await container.dispose();
    }
    throw error;
  }
}

/**
 * Starts the server. If it can't listen (the port is taken), what `start` built is released
 * before the error propagates, so the consumers, the outbox loop and the pools don't die
 * mid-flight.
 */
export async function listen<S>(options: {
  serve: () => S;
  consumers: AsyncDisposable;
  container: Pick<AppContainer, "dispose">;
  lifecycle: Pick<Lifecycle, "abort">;
}): Promise<S> {
  try {
    return options.serve();
  } catch (error) {
    options.lifecycle.abort("could not listen");
    try {
      await options.consumers[Symbol.asyncDispose]();
    } finally {
      await options.container.dispose();
    }
    throw error;
  }
}

/**
 * Drain, abort, stop the consumers, release, in that order. Called once, by the signal handler.
 * Consumers stop before the container, so they finish or requeue the message in hand while the
 * broker connection and the database are still there.
 */
export async function stop(options: {
  reason: string;
  server: { stop(closeActive?: boolean): Promise<void> };
  consumers: AsyncDisposable;
  container: Pick<AppContainer, "dispose">;
  lifecycle: Pick<Lifecycle, "beginDraining" | "abort" | "markStopped">;
  drainMs: number;
}) {
  const { reason, server, container, lifecycle } = options;
  lifecycle.beginDraining(reason);

  let timer: Timer | undefined;
  const windowClosed = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), options.drainMs);
  });
  const drained = await Promise.race([server.stop().then(() => true as const), windowClosed]);
  clearTimeout(timer);
  // Requests still running past the window are cut off, so nothing uses what is released next.
  if (!drained) await server.stop(true);

  lifecycle.abort(reason);
  try {
    try {
      await options.consumers[Symbol.asyncDispose]();
    } finally {
      await container.dispose();
    }
  } finally {
    lifecycle.markStopped();
  }
}
