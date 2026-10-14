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
 * Whether a throw means "told to stop": an AbortError, or the reason of the signal the work was
 * given (a deadline's TimeoutError, a shutdown's Error). Anything else thrown is a failure.
 */
const isCancellation = (error: unknown, signal: AbortSignal | undefined): boolean =>
  (error instanceof DOMException && error.name === "AbortError") ||
  (signal?.aborted === true && error === signal.reason);

/**
 * Marks the span for a throw. A cancellation isn't failing. Otherwise only the error's name and
 * code are recorded: a driver's message can carry row values (an email in a unique violation),
 * and spans leave the process. An AppError's message was written for clients, so it stays.
 */
function recordThrow(span: Span, error: unknown, signal: AbortSignal | undefined): void {
  if (isCancellation(error, signal)) {
    span.setAttribute("akashic.cancelled", true);
    return;
  }
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  const type = typeof code === "string" ? code : name;
  const message = error instanceof AppError ? error.message : type;
  span.recordException({ name, message, ...(typeof code === "string" && { code }) });
  span.setAttribute("error.type", type);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Runs `fn` in an active span and always ends it. A throw is recorded by `recordThrow`; a
 * returned `err` marks the span failed with its code, so a business refusal shows in the trace
 * without being an exception. `signal` is the one the work runs under, so its abort reads as
 * cancelled.
 */
export function traced<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
  options: { kind?: SpanKind; signal?: AbortSignal } = {},
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
      recordThrow(span, error, options.signal);
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
 * published with, the span continues the trace of the request that caused it. `signal` is the
 * handler's, so a handler stopped by it reads as cancelled.
 */
export function withConsumerSpan<T>(
  name: string,
  traceparent: string | undefined,
  fn: () => Promise<T>,
  attributes?: Attributes,
  signal?: AbortSignal,
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
        recordThrow(span, error, signal);
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
