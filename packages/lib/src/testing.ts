// Test helpers. Only tests import this subpath, so production never loads the SDK pieces below.
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { expect } from 'bun:test';
import { pino } from 'pino';
import type { AppError } from './errors.ts';
import type { Logger } from './log.ts';
import type { ErrorOf, Result } from './result.ts';

// OpenTelemetry ignores a second global registration, and `bun test` runs every file in one
// process, so the provider is registered once and every caller shares its exporter.
let exporter: InMemorySpanExporter | undefined;

/** Registers an in-memory tracer (once per process); callers `reset()` in beforeEach and find their spans by name. */
export function recordSpans() {
	if (!exporter) {
		exporter = new InMemorySpanExporter();
		context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
		// Production gets this from NodeSDK; a bare provider has no propagator, so traceparent is ignored.
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		trace.setGlobalTracerProvider(
			new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
		);
	}
	const shared = exporter;
	return { spans: () => shared.getFinishedSpans(), reset: () => shared.reset() };
}

/** A real logger at `trace` level whose lines are parsed into `lines`, so a test can assert on them. */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
	const lines: Record<string, unknown>[] = [];
	const logger = pino(
		{ level: 'trace' },
		{ write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
	);
	return { logger, lines };
}

/** The value of a Result that must have succeeded; fails the test with the error otherwise. */
export function expectOk<T>(result: Result<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

type Ctor<T> = abstract new (...args: never[]) => T;
// The errors whose code can be K; an untyped AppError's code is any string, so it stays.
type WithCode<E, K> = E extends { code: infer C } ? (K extends C ? E : never) : never;

/**
 * The error of a Result that must have failed with `expected`: a class, which narrows the error
 * to it, or a code. Either must be one the result's type can hold.
 */
export function expectErr<R extends Result<unknown, AppError>, C extends ErrorOf<R>>(
	result: R,
	expected: Ctor<C>,
): C;
export function expectErr<R extends Result<unknown, AppError>, K extends ErrorOf<R>['code']>(
	result: R,
	expected: K,
): WithCode<ErrorOf<R>, K>;
export function expectErr(
	result: Result<unknown, AppError>,
	expected: string | Ctor<AppError>,
): AppError {
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error('unreachable');
	if (typeof expected === 'string') expect(result.error.code).toBe(expected);
	else expect(result.error).toBeInstanceOf(expected);
	return result.error;
}
