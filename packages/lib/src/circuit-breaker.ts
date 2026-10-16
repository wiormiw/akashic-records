import type { Clock } from './time.ts';

/**
 * Stops calling a dependency already known to be failing, so a slow failure becomes a fast one.
 *
 *   closed ── failures >= threshold ──> open ── cooldown elapsed ──> half-open
 *     ^                                                                 │
 *     └────────────── probe succeeds ─────────────── probe fails ──> open
 *
 * State is per process: each replica trips on what it has seen itself.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitOptions {
	readonly failureThreshold: number;
	readonly cooldown: Temporal.DurationLike;
	readonly clock: Clock;
	/** Errors that say nothing about the dependency's health, such as the caller aborting. */
	readonly ignore?: (error: unknown) => boolean;
	/** The breaker doesn't log; wire this to a logger. */
	readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export interface CircuitBreaker {
	/** Runs `operation`, or throws `CircuitOpenError` without calling it when open. */
	run<T>(operation: () => Promise<T>): Promise<T>;
	state(): CircuitState;
}

/** "We didn't try", as opposed to "we tried and it failed". Expected during an outage. */
export class CircuitOpenError extends Error {
	constructor(public readonly retryAfter: Temporal.Duration) {
		super(`Circuit is open; retry in ${Math.ceil(retryAfter.total('seconds'))}s`);
		this.name = 'CircuitOpenError';
	}
}

export function createCircuitBreaker(options: CircuitOptions): CircuitBreaker {
	const { failureThreshold, clock, onStateChange } = options;
	const cooldown = Temporal.Duration.from(options.cooldown);

	let state: CircuitState = 'closed';
	let consecutiveFailures = 0;
	let reopensAt = clock.now();

	function transition(next: CircuitState): void {
		if (next === state) return;
		const previous = state;
		state = next;
		onStateChange?.(previous, next);
	}

	return {
		state: () => state,

		async run<T>(operation: () => Promise<T>): Promise<T> {
			if (state === 'open') {
				const now = clock.now();
				if (Temporal.Instant.compare(now, reopensAt) < 0) {
					throw new CircuitOpenError(now.until(reopensAt));
				}
				transition('half-open');
			}

			try {
				const result = await operation();
				consecutiveFailures = 0;
				transition('closed');
				return result;
			} catch (error) {
				if (options.ignore?.(error)) throw error;
				consecutiveFailures += 1;

				// A failed probe re-opens at once: counting to the threshold again would send more
				// doomed requests just to confirm what the probe already said.
				if (state === 'half-open' || consecutiveFailures >= failureThreshold) {
					reopensAt = clock.now().add(cooldown);
					transition('open');
				}
				throw error;
			}
		},
	};
}
