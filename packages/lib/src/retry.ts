/** 429 and 5xx are worth another attempt. A 4xx is the request being wrong; retrying burns quota. */
export function isRetryableStatus(status: number): boolean {
	return status === 429 || status >= 500;
}

/**
 * Exponential backoff, capped, then jittered to 50–150% so replicas that failed together don't
 * retry together. Milliseconds, because that's what `Bun.sleep` and `setTimeout` take.
 */
export function retryDelayMs(attempt: number, baseMs = 250, capMs = 8000): number {
	return Math.min(2 ** attempt * baseMs, capMs) * (0.5 + Math.random());
}
