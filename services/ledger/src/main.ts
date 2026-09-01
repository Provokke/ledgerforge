import { fileURLToPath } from "node:url";
import { App, Bus, HttpError, Lifecycle, baseConfig, createLogger, createMetrics, createPool, initTracing, migrate, str, waitForDb } from "@ledgerforge/shared";
import { LedgerStore } from "./store.ts";
import { startConsumers } from "./consumers.ts";

const cfg = baseConfig("ledger", 3002);
const accountsUrl = str("ACCOUNTS_URL", "http://127.0.0.1:3001");
const log = createLogger(cfg.service, cfg.logLevel);
initTracing(cfg.service);
const metrics = createMetrics(cfg.service);
const life = new Lifecycle(log);

const pool = createPool(cfg.databaseUrl);
life.add("pool", () => pool.end());
await waitForDb(pool);
await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)), "ledger", log);
const store = new LedgerStore(pool);

const bus = await Bus.connect(cfg.amqpUrl, log, { metrics, onFatal: () => void life.shutdown().then(() => process.exit(1)) });
life.add("bus", () => bus.close());
await startConsumers(bus, store);

const app = new App(log, metrics);
app.standardRoutes(async () => {
  await pool.query("SELECT 1");
  return bus.ready;
});
app.get("/head", async () => store.head());
app.get("/entries", async () => ({ entries: await store.entries() }));
// Cross-service audit: replay the journal, then compare it to what accounts says it holds.
app.get("/audit", async (c) => {
  const res = await fetch(`${accountsUrl}/internal/holdings`, { headers: { "x-request-id": c.requestId }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  if (!res?.ok) throw new HttpError(502, "accounts_unreachable");
  const { holdings } = (await res.json()) as { holdings: Record<string, string> };
  const map = new Map(Object.entries(holdings).map(([k, v]) => [k, BigInt(v)]));
  return store.audit(map);
});

const port = await app.listen(cfg.port);
life.add("http", () => app.close());
life.install();
log.info({ port }, "ledger up");
