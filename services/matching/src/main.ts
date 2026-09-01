import { App, Bus, Counter, Gauge, Histogram, LATENCY_BUCKETS, Lifecycle, baseConfig, createLogger, createMetrics, initTracing, str } from "@ledgerforge/shared";
import { MatchingEngine } from "./engine.ts";
import { startMatching } from "./service.ts";

const cfg = baseConfig("matching", 3003);
const symbols = str("SYMBOLS", "BTC-USD,ETH-USD").split(",").map((s) => s.trim()).filter(Boolean);
const log = createLogger(cfg.service, cfg.logLevel);
initTracing(cfg.service);
const metrics = createMetrics(cfg.service);
const registers = [metrics.registry];

const orders = new Counter({ name: "matching_orders_total", help: "Orders handled by the engine", labelNames: ["symbol", "status"], registers });
const latency = new Histogram({ name: "matching_match_duration_seconds", help: "Time to match one order", labelNames: ["symbol"], buckets: LATENCY_BUCKETS, registers });
const depth = new Gauge({ name: "matching_book_levels", help: "Price levels on each side of the book", labelNames: ["symbol", "side"], registers });

const engine = new MatchingEngine(symbols, {
  onOrder: (symbol, status) => orders.inc({ symbol, status }),
  onLatency: (symbol, s) => latency.observe({ symbol }, s),
  onDepth: (symbol, side, n) => depth.set({ symbol, side }, n),
});

const life = new Lifecycle(log);
const bus = await Bus.connect(cfg.amqpUrl, log, { metrics, onFatal: () => void life.shutdown().then(() => process.exit(1)) });
life.add("bus", () => bus.close());
await startMatching(bus, engine, log);

const app = new App(log, metrics);
app.standardRoutes(() => bus.ready);
app.get("/book/:symbol", (c) => {
  const symbol = c.params.symbol!;
  if (!engine.symbols().includes(symbol)) return { error: "unknown_symbol" };
  return { symbol, bids: engine.depth(symbol, "buy"), asks: engine.depth(symbol, "sell") };
});

const port = await app.listen(cfg.port);
life.add("http", () => app.close());
life.install();
log.info({ port, symbols }, "matching up");
