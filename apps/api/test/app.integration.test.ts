import { afterAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createBroker } from "@akashic/broker";
import { createDb, outboxMessages, user, verification } from "@akashic/db";
import { silentLogger } from "@akashic/lib/log";
import { buildContainer } from "@/container.ts";
import type { AppEnv } from "@/http/env.ts";
import { start, stop } from "@/runtime.ts";
import { testEnv } from "./env.ts";

// The whole graph against the compose services: Postgres, RabbitMQ and OpenFGA. Skips unless all
// three answer. The database holds real data, so this touches only the account it creates.

const env = testEnv({
  // The dispatcher would claim and publish whatever events the database already holds.
  OUTBOX_DISPATCHER_ENABLED: "false",
});

const noSweep = { sweep: async () => {}, async [Symbol.asyncDispose]() {} };

const database = createDb({
  url: env.DATABASE_URL,
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const probe = createBroker({ url: env.RABBITMQ_URL, name: "app-it-probe", logger: silentLogger() });
const [postgres, rabbitmq, openfga] = await Promise.all([
  database.ping(),
  probe.connect(2000),
  fetch(`${env.FGA_API_URL}/stores`, { signal: AbortSignal.timeout(1500) })
    .then((response) => response.ok)
    .catch(() => false),
]);

const email = `app-it-${Bun.randomUUIDv7()}@example.test`;

afterAll(async () => {
  // Sessions and accounts cascade from the user.
  if (postgres) {
    await database.db.delete(verification).where(eq(verification.identifier, email));
    await database.db.delete(user).where(eq(user.email, email));
    // Sign-up wrote a mail.requested event for this address; remove only that one.
    await database.db
      .delete(outboxMessages)
      .where(
        and(
          eq(outboxMessages.messageType, "mail.requested"),
          sql`${outboxMessages.payload}->>'to' = ${email}`,
        ),
      );
  }
  await database[Symbol.asyncDispose]();
  await probe.close();
});

describe.skipIf(!(postgres && rabbitmq && openfga))("the started app", () => {
  test("starts, serves, refuses a suspended account, and stops", async () => {
    const container = buildContainer(env)
      // Telemetry registers process-wide providers, which other test files' span capture needs.
      .override("telemetry", { async [Symbol.asyncDispose]() {} })
      // The sweep runs at startup, and would delete the dev database's expired messages.
      .override("retentionSweep", noSweep);
    const probeRoute = new Hono<AppEnv>().get("/probe", (c) => c.text("ok"));
    const { app, lifecycle, consumers } = await start(container, async () => [
      { name: "probe", routes: { private: probeRoute } },
    ]);
    try {
      lifecycle.markReady();

      const ready = await app.request("/readyz");
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ database: true, rabbitmq: true });

      const json = { "content-type": "application/json" };
      const credentials = { email, password: "correct-horse-battery-staple" };
      const signUp = await app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ ...credentials, name: "App Integration" }),
      });
      expect(signUp.status).toBe(200);
      // Sign-in needs a verified address; the link went to a mailer that isn't configured.
      await database.db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

      const signIn = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: json,
        body: JSON.stringify(credentials),
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");

      const before = await app.request("/api/v1/probe", { headers: { cookie } });
      expect(before.status).toBe(200);

      await database.db
        .update(user)
        .set({ bannedAt: new Date(), banReason: "Testing." })
        .where(eq(user.email, email));
      const after = await app.request("/api/v1/probe", { headers: { cookie } });
      expect(after.status).toBe(403);
      expect(((await after.json()) as { code: string }).code).toBe("auth.account.suspended");

      await stop({
        reason: "test",
        drainMs: 100,
        server: { stop: async () => {} },
        consumers,
        container,
        lifecycle,
      });
      expect(lifecycle.isAlive()).toBe(false);
      expect(lifecycle.signal.aborted).toBe(true);
    } finally {
      // Disposal is idempotent: after `stop` this does nothing, after a failed assertion it releases.
      await container.dispose();
    }
  }, 20_000);
});
