import { pino, type Logger } from "pino";
import { currentTraceId } from "./tracing.ts";

export type { Logger };

// JSON logs on stdout. Every line carries the service name and, when there is
// an active span, the trace id so logs and traces can be joined up.
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => {
      const traceId = currentTraceId();
      return traceId ? { trace_id: traceId } : {};
    },
    redact: { paths: ["apiKey", "headers.authorization", "headers['x-api-key']", "password"], censor: "[redacted]" },
  });
}
