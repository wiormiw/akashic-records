// Test helpers. Only tests import this subpath, so production never loads the SDK pieces below.
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { expect } from "bun:test";
import { pino } from "pino";
import type { AppError } from "./errors.ts";
import type { Logger } from "./log.ts";
import type { Result } from "./result.ts";

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
    { level: "trace" },
    { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) },
  );
  return { logger, lines };
}

/** The value of a Result that must have succeeded; fails the test with the error otherwise. */
export function expectOk<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The AppError of a Result that must have failed with `code`. */
export function expectErr<T>(result: Result<T>, code: string): AppError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unreachable");
  expect(result.error.code).toBe(code);
  return result.error;
}
