import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

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
