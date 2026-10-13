import { trace } from "@opentelemetry/api";
import { pino, type Logger } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  level: string;
  service: string;
  environment: string;
  enabled?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    enabled: options.enabled ?? true,
    base: { service: options.service, env: options.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Every line carries the active trace, so a log search jumps straight into the trace.
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.passwordHash",
        "*.token",
        "*.accessToken",
        "*.refreshToken",
        "*.apiKey",
      ],
      censor: "[redacted]",
    },
  });
}

/** A logger that writes nothing, for tests and scripts that don't care. */
export const silentLogger = (): Logger => pino({ enabled: false });
