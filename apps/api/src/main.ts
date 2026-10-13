import { assertNestedBudget, loadEnv } from "@akashic/lib/config";
import { handleSignals } from "@akashic/lib/lifecycle";
import { Env } from "@/config.ts";
import { buildContainer } from "@/container.ts";
import { start, stop } from "@/runtime.ts";

const env = loadEnv(Env, Bun.env);
assertNestedBudget("AI_TIMEOUT_MS", env.AI_TIMEOUT_MS, env.REQUEST_TIMEOUT_MS);
assertNestedBudget("DRAIN_TIMEOUT_MS", env.DRAIN_TIMEOUT_MS, env.SHUTDOWN_TIMEOUT_MS);

const container = buildContainer(env);
// `start` has already released whatever it built when this rejects.
const { app, logger, lifecycle } = await start(container).catch((error: unknown) => {
  console.error("startup failed:", error);
  process.exit(1);
});

const server = Bun.serve({ port: env.PORT, fetch: app.fetch });
handleSignals({
  logger,
  hardExitMs: env.SHUTDOWN_TIMEOUT_MS,
  shutdown: (reason) =>
    stop({ reason, server, container, lifecycle, drainMs: env.DRAIN_TIMEOUT_MS }),
});
lifecycle.markReady();
logger.info({ port: env.PORT }, "listening");
