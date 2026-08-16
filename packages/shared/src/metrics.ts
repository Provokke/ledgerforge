import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export { Counter, Gauge, Histogram, Registry };

// Latency buckets in seconds, tuned for an in-memory matcher plus a db round trip.
export const LATENCY_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5];

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<"method" | "route" | "status">;
  httpDuration: Histogram<"method" | "route">;
  messages: Counter<"queue" | "outcome">;
  messageDuration: Histogram<"queue">;
}

/** One registry per service (not the global one) so tests can build several side by side. */
export function createMetrics(service: string, withDefaults = true): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  if (withDefaults) collectDefaultMetrics({ register: registry });
  return {
    registry,
    httpRequests: new Counter({ name: "http_requests_total", help: "HTTP requests", labelNames: ["method", "route", "status"], registers: [registry] }),
    httpDuration: new Histogram({ name: "http_request_duration_seconds", help: "HTTP request latency", labelNames: ["method", "route"], buckets: LATENCY_BUCKETS, registers: [registry] }),
    messages: new Counter({ name: "mq_messages_total", help: "Messages consumed", labelNames: ["queue", "outcome"], registers: [registry] }),
    messageDuration: new Histogram({ name: "mq_message_duration_seconds", help: "Message handler latency", labelNames: ["queue"], buckets: LATENCY_BUCKETS, registers: [registry] }),
  };
}

/** Times an async fn into a histogram and returns its result. */
export async function timed<T>(h: { startTimer(): () => number }, fn: () => Promise<T> | T): Promise<T> {
  const end = h.startTimer();
  try {
    return await fn();
  } finally {
    end();
  }
}
