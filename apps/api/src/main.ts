import { assertNestedBudget, loadEnv } from "@akashic/lib/config";
import { handleSignals } from "@akashic/lib/lifecycle";
import { Env } from "@/config.ts";
import { buildContainer } from "@/container.ts";
import { listen, start, stop } from "@/runtime.ts";

const env = loadEnv(Env, Bun.env);
assertNestedBudget("AI_TIMEOUT_MS", env.AI_TIMEOUT_MS, env.REQUEST_TIMEOUT_MS);
assertNestedBudget("DRAIN_TIMEOUT_MS", env.DRAIN_TIMEOUT_MS, env.SHUTDOWN_TIMEOUT_MS);

const container = buildContainer(env);
// The first steps of `start`, taken early so signals are handled while the rest connects: a
// SIGTERM during startup releases whatever was built. None of these connects to anything.
await container.getAsync("telemetry");
const logger = container.get("logger");
const lifecycle = container.get("lifecycle");

// Until the server exists there is nothing to drain.
let server: { stop(closeActive?: boolean): Promise<void> } = { stop: async () => {} };
handleSignals({
  logger,
  hardExitMs: env.SHUTDOWN_TIMEOUT_MS,
  shutdown: (reason) =>
    stop({ reason, server, container, lifecycle, drainMs: env.DRAIN_TIMEOUT_MS }),
});

// A signal during startup has begun shutdown already, and the signal handler exits.
const signalled = () => lifecycle.phase() !== "starting";

// Both release what they built before rejecting.
try {
  const { app } = await start(container);
  server = await listen({
    serve: () => Bun.serve({ port: env.PORT, fetch: app.fetch }),
    container,
    lifecycle,
  });
} catch (error) {
  if (!signalled()) {
    logger.fatal({ err: error }, "startup failed");
    process.exit(1);
  }
}
if (!signalled()) {
  lifecycle.markReady();
  logger.info({ port: env.PORT }, "listening");
}
