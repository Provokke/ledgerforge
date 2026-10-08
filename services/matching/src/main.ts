import { fileURLToPath } from "node:url";
import { App, Bus, Counter, Gauge, Histogram, LATENCY_BUCKETS, Lifecycle, baseConfig, createLogger, createMetrics, createPool, initTracing, migrate, str, waitForDb } from "@ledgerforge/shared";
import { MatchingEngine } from "./engine.ts";
import { restore, startMatching } from "./service.ts";
import { MatchLog } from "./store.ts";

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
const pool = createPool(cfg.databaseUrl);
life.add("pool", () => pool.end());
await waitForDb(pool);
await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)), "matching", log);
const store = new MatchLog(pool);
// Rebuild the books before taking any new message, so nothing is matched against a half-empty book.
await restore(engine, store, log);

const bus = await Bus.connect(cfg.amqpUrl, log, { metrics, onFatal: () => void life.shutdown().then(() => process.exit(1)) });
life.add("bus", () => bus.close());
await startMatching(bus, engine, store, log, () => void life.shutdown().then(() => process.exit(1)));

const app = new App(log, metrics);
app.standardRoutes(async () => {
  await pool.query("SELECT 1");
  return bus.ready;
});
app.get("/book/:symbol", (c) => {
  const symbol = c.params.symbol!;
  if (!engine.symbols().includes(symbol)) return { error: "unknown_symbol" };
  return { symbol, bids: engine.depth(symbol, "buy"), asks: engine.depth(symbol, "sell") };
});

const port = await app.listen(cfg.port);
life.add("http", () => app.close());
life.install();
log.info({ port, symbols }, "matching up");
