import type { AppError, ErrorKind } from './errors.ts';

/** The only place an error kind becomes an HTTP status. */
export const httpStatusByKind: Record<ErrorKind, number> = {
	validation: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	conflict: 409,
	rate_limited: 429,
	// A dependency being down isn't our bug; 502 keeps it out of the 500 alerts.
	external: 502,
	// Shutting down, not failing: the client retries after Retry-After.
	unavailable: 503,
	internal: 500,
};

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** RFC 9457 problem details. */
export interface ProblemBody {
	type: string;
	title: string;
	status: number;
	detail: string;
	code: string;
	details?: Readonly<Record<string, unknown>>;
	traceId: string;
}

const TYPE_BASE = 'https://akashic.dev/errors/';

const titleByKind: Record<ErrorKind, string> = {
	validation: 'Validation failed',
	unauthorized: 'Authentication required',
	forbidden: 'Forbidden',
	not_found: 'Not found',
	conflict: 'Conflict',
	rate_limited: 'Too many requests',
	external: 'Upstream service failed',
	unavailable: 'Service unavailable',
	internal: 'Unexpected error',
};

export function toProblem(error: AppError, traceId: string): { body: ProblemBody; status: number } {
	const status = httpStatusByKind[error.kind];
	return {
		status,
		body: {
			type: `${TYPE_BASE}${error.code}`,
			title: titleByKind[error.kind],
			status,
			// An internal message can carry connection strings or row data; the trace id finds it.
			detail:
				error.kind === 'internal'
					? 'An unexpected error occurred. The trace id identifies this request in the logs.'
					: error.message,
			code: error.code,
			...(error.details ? { details: error.details } : {}),
			traceId,
		},
	};
}
