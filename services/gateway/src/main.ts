import { Bus, Lifecycle, baseConfig, createLogger, createMetrics, createRedis, initTracing, int, str } from "@ledgerforge/shared";
import { buildApp, parseKeys, startStatusConsumer } from "./app.ts";

const base = baseConfig("gateway", 3000);
const log = createLogger(base.service, base.logLevel);
initTracing(base.service);
const metrics = createMetrics(base.service);
const life = new Lifecycle(log);

const cfg = {
  keys: parseKeys(str("API_KEYS", "")),
  adminKey: str("ADMIN_KEY", ""),
  symbols: str("SYMBOLS", "BTC-USD,ETH-USD").split(",").map((s) => s.trim()).filter(Boolean),
  accountsUrl: str("ACCOUNTS_URL", "http://127.0.0.1:3001"),
  ledgerUrl: str("LEDGER_URL", "http://127.0.0.1:3002"),
  rateLimit: int("RATE_LIMIT", 120),
  rateWindowMs: int("RATE_WINDOW_MS", 60_000),
};
if (!cfg.keys.size && !cfg.adminKey) throw new Error("set API_KEYS and/or ADMIN_KEY, the gateway will not start open");

const redis = createRedis(base.redisUrl);
life.add("redis", () => redis.quit());
const bus = await Bus.connect(base.amqpUrl, log, { metrics, onFatal: () => void life.shutdown().then(() => process.exit(1)) });
life.add("bus", () => bus.close());
await startStatusConsumer(bus, redis);

const app = buildApp({ cfg, redis, bus, log, metrics });
const port = await app.listen(base.port);
life.add("http", () => app.close());
life.install();
log.info({ port, keys: cfg.keys.size }, "gateway up");
