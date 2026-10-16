import { HTTPException } from 'hono/http-exception';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import {
	AppError,
	RequestTimeout,
	RouteNotFound,
	ServiceUnavailable,
	UnexpectedError,
	ValidationFailed,
} from '@akashic/lib/errors';
import type { Logger } from '@akashic/lib/log';
import { isTimeout } from '@akashic/lib/tracing';
import { PROBLEM_CONTENT_TYPE, toProblem } from '@akashic/lib/problem';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './env.ts';

// nginx's "client closed request": keeps disconnects out of the 5xx count.
const CLIENT_CLOSED_REQUEST = 499;
// Seconds a client cut off by shutdown waits before retrying; another instance takes it by then.
const SHUTDOWN_RETRY_AFTER = '5';

/** The problem+json response for a failure; also how `respond` renders a returned `err`. */
export function problemResponse<E extends AppEnv>(c: Context<E>, failure: AppError): Response {
	const { body, status } = toProblem(failure, c.get('requestId') ?? '');
	// newResponse, not `new Response`, so headers set earlier (request id, CORS, Retry-After) ride along.
	return c.newResponse(JSON.stringify(body), status as ContentfulStatusCode, {
		'content-type': PROBLEM_CONTENT_TYPE,
	});
}

/**
 * The one place a thrown failure becomes a response. `shutdown` is the lifecycle's signal: a
 * handler that throws because it aborted was cut off, not failing, and is told to retry.
 */
export function problemHandler(logger: Logger, shutdown?: AbortSignal): ErrorHandler<AppEnv> {
	const log = logger.child({ component: 'http' });
	return (error, c) => {
		if (c.req.raw.signal.aborted) return new Response(null, { status: CLIENT_CLOSED_REQUEST });

		const failure = classify(error, c.get('signal'), shutdown);
		const traceId = c.get('requestId');
		if (failure instanceof ServiceUnavailable) {
			c.header('retry-after', SHUTDOWN_RETRY_AFTER);
			log.info({ path: c.req.path, method: c.req.method, traceId }, 'request cut off by shutdown');
		} else if (failure.kind === 'internal') {
			log.error({ err: error, path: c.req.path, method: c.req.method, traceId }, 'unhandled error');
		} else if (failure.kind === 'external') {
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
	problemResponse(c, new RouteNotFound(`No route for ${c.req.path}.`));

/**
 * Maps whatever escaped a handler onto the error vocabulary. `signal` is the request's: an abort
 * raised because its deadline fired is the timeout it was, not a bug, and one raised because
 * `shutdown` fired is a 503.
 */
function classify(
	error: unknown,
	signal: AbortSignal | undefined,
	shutdown: AbortSignal | undefined,
): AppError {
	if (error instanceof AppError) return error;
	if (error instanceof HTTPException) {
		// Hono's own parsing and body-limit failures: the caller's mistake, not our bug.
		if (error.status === 400) {
			return new ValidationFailed('Request body could not be parsed.');
		}
		if (error.status >= 400 && error.status < 500) {
			return new ValidationFailed('The request could not be processed.');
		}
	}
	const timedOut =
		error instanceof DOMException &&
		(error.name === 'TimeoutError' ||
			(error.name === 'AbortError' && signal?.aborted === true && isTimeout(signal.reason)));
	if (timedOut) {
		return new RequestTimeout();
	}
	// Only the shutdown's own reason, as such or through the request's signal: an AbortError
	// of another making during shutdown is still whatever failure it was.
	const cutOff =
		shutdown?.aborted === true && (error === shutdown.reason || error === signal?.reason);
	if (cutOff) return new ServiceUnavailable(undefined, { cause: error });
	return new UnexpectedError('Unexpected error', { cause: error });
}
