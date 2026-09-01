import { randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { App, HttpError, KEYS, parseAmount, rateLimit, splitSymbol } from "@ledgerforge/shared";
import type { Bus, Ctx, DepositMade, Logger, Metrics, OrderMsg, OrderUpdated, Redis } from "@ledgerforge/shared";

export interface GatewayConfig {
  /** api key to account id */
  keys: Map<string, string>;
  adminKey: string;
  symbols: string[];
  accountsUrl: string;
  ledgerUrl: string;
  rateLimit: number;
  rateWindowMs: number;
}

export interface Deps {
  cfg: GatewayConfig;
  redis: Redis;
  bus: Bus;
  log: Logger;
  metrics: Metrics;
}

const ORDER_TTL_SEC = 24 * 3600;
const orderKey = (id: string) => `order:${id}`;

/** Who made the request. Set by the auth middleware, read by handlers. */
interface Caller {
  account: string | null;
  admin: boolean;
}
const callers = new WeakMap<IncomingMessage, Caller>();

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** "key:account,key2:account2" to a Map. Blank entries are skipped, malformed ones throw. */
export function parseKeys(s: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i < 1 || i === part.length - 1) throw new Error(`bad API_KEYS entry "${part}", want key:account`);
    m.set(part.slice(0, i), part.slice(i + 1));
  }
  return m;
}

