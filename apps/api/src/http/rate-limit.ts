import { getConnInfo } from "hono/bun";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { ErrorCode, fail } from "@akashic/lib/errors";
import type { Logger } from "@akashic/lib/log";
import type { RateLimiter, RateLimitRule } from "@/integrations/rate-limit.ts";
import type { AppEnv } from "./env.ts";

/** Enforces `rule` per account once known, else per IP, and sets the RateLimit headers. */
export function rateLimit(
  limiter: RateLimiter,
  rule: RateLimitRule,
  options: { trustProxy: boolean; logger?: Logger },
) {
  const log = options.logger?.child({ component: "rate-limit" });
  return createMiddleware<AppEnv>(async (c, next) => {
    const user = c.get("user");
    const caller = user ? `u:${user.id}` : `ip:${clientIp(c, options.trustProxy)}`;
    const counter = await limiter.hit(rule, caller);
    // No counter means the store couldn't answer. Fail open: failing closed turns a cache outage
    // into a total outage.
    if (counter) {
      c.header("ratelimit-limit", String(rule.limit));
      c.header("ratelimit-remaining", String(Math.max(rule.limit - counter.count, 0)));
      c.header("ratelimit-reset", String(counter.resetSeconds));
      if (counter.count > rule.limit) {
        c.header("retry-after", String(counter.resetSeconds));
        log?.warn({ bucket: rule.bucket, caller, count: counter.count }, "rate limit exceeded");
        throw fail.rateLimited(ErrorCode.common.rateLimited, "Too many requests. Slow down.", {
          details: {
            limit: rule.limit,
            windowSeconds: rule.windowSeconds,
            retryAfter: counter.resetSeconds,
          },
        });
      }
    }
    await next();
  });
}

function clientIp(c: Context<AppEnv>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  try {
    return c.req.header("x-real-ip") ?? getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // `app.request()` in tests has no socket.
    return "unknown";
  }
}
