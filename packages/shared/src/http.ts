import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "pino";
import type { Metrics } from "./metrics.ts";
import { extract, withSpan } from "./tracing.ts";

// A deliberately small router. No framework: matching is a Map lookup, the
// body is read once with a size cap, and every request gets an id, a span,
// a log line and metrics.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  requestId: string;
  log: Logger;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
export type Middleware = (ctx: Ctx) => Promise<void> | void;

interface Route {
  method: string;
  parts: string[];
  pattern: string;
  handler: Handler;
  open: boolean;
}

const MAX_BODY = 64 * 1024;

export class App {
  private readonly routes: Route[] = [];
  private readonly before: Middleware[] = [];
  private server: Server | undefined;
  private readonly log: Logger;
  private readonly metrics: Metrics;

  constructor(log: Logger, metrics: Metrics) {
    this.log = log;
    this.metrics = metrics;
  }

  /** Middleware runs before every route that isn't marked open. */
  use(m: Middleware): void {
    this.before.push(m);
  }

  route(method: string, pattern: string, handler: Handler, opts: { open?: boolean } = {}): void {
    this.routes.push({ method, pattern, parts: pattern.split("/").filter(Boolean), handler, open: opts.open ?? false });
  }

  get(p: string, h: Handler, o?: { open?: boolean }): void { this.route("GET", p, h, o); }
  post(p: string, h: Handler, o?: { open?: boolean }): void { this.route("POST", p, h, o); }
  delete(p: string, h: Handler, o?: { open?: boolean }): void { this.route("DELETE", p, h, o); }

  /** /healthz is liveness, /readyz runs the checks, /metrics is Prometheus text. */
  standardRoutes(ready: () => Promise<boolean> | boolean): void {
    this.get("/healthz", () => ({ status: "ok" }), { open: true });
    this.get("/readyz", async (c) => {
      if (!(await ready())) throw new HttpError(503, "not_ready");
      c.res.statusCode = 200;
      return { status: "ready" };
    }, { open: true });
    this.get("/metrics", async (c) => {
      c.res.setHeader("content-type", this.metrics.registry.contentType);
      return { raw: await this.metrics.registry.metrics() };
    }, { open: true });
  }

  private match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | undefined {
    const segs = path.split("/").filter(Boolean);
    let pathHit = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i]!;
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]!);
        else if (p !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathHit = true;
      if (r.method === method) return { route: r, params };
    }
    return pathHit ? "method" : undefined;
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    if (req.method === "GET" || req.method === "DELETE") return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) throw new HttpError(413, "body_too_large");
      chunks.push(c as Buffer);
    }
    if (!size) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "invalid_json");
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = process.hrtime.bigint();
    const requestId = String(req.headers["x-request-id"] ?? randomUUID());
    const url = new URL(req.url ?? "/", "http://x");
    const m = this.match(req.method ?? "GET", url.pathname);
    const routeLabel = m && m !== "method" ? m.route.pattern : "unmatched";
    const log = this.log.child({ requestId });
    res.setHeader("x-request-id", requestId);

    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      if (payload && typeof payload === "object" && "raw" in payload && Object.keys(payload).length === 1) {
        res.end((payload as { raw: string }).raw);
        return;
      }
      if (!res.hasHeader("content-type")) res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    };

    try {
      await withSpan(`${req.method} ${routeLabel}`, async (span) => {
        span.setAttribute("http.request_id", requestId);
        if (m === undefined) throw new HttpError(404, "not_found");
        if (m === "method") throw new HttpError(405, "method_not_allowed");
        const ctx: Ctx = { req, res, params: m.params, query: url.searchParams, body: undefined, requestId, log };
        if (!m.route.open) for (const mw of this.before) await mw(ctx);
        ctx.body = await this.readBody(req);
        const out = await m.route.handler(ctx);
        if (!res.writableEnded) send(res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, out ?? {});
      }, extract(req.headers as Record<string, unknown>));
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status === 429) res.setHeader("retry-after", "1");
        send(err.status, { error: err.code, message: err.message, requestId });
      } else {
        log.error({ err: (err as Error).message, stack: (err as Error).stack }, "unhandled error");
        send(500, { error: "internal", requestId });
      }
    } finally {
      const secs = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.httpRequests.inc({ method: req.method ?? "?", route: routeLabel, status: String(res.statusCode) });
      this.metrics.httpDuration.observe({ method: req.method ?? "?", route: routeLabel }, secs);
      if (routeLabel !== "/metrics" && routeLabel !== "/healthz") {
        log.info({ method: req.method, path: url.pathname, status: res.statusCode, ms: Math.round(secs * 1000 * 10) / 10 }, "request");
      }
    }
  }

  listen(port: number, host = "0.0.0.0"): Promise<number> {
    this.server = createServer((req, res) => void this.dispatch(req, res));
    // keep-alive longer than typical load balancer idle timeouts to avoid 502s on reused sockets
    this.server.keepAliveTimeout = 65_000;
    return new Promise((resolve) => this.server!.listen(port, host, () => resolve((this.server!.address() as { port: number }).port)));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeIdleConnections();
    });
  }
}
