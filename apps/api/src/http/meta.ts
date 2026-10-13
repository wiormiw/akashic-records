import { Hono } from "hono";
import * as v from "valibot";
import { MailStatusView } from "@akashic/contracts";
import type { Lifecycle } from "@akashic/lib/lifecycle";
import type { Mailer } from "@/integrations/mail.ts";
import type { AppEnv } from "./env.ts";
import { reply } from "./reply.ts";

type Check = () => Promise<boolean>;

const runAll = async (checks: Record<string, Check>) =>
  Object.fromEntries(
    await Promise.all(Object.entries(checks).map(async ([name, check]) => [name, await check()])),
  );

const DrainingView = v.object({ status: v.literal("draining") });
// Check names vary per deployment, so the checks pass through as booleans beside the status.
const ReadinessView = v.looseObject({ status: v.string() });

/**
 * `/livez` while the process runs; `/readyz` once started and every required check passes.
 * An optional failure (Redis) is reported but keeps the instance in rotation.
 */
export function healthRoutes(options: {
  lifecycle: Lifecycle;
  required: Record<string, Check>;
  optional: Record<string, Check>;
}) {
  return (
    new Hono<AppEnv>()
      // Plain text, as probes and the old API expect; `reply` only sends JSON.
      .get("/livez", (c) => (options.lifecycle.isAlive() ? c.text("ok") : c.text("stopped", 503)))
      .get("/readyz", async (c) => {
        if (!options.lifecycle.isReady())
          return reply(c, DrainingView, { status: "draining" }, 503);

        const [required, optional] = await Promise.all([
          runAll(options.required),
          runAll(options.optional),
        ]);
        if (!Object.values(required).every(Boolean))
          return reply(c, ReadinessView, { status: "degraded", ...required, ...optional }, 503);

        return reply(c, ReadinessView, {
          status: Object.values(optional).every(Boolean) ? "ready" : "ready-degraded",
          ...required,
          ...optional,
        });
      })
  );
}

const ApiDescriptionView = v.object({
  service: v.string(),
  authentication: v.object({
    scheme: v.string(),
    signUp: v.string(),
    signIn: v.string(),
    signOut: v.string(),
  }),
  api: v.string(),
  health: v.object({ live: v.string(), ready: v.string() }),
  errors: v.string(),
});

/** `GET /` describes the API; `GET /mail-status` lets sign-up warn when mail is down. */
export function metaRoutes(options: { service: string; mailer: Mailer }) {
  return new Hono<AppEnv>()
    .get("/", (c) =>
      reply(c, ApiDescriptionView, {
        service: options.service,
        authentication: {
          scheme: "cookie session",
          signUp: "POST /api/auth/sign-up/email",
          signIn: "POST /api/auth/sign-in/email",
          signOut: "POST /api/auth/sign-out",
        },
        api: "/api/v1",
        health: { live: "GET /livez", ready: "GET /readyz" },
        errors: "application/problem+json (RFC 9457)",
      }),
    )
    .get("/mail-status", (c) => {
      const health = options.mailer.health();
      return reply(c, MailStatusView, { ...health, failedAt: health.failedAt?.toString() ?? null });
    });
}
