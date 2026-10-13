import type { Lifecycle } from "@akashic/lib/lifecycle";
import { createApp, type ModuleRoutes } from "@/app.ts";
import type { AppContainer } from "@/container.ts";
import { parseOrigins } from "@/http/security.ts";

/**
 * Builds the graph in startup order: config, telemetry, logger, database, redis, broker, the rest,
 * then the outbox. Disposal releases in reverse, so telemetry flushes last. If any step fails,
 * everything already built is released before the error propagates.
 */
export async function start(container: AppContainer, modules: readonly ModuleRoutes[] = []) {
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
    // Last: it starts publishing, and is the first thing released.
    await container.getAsync("outbox");

    const app = createApp({
      container,
      logger,
      lifecycle,
      auth,
      db: database.db,
      authorizer,
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
      modules,
    });
    return { app, env, logger, lifecycle };
  } catch (error) {
    await container.dispose();
    throw error;
  }
}

/** Drain, abort, release, in that order. Called once, by the signal handler. */
export async function stop(options: {
  reason: string;
  server: { stop(closeActive?: boolean): Promise<void> };
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
    await container.dispose();
  } finally {
    lifecycle.markStopped();
  }
}
