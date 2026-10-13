import { Hono } from "hono";
import type { Logger } from "@akashic/lib/log";
import type { Auth } from "@/auth/auth.ts";
import type { RateLimiter, RateLimitRule } from "@/integrations/rate-limit.ts";
import type { AppEnv } from "./env.ts";
import { rateLimit } from "./rate-limit.ts";

const PREFIX = "/api/auth";

// Where a guessed password or a flood of mail costs something.
const CREDENTIAL_PATHS = [
  "/sign-in",
  "/sign-up",
  "/reset-password",
  "/forget-password",
  "/send-verification-email",
  "/change-password",
];

/** better-auth under /api/auth, with a tighter budget on the credential endpoints. */
export function authRoutes(options: {
  auth: Auth;
  limiter: RateLimiter;
  ordinary: RateLimitRule;
  credentials: RateLimitRule;
  trustProxy: boolean;
  logger: Logger;
}) {
  const app = new Hono<AppEnv>();
  app.use(`${PREFIX}/*`, rateLimit(options.limiter, options.ordinary, options));
  for (const path of CREDENTIAL_PATHS) {
    app.use(`${PREFIX}${path}*`, rateLimit(options.limiter, options.credentials, options));
  }
  // The raw request, so better-auth reads the body itself and routes on the full path.
  app.on(["GET", "POST"], `${PREFIX}/*`, (c) => options.auth.handler(c.req.raw));
  return app;
}
