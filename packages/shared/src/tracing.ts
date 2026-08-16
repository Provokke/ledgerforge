import { context, propagation, trace, SpanStatusCode, type Context, type Span } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";

let provider: NodeTracerProvider | undefined;

/**
 * Starts the tracer if OTEL_EXPORTER_OTLP_ENDPOINT is set. Without it the
 * api calls below are cheap no-ops, so tests and local runs don't need a collector.
 */
export function initTracing(service: string): void {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint || provider) return;
  provider = new NodeTracerProvider({
    resource: new Resource({ "service.name": service }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }))],
  });
  provider.register();
}

export async function shutdownTracing(): Promise<void> {
  await provider?.shutdown();
  provider = undefined;
}

const tracer = () => trace.getTracer("ledgerforge");

/** Runs fn inside a span, records errors and always ends the span. */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, parent?: Context): Promise<T> {
  return tracer().startActiveSpan(name, {}, parent ?? context.active(), async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Copies the current trace context into a carrier (HTTP headers or AMQP headers). */
export function inject(carrier: Record<string, unknown>): Record<string, unknown> {
  propagation.inject(context.active(), carrier);
  return carrier;
}

export function extract(carrier: Record<string, unknown>): Context {
  return propagation.extract(context.active(), carrier);
}

export function currentTraceId(): string | undefined {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc && sc.traceId !== "00000000000000000000000000000000" ? sc.traceId : undefined;
}