export function buildApp(d: Deps): App {
  const { cfg, redis, bus, log, metrics } = d;
  const app = new App(log, metrics);

  app.use(async (c) => {
    const key = String(c.req.headers["x-api-key"] ?? "");
    if (!key) throw new HttpError(401, "missing_api_key");
    let caller: Caller | undefined;
    if (cfg.adminKey && same(key, cfg.adminKey)) caller = { account: null, admin: true };
    else {
      // look the key up without short-circuiting on the first byte that differs
      for (const [k, account] of cfg.keys) if (same(key, k)) caller = { account, admin: false };
    }
    if (!caller) throw new HttpError(401, "bad_api_key");
    callers.set(c.req, caller);

    const rl = await rateLimit(redis, caller.account ?? "admin", cfg.rateLimit, cfg.rateWindowMs).catch(() => undefined);
    if (rl) {
      c.res.setHeader("x-ratelimit-remaining", String(rl.remaining));
      if (!rl.allowed) throw new HttpError(429, "rate_limited");
    }
  });

  const who = (c: Ctx): Caller => callers.get(c.req)!;
  const needAdmin = (c: Ctx) => {
    if (!who(c).admin) throw new HttpError(403, "admin_only");
  };
  /** The owner or an admin may look; anyone else gets a 404 so ids can't be probed. */
  async function loadOrder(c: Ctx): Promise<Record<string, string>> {
    const o = await redis.hgetall(orderKey(c.params.id!));
    const me = who(c);
    if (!o.orderId || (!me.admin && o.accountId !== me.account)) throw new HttpError(404, "no_such_order");
    return o;
  }

  app.standardRoutes(async () => bus.ready && redis.status === "ready");

  app.post("/orders", async (c) => {
    const me = who(c);
    if (!me.account) throw new HttpError(403, "orders_need_an_account_key");
    const b = (c.body ?? {}) as Record<string, unknown>;
    const symbol = String(b.symbol ?? "");
    if (!cfg.symbols.includes(symbol)) throw new HttpError(400, "unknown_symbol");
    splitSymbol(symbol);
    if (b.side !== "buy" && b.side !== "sell") throw new HttpError(400, "bad_side");
    const tif = b.tif === undefined ? "GTC" : b.tif;
    if (tif !== "GTC" && tif !== "IOC" && tif !== "FOK") throw new HttpError(400, "bad_tif");
    try {
      parseAmount(b.price, "price");
      parseAmount(b.qty, "qty");
    } catch (e) {
      throw new HttpError(400, "bad_number", (e as Error).message);
    }

    // Same Idempotency-Key from the same caller gives back the first order, not a second one.
    const idem = c.req.headers["idempotency-key"];
    const orderId = randomUUID();
    if (typeof idem === "string" && idem) {
      const slot = `idem:${me.account}:${idem}`;
      const won = await redis.set(slot, orderId, "EX", ORDER_TTL_SEC, "NX");
      if (won !== "OK") {
        const first = await redis.get(slot);
        c.res.statusCode = 200;
        return { orderId: first, status: "duplicate" };
      }
    }

    const msg: OrderMsg = { orderId, accountId: me.account, symbol, side: b.side, price: b.price as string, qty: b.qty as string, tif };
    // Record it as pending before publishing, so the status consumer always finds the hash.
    await redis.multi().hset(orderKey(orderId), { orderId, accountId: me.account, symbol, side: msg.side, price: msg.price, qty: msg.qty, tif, status: "pending", filled: "0", remaining: msg.qty, createdAt: new Date().toISOString() }).expire(orderKey(orderId), ORDER_TTL_SEC).exec();
    await bus.publish(KEYS.orderPlaced, msg, { id: `ord:${orderId}`, headers: { "x-request-id": c.requestId } });
    c.res.statusCode = 202;
    return { orderId, status: "pending" };
  });

  app.get("/orders/:id", async (c) => loadOrder(c));

  app.delete("/orders/:id", async (c) => {
    const o = await loadOrder(c);
    if (["filled", "cancelled", "rejected"].includes(o.status!)) throw new HttpError(409, `order_${o.status}`);
    // Straight to matching. If it races ahead of the hold being accepted it is a no-op, the caller can just retry.
    await bus.publish(`${KEYS.orderCancel}.${o.symbol}`, { orderId: o.orderId, symbol: o.symbol }, { id: `cxl:${o.orderId}:${randomUUID()}` });
    c.res.statusCode = 202;
    return { orderId: o.orderId, status: "cancel_requested" };
  });

  app.get("/balances/:account", async (c) => {
    const me = who(c);
    if (!me.admin && me.account !== c.params.account) throw new HttpError(403, "not_your_account");
    const res = await fetch(`${cfg.accountsUrl}/balances/${encodeURIComponent(c.params.account!)}`, { headers: { "x-request-id": c.requestId }, signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (!res) throw new HttpError(502, "accounts_unreachable");
    c.res.statusCode = res.status;
    return res.json();
  });

  app.post("/deposits", async (c) => {
    needAdmin(c);
    const b = (c.body ?? {}) as Record<string, unknown>;
    const account = String(b.account ?? "");
    const currency = String(b.currency ?? "");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(account)) throw new HttpError(400, "bad_account");
    if (!/^[A-Z0-9]{2,10}$/.test(currency)) throw new HttpError(400, "bad_currency");
    let amount: bigint;
    try {
      amount = parseAmount(b.amount);
    } catch (e) {
      throw new HttpError(400, "bad_number", (e as Error).message);
    }
    // A caller-supplied eventId makes retries safe: both consumers dedupe on it.
    const eventId = typeof b.eventId === "string" && b.eventId ? b.eventId : randomUUID();
    const ev: DepositMade = { eventId, account, currency, amount: amount.toString() };
    await bus.publish(KEYS.depositMade, ev, { id: `dep:${eventId}`, headers: { "x-request-id": c.requestId } });
    c.res.statusCode = 202;
    return { eventId, status: "accepted" };
  });

  app.get("/audit", async (c) => {
    needAdmin(c);
    const res = await fetch(`${cfg.ledgerUrl}/audit`, { headers: { "x-request-id": c.requestId }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!res) throw new HttpError(502, "ledger_unreachable");
    c.res.statusCode = res.status;
    return res.json();
  });

  return app;
}

/** Keeps the Redis order view in step with what matching and accounts report. */
export async function startStatusConsumer(bus: Bus, redis: Redis): Promise<void> {
  await bus.subscribe<OrderUpdated>("gateway.orders", [KEYS.orderUpdated], async (m) => {
    const u = m.body;
    const key = orderKey(u.orderId);
    if (!(await redis.exists(key))) return; // not one of ours, or already expired
    await redis.hset(key, { status: u.status, filled: u.filled, remaining: u.remaining, reason: u.reason ?? "" });
  }, { prefetch: 20 });
}
