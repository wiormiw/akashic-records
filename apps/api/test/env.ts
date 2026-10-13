import { loadEnv } from "@akashic/lib/config";
import { Env } from "@/config.ts";

/** A valid environment for tests, pointing at the compose services. */
export const testEnv = (overrides: Record<string, string> = {}) =>
  loadEnv(Env, {
    NODE_ENV: "test",
    LOG_LEVEL: "fatal",
    DATABASE_URL: Bun.env.DATABASE_URL ?? "postgres://akashic:akashic@localhost:5432/akashic",
    RABBITMQ_URL: Bun.env.RABBITMQ_URL ?? "amqp://akashic:akashic@localhost:5672",
    // Left unset when absent, so tests that need Redis skip rather than fail.
    ...(Bun.env.REDIS_URL ? { REDIS_URL: Bun.env.REDIS_URL } : {}),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret!",
    BETTER_AUTH_URL: "http://localhost:3000",
    // A well-formed ULID: the OpenFGA SDK rejects anything else before sending.
    FGA_STORE_ID: Bun.env.FGA_STORE_ID ?? "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    ...overrides,
  });
