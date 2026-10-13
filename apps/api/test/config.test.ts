import { describe, expect, test } from "bun:test";
import { loadEnv } from "@akashic/lib/config";
import { Env } from "@/config.ts";

// The keys .env.example requires, with dummy values; everything else takes its default.
const required = {
  DATABASE_URL: "postgres://akashic:akashic@localhost:5432/akashic",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  FGA_STORE_ID: "01TESTSTORE",
  RABBITMQ_URL: "amqp://akashic:akashic@localhost:5672",
};

describe("api config", () => {
  test("defaults apply to everything not set", () => {
    const env = loadEnv(Env, required);
    expect(env.PORT).toBe(3000);
    expect(env.OUTBOX_BATCH_SIZE).toBe(50);
    expect(env.RABBITMQ_MAX_ATTEMPTS).toBe(5);
    expect(env.AI_EMBED_MODEL).toBe("gemini-embedding-001");
    expect(env.OTEL_SERVICE_NAME).toBe("akashic");
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.OUTBOX_DISPATCHER_ENABLED).toBe(true);
    expect(env.AI_PROVIDER).toBeUndefined();
  });

  test("omitting RABBITMQ_URL names it", () => {
    const { RABBITMQ_URL: _omitted, ...rest } = required;
    expect(() => loadEnv(Env, rest)).toThrow(/RABBITMQ_URL/u);
  });

  test("a short auth secret and a bad provider are both reported", () => {
    const raw = { ...required, BETTER_AUTH_SECRET: "short", AI_PROVIDER: "nope" };
    expect(() => loadEnv(Env, raw)).toThrow(/BETTER_AUTH_SECRET: must be at least 32 chars/u);
    expect(() => loadEnv(Env, raw)).toThrow(/AI_PROVIDER/u);
  });
});
