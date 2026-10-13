import { HTTPException } from "hono/http-exception";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { AppError, ErrorCode, fail } from "@akashic/lib/errors";
import type { Logger } from "@akashic/lib/log";
import { PROBLEM_CONTENT_TYPE, toProblem } from "@akashic/lib/problem";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "./env.ts";

// nginx's "client closed request": keeps disconnects out of the 5xx count.
const CLIENT_CLOSED_REQUEST = 499;

/** The problem+json response for a failure; also how `respond` renders a returned `err`. */
export function problemResponse(c: Context<AppEnv>, failure: AppError): Response {
  const { body, status } = toProblem(failure, c.get("requestId") ?? "");
  // newResponse, not `new Response`, so headers set earlier (request id, CORS, Retry-After) ride along.
  return c.newResponse(JSON.stringify(body), status as ContentfulStatusCode, {
    "content-type": PROBLEM_CONTENT_TYPE,
  });
}

/** The one place a thrown failure becomes a response. */
export function problemHandler(logger: Logger): ErrorHandler<AppEnv> {
  const log = logger.child({ component: "http" });
  return (error, c) => {
    if (c.req.raw.signal.aborted) return new Response(null, { status: CLIENT_CLOSED_REQUEST });

    const failure = classify(error);
    const traceId = c.get("requestId");
    if (failure.kind === "internal") {
      log.error({ err: error, path: c.req.path, method: c.req.method, traceId }, "unhandled error");
    } else if (failure.kind === "external") {
      // A dependency failing is worth a line; a 4xx is the API working.
      log.warn(
        { err: failure.cause ?? failure, code: failure.code, path: c.req.path, traceId },
        failure.message,
      );
    }
    return problemResponse(c, failure);
  };
}

export const notFound: NotFoundHandler<AppEnv> = (c) =>
  problemResponse(c, fail.notFound(ErrorCode.common.routeNotFound, `No route for ${c.req.path}.`));

/** Maps whatever escaped a handler onto the error vocabulary. */
function classify(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof HTTPException) {
    // Hono's own parsing and body-limit failures: the caller's mistake, not our bug.
    if (error.status === 400) {
      return fail.validation(ErrorCode.common.validation, "Request body could not be parsed.");
    }
    if (error.status >= 400 && error.status < 500) {
      return fail.validation(ErrorCode.common.validation, "The request could not be processed.");
    }
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return fail.external(ErrorCode.common.timeout, "The request took too long.");
  }
  return fail.internal(ErrorCode.common.unexpected, "Unexpected error", { cause: error });
}
