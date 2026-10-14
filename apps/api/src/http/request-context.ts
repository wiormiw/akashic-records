import { httpInstrumentationMiddleware } from "@hono/otel";
import { trace } from "@opentelemetry/api";
import { createMiddleware } from "hono/factory";
import type { Lifecycle } from "@akashic/lib/lifecycle";
import type { Logger } from "@akashic/lib/log";
import { ErrorCode, fail } from "@akashic/lib/errors";
import { recordThrow } from "@akashic/lib/tracing";
import type { AppEnv } from "./env.ts";
import { problemResponse } from "./problem.ts";

export const REQUEST_ID_HEADER = "x-request-id";

// Probed every few seconds by the orchestrator; a trace each would bury the real traffic.
const UNTRACED_PATHS = new Set(["/livez", "/readyz"]);

/** A server span, a request id, a deadline signal, and one access-log line per response. */
export function requestContext(options: {
  budgetMs: number;
  logger: Logger;
  lifecycle: Lifecycle;
  service: string;
}) {
  const log = options.logger.child({ component: "http" });
  const traced = httpInstrumentationMiddleware({ serviceName: options.service });

  const context = createMiddleware<AppEnv>(async (c, next) => {
    const startedAt = performance.now();
    // Honours the proxy's id, so one id follows the request end to end.
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? Bun.randomUUIDv7();
    c.set("requestId", requestId);
    c.set("user", null);
    const deadline = AbortSignal.timeout(options.budgetMs);
    c.set("signal", AbortSignal.any([c.req.raw.signal, deadline, options.lifecycle.signal]));
    c.header(REQUEST_ID_HEADER, requestId);

    await next();

    // Checked after the handler rather than raced against it, so nothing keeps running once the
    // response is sent.
    if (deadline.aborted && !c.req.raw.signal.aborted && c.res.status < 400) {
      c.res = problemResponse(
        c,
        fail.external(ErrorCode.common.timeout, "The request took too long."),
      );
    }
    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        requestId,
        ms: Math.round(performance.now() - startedAt),
      },
      "request",
    );
  });

  return createMiddleware<AppEnv>((c, next) =>
    UNTRACED_PATHS.has(c.req.path)
      ? context(c, next)
      : traced(c, async () => {
          await context(c, next);
          // @hono/otel records `c.error` as is, message and stack, when it ends the server span;
          // a driver's message can carry row values. Record it scrubbed here and leave it nothing.
          // The problem response and its log line were written before this point.
          if (c.error) {
            const span = trace.getActiveSpan();
            if (span) recordThrow(span, c.error, c.get("signal"));
            c.error = undefined;
          }
        }),
  );
}
