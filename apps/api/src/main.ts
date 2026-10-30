import { assertNestedBudget, loadEnv } from '@akashic/lib/config';
import { handleSignals } from '@akashic/lib/lifecycle';
import { websocket } from '@hono/bun';
import { Env } from '@/config.ts';
import { buildContainer } from '@/container.ts';
import { listen, MAX_REQUEST_BODY_BYTES, start, stop } from '@/runtime.ts';

const env = loadEnv(Env, Bun.env);
assertNestedBudget('AI_TIMEOUT_MS', env.AI_TIMEOUT_MS, env.REQUEST_TIMEOUT_MS);
assertNestedBudget('DRAIN_TIMEOUT_MS', env.DRAIN_TIMEOUT_MS, env.SHUTDOWN_TIMEOUT_MS);

const container = buildContainer(env);
// The first steps of `start`, taken early so signals are handled while the rest connects: a
// SIGTERM during startup releases whatever was built. None of these connects to anything.
await container.getAsync('telemetry');
const logger = container.get('logger');
const lifecycle = container.get('lifecycle');

// Until the server exists there is nothing to drain, and until `start` returns no consumer to stop.
let server: { stop(closeActive?: boolean): Promise<void> } = { stop: async () => {} };
let consumers: AsyncDisposable = { async [Symbol.asyncDispose]() {} };
handleSignals({
	logger,
	hardExitMs: env.SHUTDOWN_TIMEOUT_MS,
	shutdown: (reason) =>
		stop({ reason, server, consumers, container, lifecycle, drainMs: env.DRAIN_TIMEOUT_MS }),
});

// A signal during startup has begun shutdown already, and the signal handler exits.
const signalled = () => lifecycle.phase() !== 'starting';

// Both release what they built before rejecting.
try {
	const started = await start(container);
	consumers = started.consumers;
	server = await listen({
		// Hono's socket handler, so upgraded room sockets get their events.
		serve: () =>
			Bun.serve({
				port: env.PORT,
				fetch: started.app.fetch,
				websocket,
				maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
			}),
		relay: started.relay,
		consumers,
		container,
		lifecycle,
	});
} catch (error) {
	if (!signalled()) {
		logger.fatal({ err: error }, 'startup failed');
		process.exit(1);
	}
}
if (!signalled()) {
	lifecycle.markReady();
	logger.info({ port: env.PORT }, 'listening');
}
