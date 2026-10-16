import type { Logger } from './log.ts';

export type Phase = 'starting' | 'ready' | 'draining' | 'stopped';

/**
 * Where the process is in its life, and the root signal every long-running loop watches. It
 * doesn't own teardown: the container disposes what it built, in reverse. This only says when.
 */
export interface Lifecycle {
	readonly signal: AbortSignal;
	phase(): Phase;
	isReady(): boolean;
	isAlive(): boolean;
	markReady(): void;
	/** Readiness fails from here; requests in flight carry on. */
	beginDraining(reason: string): void;
	/** Tells everything still running to stop. */
	abort(reason: string): void;
	markStopped(): void;
	/** Aborts on shutdown, on timeout, or on any of the given signals. */
	linkedSignal(timeoutMs: number, ...signals: (AbortSignal | undefined)[]): AbortSignal;
}

export function createLifecycle(logger: Logger): Lifecycle {
	const log = logger.child({ component: 'lifecycle' });
	const root = new AbortController();
	let phase: Phase = 'starting';

	return {
		signal: root.signal,
		phase: () => phase,
		isReady: () => phase === 'ready',
		isAlive: () => phase !== 'stopped',
		markReady() {
			phase = 'ready';
			log.info('ready');
		},
		beginDraining(reason) {
			if (phase === 'draining' || phase === 'stopped') return;
			phase = 'draining';
			log.info({ reason }, 'draining');
		},
		abort(reason) {
			if (!root.signal.aborted) root.abort(new Error(`shutting down: ${reason}`));
		},
		markStopped() {
			phase = 'stopped';
			log.info('stopped');
		},
		linkedSignal(timeoutMs, ...signals) {
			return AbortSignal.any([
				root.signal,
				AbortSignal.timeout(timeoutMs),
				...signals.filter((s): s is AbortSignal => s !== undefined),
			]);
		},
	};
}

/**
 * `value`, released by `release` when its owner disposes it. For things the container builds.
 * A value that is already disposable keeps its own disposal: this one runs it first, then
 * `release`. Disposal happens once; later calls return the first one's promise.
 */
export function owned<T extends object>(
	value: T,
	release: () => Promise<void> | void,
): T & AsyncDisposable {
	const previous = (value as Partial<AsyncDisposable>)[Symbol.asyncDispose]?.bind(value);
	let disposal: Promise<void> | undefined;
	return Object.assign(value, {
		[Symbol.asyncDispose]() {
			disposal ??= (async () => {
				await previous?.();
				await release();
			})();
			return disposal;
		},
	});
}

export interface SignalOptions {
	shutdown: (reason: string) => Promise<void>;
	/** After this, exit whether or not shutdown finished. */
	hardExitMs: number;
	logger: Logger;
	exit?: (code: number) => void;
	on?: (signal: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * The one place process signals are handled. The first SIGTERM or SIGINT shuts down and exits 0;
 * a second, or the hard deadline, exits 1 at once. A crash shuts down and exits 1.
 */
export function handleSignals(options: SignalOptions): void {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const on =
		options.on ??
		((signal: string, listener: (...args: unknown[]) => void) => {
			process.on(signal, listener);
		});
	const log = options.logger.child({ component: 'lifecycle' });
	let stopping = false;

	const stop = (reason: string, code: number) => {
		if (stopping) {
			log.warn({ reason }, 'second signal, exiting now');
			exit(1);
			return;
		}
		stopping = true;
		setTimeout(() => {
			log.error('shutdown exceeded its deadline, exiting');
			exit(1);
		}, options.hardExitMs).unref();
		options.shutdown(reason).then(
			() => exit(code),
			(error: unknown) => {
				log.error({ err: error }, 'shutdown failed');
				exit(1);
			},
		);
	};

	on('SIGTERM', () => stop('SIGTERM', 0));
	on('SIGINT', () => stop('SIGINT', 0));
	// A crash arrives with its error, which is logged before shutdown starts.
	on('unhandledRejection', (error) => {
		log.fatal({ err: error }, 'unhandled rejection');
		stop('unhandledRejection', 1);
	});
	on('uncaughtException', (error) => {
		log.fatal({ err: error }, 'uncaught exception');
		stop('uncaughtException', 1);
	});
}
