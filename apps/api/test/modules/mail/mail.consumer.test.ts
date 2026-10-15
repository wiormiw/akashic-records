import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDeliveryHandler } from "@akashic/broker";
import { createDb, outboxMessages, OutboxStatus, user } from "@akashic/db";
import { withRollback } from "@akashic/db/testing";
import { createLifecycle } from "@akashic/lib/lifecycle";
import { silentLogger } from "@akashic/lib/log";
import { fixedClock } from "@akashic/lib/time";
import { createAuth } from "@/auth/auth.ts";
import type { AppEnv } from "@/http/env.ts";
import { metaRoutes } from "@/http/meta.ts";
import { createResendMailer, type MailMessage, type Mailer } from "@/integrations/mail.ts";
import { mailHandlers } from "@/modules/mail/mail.consumer.ts";
import { createMailModule } from "@/modules/mail/mail.module.ts";

const logger = silentLogger();
const message = {
  to: "someone@example.test",
  subject: "Verify",
  html: "<p>hi</p>",
  link: "https://example.test/v",
};

const fakeMailer = () => {
  const sent: { message: MailMessage; key: string | undefined }[] = [];
  const mailer: Mailer = {
    async send(m, options) {
      sent.push({ message: m, key: options?.idempotencyKey });
    },
    health: () => ({ configured: true, healthy: true, lastFailure: null, failedAt: null }),
  };
  return { mailer, sent };
};

const meta = { messageId: "evt-1", attempt: 1 };
const signal = new AbortController().signal;

describe("mail consumer", () => {
  test("sends once, keyed by the delivery's message id", async () => {
    const { mailer, sent } = fakeMailer();
    await mailHandlers(mailer)["mail.requested"]!(message, signal, meta);
    expect(sent).toEqual([{ message, key: "evt-1" }]);
  });

  test("a malformed payload throws and sends nothing", async () => {
    const { mailer, sent } = fakeMailer();
    const handle = mailHandlers(mailer)["mail.requested"]!;
    await expect(handle({ to: "a@b.test" }, signal, meta)).rejects.toThrow();
    expect(sent).toEqual([]);
  });

  test("the module consumes akashic.mail and has no routes", () => {
    const module = createMailModule({ mailer: fakeMailer().mailer });
    expect(module.consumer?.queue).toBe("akashic.mail");
    expect(Object.keys(module.consumer?.handlers ?? {})).toEqual(["mail.requested"]);
    expect(module.routes).toEqual({});
  });

  test("a failing send makes the delivery retry, not acknowledge", async () => {
    const mailer: Mailer = {
      send: async () => {
        throw new Error("resend down");
      },
      health: () => ({ configured: true, healthy: false, lastFailure: "x", failedAt: null }),
    };
    const republished: string[] = [];
    const handle = createDeliveryHandler({
      queue: "akashic.mail",
      handlers: mailHandlers(mailer),
      retryQueue: "akashic.mail.retry",
      deadQueue: "akashic.mail.dead",
      maxAttempts: 5,
      republish: async (queue) => void republished.push(queue),
      signal: () => new AbortController().signal,
      shutdown: createLifecycle(logger).signal,
      log: logger,
    });
    const delivery = {
      body: message,
      messageId: "evt-1",
      type: "mail.requested",
      routingKey: "mail.requested",
      headers: {},
    } as Parameters<typeof handle>[0];
    await handle(delivery);
    expect(republished).toEqual(["akashic.mail.retry"]);
  });
});

describe("mailer failures", () => {
  const failing = () =>
    createResendMailer({
      apiKey: "re_test",
      from: "Akashic <noreply@example.test>",
      timeoutMs: 1000,
      logLinks: false,
      logger,
      signal: new AbortController().signal,
      client: {
        emails: {
          send: async () => ({ data: null, error: { message: "rejected" } }),
        },
      } as never,
    });

  test("send throws, and /mail-status still reports the failure", async () => {
    const mailer = failing();
    await expect(mailer.send(message, { idempotencyKey: "evt-1" })).rejects.toMatchObject({
      code: "external.resend.delivery_failed",
    });
    const app = new Hono<AppEnv>().route("/", metaRoutes({ service: "akashic", mailer }));
    expect(await (await app.request("/mail-status")).json()).toMatchObject({
      configured: true,
      healthy: false,
      lastFailure: "rejected",
    });
  });

  test("the idempotency key reaches Resend", async () => {
    const seen: unknown[] = [];
    const mailer = createResendMailer({
      apiKey: "re_test",
      from: "a@b.test",
      timeoutMs: 1000,
      logLinks: false,
      logger,
      signal: new AbortController().signal,
      client: {
        emails: {
          send: async (_payload: unknown, options: unknown) => {
            seen.push(options);
            return { data: { id: "1" }, error: null };
          },
        },
      } as never,
    });
    await mailer.send(message, { idempotencyKey: "evt-9" });
    expect(seen).toEqual([{ idempotencyKey: "evt-9" }]);
  });
});

const database = createDb({
  url: Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic",
  poolMax: 2,
  idleTimeoutS: 5,
  connectTimeoutS: 2,
  logger: silentLogger(),
});
const live = await database.ping();
afterAll(() => database[Symbol.asyncDispose]());

describe.skipIf(!live)("sign-up", () => {
  test("writes one pending mail.requested event and sends nothing", async () => {
    const email = `mail-${Bun.randomUUIDv7()}@example.test`;
    await withRollback(database.db, async (tx) => {
      const auth = createAuth({
        appName: "Akashic Records",
        cookiePrefix: "akashic",
        db: tx,
        secret: "test-secret-test-secret-test-secret!",
        baseUrl: "http://localhost:3000",
        trustedOrigins: ["http://localhost:5173"],
        clock: fixedClock("2026-06-01T00:00:00Z"),
        sessionExpiryDays: 7,
        sessionCacheS: 60,
        secureCookies: false,
        logger,
      });
      await auth.api.signUpEmail({
        body: { email, password: "correct-horse-battery-staple", name: "Mail Test" },
      });

      const rows = await tx
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.messageType, "mail.requested"));
      const mine = rows.filter((row) => (row.payload as { to: string }).to === email);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ status: OutboxStatus.pending, routingKey: "mail.requested" });
      expect(mine[0]?.payload).toMatchObject({
        to: email,
        subject: "Verify your Akashic Records email",
      });
      expect((await tx.select().from(user).where(eq(user.email, email))).length).toBe(1);
    });
  });
});
