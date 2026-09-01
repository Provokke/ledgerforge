import { fileURLToPath } from "node:url";
import { App, Bus, HttpError, Lifecycle, baseConfig, createLogger, createMetrics, createPool, createRedis, initTracing, migrate, waitForDb } from "@ledgerforge/shared";
import type { Redis } from "@ledgerforge/shared";
import { AccountsRepo } from "./repo.ts";
import type { BalanceCache } from "./repo.ts";
import { startConsumers } from "./consumers.ts";

function redisCache(r: Redis): BalanceCache {
  return {
    get: (k) => r.get(k),
    set: async (k, v, ttl) => void (await r.set(k, v, "EX", ttl)),
    del: async (ks) => void (await r.del(...ks)),
  };
}

const cfg = baseConfig("accounts", 3001);
const log = createLogger(cfg.service, cfg.logLevel);
initTracing(cfg.service);
const metrics = createMetrics(cfg.service);
const life = new Lifecycle(log);

const pool = createPool(cfg.databaseUrl);
life.add("pool", () => pool.end());
await waitForDb(pool);
await migrate(pool, fileURLToPath(new URL("../migrations", import.meta.url)), "accounts", log);

const redis = createRedis(cfg.redisUrl);
life.add("redis", () => redis.quit());
const repo = new AccountsRepo(pool, redisCache(redis));

const bus = await Bus.connect(cfg.amqpUrl, log, { metrics, onFatal: () => void life.shutdown().then(() => process.exit(1)) });
life.add("bus", () => bus.close());
await startConsumers(bus, repo, log);

const app = new App(log, metrics);
app.standardRoutes(async () => {
  await pool.query("SELECT 1");
  return bus.ready && redis.status === "ready";
});
app.get("/balances/:account", async (c) => {
  const b = await repo.balances(c.params.account!);
  if (!Object.keys(b).length) throw new HttpError(404, "no_such_account");
  return { account: c.params.account, balances: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { available: v.available, held: v.held }])) };
});
// Only the ledger audit calls this and it stays inside the cluster network.
app.get("/internal/holdings", async () => ({ holdings: Object.fromEntries(await repo.holdings()) }));

const port = await app.listen(cfg.port);
life.add("http", () => app.close());
life.install();
log.info({ port }, "accounts up");
