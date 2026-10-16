import { createCircuitBreaker, CircuitOpenError } from '@akashic/lib/circuit-breaker';
import type { Logger } from '@akashic/lib/log';
import { isRetryableStatus, retryDelayMs } from '@akashic/lib/retry';
import { systemClock } from '@akashic/lib/time';

/** The model was unreachable, refused, or answered with something unusable. */
class AiUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'AiUnavailableError';
	}
}

export interface ModelClientOptions {
	baseUrl: string;
	headers: Record<string, string>;
	attempts: number;
	timeoutMs: number;
	logger: Logger;
}

export interface ModelClient {
	/** POSTs JSON. Retries 429 and 5xx; everything else becomes AiUnavailableError at once. */
	post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		detail: string,
	) {
		super(`model returned ${status}: ${detail}`);
	}
}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

export function createModelClient(options: ModelClientOptions): ModelClient {
	const log = options.logger;
	const breaker = createCircuitBreaker({
		failureThreshold: 5,
		cooldown: { seconds: 30 },
		clock: systemClock,
		ignore: isAbort,
		onStateChange: (from, to) => log.warn({ from, to }, 'model circuit changed state'),
	});

	async function attempt<T>(path: string, payload: string, signal?: AbortSignal): Promise<T> {
		const response = await fetch(`${options.baseUrl}/${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...options.headers },
			body: payload,
			signal: AbortSignal.any([
				AbortSignal.timeout(options.timeoutMs),
				...(signal ? [signal] : []),
			]),
		});
		if (!response.ok) throw new HttpError(response.status, (await response.text()).slice(0, 512));
		return (await response.json()) as T;
	}

	return {
		async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
			const payload = JSON.stringify(body);

			for (let n = 1; ; n++) {
				signal?.throwIfAborted();
				try {
					return await breaker.run(() => attempt<T>(path, payload, signal));
				} catch (error) {
					if (isAbort(error) && signal?.aborted) throw error;
					if (error instanceof CircuitOpenError) throw new AiUnavailableError(error.message);

					const retryable = !(error instanceof HttpError) || isRetryableStatus(error.status);
					if (!retryable || n >= options.attempts) {
						log.warn({ path, attempt: n, err: error }, 'model call failed');
						throw new AiUnavailableError('The language model did not answer.', { cause: error });
					}
					await Bun.sleep(retryDelayMs(n - 1, 250, 2000));
				}
			}
		},
	};
}

/** Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateBytes(text: string, maxBytes: number): string {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return new TextDecoder().decode(bytes.subarray(0, end));
}
