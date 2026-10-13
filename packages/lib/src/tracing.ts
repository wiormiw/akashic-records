import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Attributes,
  type Span,
  type TextMapGetter,
} from "@opentelemetry/api";
import { AppError } from "./errors.ts";

export const tracer = () => trace.getTracer("akashic");

/** A returned Result that failed. Recognised structurally, so lib doesn't depend on its callers. */
const isFailedResult = (value: unknown): value is { ok: false; error: AppError } =>
  typeof value === "object" &&
  value !== null &&
  (value as { ok?: unknown }).ok === false &&
  (value as { error?: unknown }).error instanceof AppError;

/**
 * Runs `fn` in an active span and always ends it. A throw is recorded as an exception; an abort is
 * marked cancelled instead, since being told to stop isn't failing; a returned `err` marks the span
 * failed with its code, so a business refusal shows in the trace without being an exception.
 */
export function traced<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: { kind?: SpanKind } = {},
): Promise<T> {
  return tracer().startActiveSpan(name, { attributes, kind: options.kind }, async (span) => {
    try {
      const value = await fn(span);
      if (isFailedResult(value)) {
        span.setAttribute("akashic.error.code", value.error.code);
        span.setStatus({ code: SpanStatusCode.ERROR, message: value.error.message });
      }
      return value;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        span.setAttribute("akashic.cancelled", true);
      } else {
        const thrown = error instanceof Error ? error : new Error(String(error));
        span.recordException(thrown);
        span.setStatus({ code: SpanStatusCode.ERROR, message: thrown.message });
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

export { SpanKind } from "@opentelemetry/api";

const recordGetter: TextMapGetter<Record<string, string>> = {
  get: (carrier, key) => carrier[key],
  keys: (carrier) => Object.keys(carrier),
};

/**
 * Runs the handling of one consumed message in a consumer span. With the `traceparent` it was
 * published with, the span continues the trace of the request that caused it.
 */
export function withConsumerSpan<T>(
  name: string,
  traceparent: string | undefined,
  fn: () => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  const parent = traceparent
    ? propagation.extract(context.active(), { traceparent }, recordGetter)
    : context.active();
  return context.with(parent, () =>
    tracer().startActiveSpan(name, { kind: SpanKind.CONSUMER, attributes }, async (span) => {
      try {
        const result = await fn();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        const thrown = error instanceof Error ? error : new Error(String(error));
        span.recordException(thrown);
        span.setStatus({ code: SpanStatusCode.ERROR, message: thrown.message });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}

/** The active span as a W3C traceparent, so work done later can join this trace. */
export function currentTraceparent(): string | undefined {
  const span = trace.getActiveSpan();
  if (!span) return undefined;
  const { traceId, spanId, traceFlags } = span.spanContext();
  return `00-${traceId}-${spanId}-${traceFlags.toString(16).padStart(2, "0")}`;
}
