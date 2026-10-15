import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDb } from "@akashic/db";
import { createBroker, EVENTS_EXCHANGE } from "@akashic/broker";
import { silentLogger } from "@akashic/lib/log";
import { buildContainer } from "@/container.ts";
import type { AppEnv } from "@/http/env.ts";
import type { Module } from "@/modules/module.ts";
import { start, stop } from "@/runtime.ts";
import { testEnv } from "./env.ts";

// `start` with one fake module, against the compose Postgres and RabbitMQ: its routes answer under
// each prefix, its consumer receives from its own throwaway queue, and `stop` closes that consumer
// before the broker connection goes. Skips unless both answer.

const env = testEnv({
  // The dispatcher would claim and publish whatever events the database already holds.
  OUTBOX_DISPATCHER_ENABLED: "false",
  RABBITMQ_RETRY_DELAY_MS: "1000",
});

const noSweep = { sweep: async () => {}, async [Symbol.asyncDispose]() {} };

const database = createDb({
  url: env.DATABASE_URL,
  poolMax: 1,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const broker = createBroker({
  url: env.RABBITMQ_URL,
  name: "modules-test-probe",
  logger: silentLogger(),
});
const probe = broker.connection;
const [postgres, rabbitmq] = await Promise.all([database.ping(), broker.connect(2000)]);

const run = Bun.randomUUIDv7().slice(-12);
const queue = `akashic.test-modules.${run}`;
const eventType = `test.modules.${run}`;

afterAll(async () => {
  await database[Symbol.asyncDispose]();
  if (rabbitmq) {
    for (const q of [queue, `${queue}.retry`, `${queue}.dead`, `${queue}.late`])
      await probe.queueDelete({ queue: q });
  }
  await broker.close();
});

const signedInWhenAsked = {
  api: {
    getSession: async ({ headers }: { headers: Headers }) =>
      headers.get("x-test-user")
        ? { user: { id: Bun.randomUUIDv7(), email: "modules-test@example.test" } }
        : null,
  },
};

/** Whether `name` exists on the broker. */
const declared = (name: string) =>
  probe.queueDeclare({ queue: name, passive: true }).then(
    () => true,
    () => false,
  );

/** How many consumers read `queue` right now. */
const consumersOn = async (name: string) =>
  (await probe.queueDeclare({ queue: name, passive: true })).consumerCount;

describe.skipIf(!(postgres && rabbitmq))("modules", () => {
  test("routes mount under each prefix, and the consumer runs until stop, before the container goes", async () => {
    const received: unknown[] = [];
    let built: { http: object } | undefined;
    const fake: Module = {
      name: "fake",
      routes: {
        private: new Hono<AppEnv>().get("/fake", (c) => c.text("private")),
        public: new Hono<AppEnv>().get("/fake", (c) => c.text("public")),
        root: new Hono<AppEnv>().get("/fake-root", (c) => c.text("root")),
      },
      consumer: {
        queue,
        handlers: { [eventType]: async (payload) => void received.push(payload) },
      },
    };
    const container = buildContainer(env)
      // Telemetry registers process-wide providers, which other test files' span capture needs.
      .override("telemetry", { async [Symbol.asyncDispose]() {} })
      // Signed in when the request says so; the ban lookup finds no row for a fresh id.
      .override("auth", signedInWhenAsked as never)
      // The sweep runs at startup, and would delete the dev database's expired messages.
      .override("retentionSweep", noSweep);
    const { app, lifecycle, consumers } = await start(container, async (_container, http) => {
      built = { http };
      return [fake];
    });
    try {
      expect(Object.keys(built!.http).sort()).toEqual([
        "limiter",
        "logger",
        "realmContext",
        "sessions",
        "trustProxy",
      ]);

      // Private routes sit behind the session; signed in, the mounted path answers and only it.
      expect((await app.request("/api/v1/fake")).status).toBe(401);
      const signedIn = { headers: { "x-test-user": "yes" } };
      const privateRes = await app.request("/api/v1/fake", signedIn);
      expect(privateRes.status).toBe(200);
      expect(await privateRes.text()).toBe("private");
      expect((await app.request("/api/v1/not-mounted", signedIn)).status).toBe(404);
      expect((await app.request("/api/public/v1/not-mounted")).status).toBe(404);
      expect(await (await app.request("/api/public/v1/fake")).text()).toBe("public");
      expect(await (await app.request("/fake-root")).text()).toBe("root");

      // The consumer declared its queue and binding as it started; wait for them.
      for (let i = 0; i < 50; i++) {
        const ok = await probe.queueDeclare({ queue, passive: true }).then(
          () => true,
          () => false,
        );
        if (ok) break;
        await Bun.sleep(50);
      }
      await Bun.sleep(200);
      const publisher = probe.createPublisher({ confirm: true });
      await publisher.send(
        {
          exchange: EVENTS_EXCHANGE,
          routingKey: eventType,
          type: eventType,
          messageId: run,
          contentType: "application/json",
        },
        { hello: run },
      );
      await publisher.close();
      for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(50);
      expect(received).toEqual([{ hello: run }]);
      expect(await consumersOn(queue)).toBe(1);

      const steps: string[] = [];
      await stop({
        reason: "test",
        drainMs: 100,
        server: { stop: async () => {} },
        consumers: {
          async [Symbol.asyncDispose]() {
            await consumers[Symbol.asyncDispose]();
            steps.push("consumers");
          },
        },
        container: {
          async dispose() {
            // Still connected here, so the queue shows whether the consumer has let go.
            steps.push(`container (consumers on queue: ${await consumersOn(queue)})`);
            await container.dispose();
          },
        },
        lifecycle,
      });
      expect(steps).toEqual(["consumers", "container (consumers on queue: 0)"]);
    } finally {
      await consumers[Symbol.asyncDispose]();
      await container.dispose();
    }
  }, 20_000);

  test("a shutdown that begins while the modules are built starts no consumer", async () => {
    const lateQueue = `${queue}.late`;
    const container = buildContainer(env)
      .override("telemetry", { async [Symbol.asyncDispose]() {} })
      .override("retentionSweep", noSweep);
    let disposed = false;
    const original = container.dispose.bind(container);
    container.dispose = async () => {
      disposed = true;
      await original();
    };
    const started = start(container, async (built) => {
      built.get("lifecycle").abort("SIGTERM");
      return [
        {
          name: "late",
          routes: {},
          consumer: { queue: lateQueue, handlers: { x: async () => {} } },
        },
      ];
    });
    await expect(started).rejects.toThrow("shutdown began");
    expect(disposed).toBe(true);
    await Bun.sleep(200);
    expect(await declared(lateQueue)).toBe(false);
  });
});
