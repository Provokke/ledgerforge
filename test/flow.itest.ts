import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { startPg } from "../packages/shared/test/pg.ts";
import type { TestPg } from "../packages/shared/test/pg.ts";

// Whole system, for real: postgres, rabbitmq and redis in docker, and the four
// services as separate node processes talking only over the broker and http.

const ADMIN = "admin-key";
const ALICE = "alice-key";
const BOB = "bob-key";
const CAROL = "carol-key";

const containers: string[] = [];
const procs: ChildProcess[] = [];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function container(image: string, inner: number, args: string[] = []): number {
  const name = `lf-test-${randomBytes(4).toString("hex")}`;
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, ...args, "-p", `127.0.0.1::${inner}`, image], { stdio: "ignore" });
  containers.push(name);
  const out = execFileSync("docker", ["port", name, `${inner}/tcp`]).toString().trim().split("\n")[0]!;
  return Number(out.slice(out.lastIndexOf(":") + 1));
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

describe("full flow @integration", () => {
  let pg: TestPg;
  let gw: string;
  let accountsUrl: string;

  async function call(method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(gw + path, {
      method,
      headers: { ...(key ? { "x-api-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: (await res.json()) as any };
  }

  const deposit = (account: string, currency: string, amount: string, eventId?: string) => call("POST", "/deposits", ADMIN, { account, currency, amount, eventId });
  const order = (key: string, o: Record<string, unknown>, headers?: Record<string, string>) => call("POST", "/orders", key, o, headers);
  const status = async (key: string, id: string) => (await call("GET", `/orders/${id}`, key)).body.status as string;
  const bal = async (acct: string, cur: string) => {
    const r = await call("GET", `/balances/${acct}`, ADMIN);
    const b = r.body.balances?.[cur];
    return b ? { available: BigInt(b.available), held: BigInt(b.held) } : undefined;
  };
  const waitBal = (acct: string, cur: string, available: bigint, held = 0n) =>
    until(`${acct}/${cur} to be ${available}/${held}`, async () => {
      const b = await bal(acct, cur);
      return b && b.available === available && b.held === held ? b : undefined;
    });
  const waitStatus = (key: string, id: string, want: string) => until(`order ${id} to be ${want}`, async () => (await status(key, id)) === want);

  let matchingProc: ReturnType<typeof spawn>;
  let restartMatching: () => Promise<void>;
  let matchingUrl = "";

  before(async () => {
    pg = await startPg();
    await pg.pool.query("CREATE DATABASE accounts");
    await pg.pool.query("CREATE DATABASE ledger");
    await pg.pool.query("CREATE DATABASE matching");
    const dbUrl = (db: string) => pg.url.replace(/\/postgres$/, `/${db}`);
    const redisPort = container("redis:7-alpine", 6379);
    const mqPort = container("rabbitmq:4-alpine", 5672, ["-e", "RABBITMQ_DEFAULT_USER=lf", "-e", "RABBITMQ_DEFAULT_PASS=lf"]);

    const ports = { gateway: await freePort(), accounts: await freePort(), ledger: await freePort(), matching: await freePort() };
    accountsUrl = `http://127.0.0.1:${ports.accounts}`;
    gw = `http://127.0.0.1:${ports.gateway}`;
    const common = {
      ...process.env,
      LOG_LEVEL: "warn",
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      AMQP_URL: `amqp://lf:lf@127.0.0.1:${mqPort}`,
      SYMBOLS: "BTC-USD",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
    };
    const start = (name: keyof typeof ports, env: Record<string, string>) => {
      const p = spawn(process.execPath, [`services/${name}/src/main.ts`], { env: { ...common, PORT: String(ports[name]), ...env }, stdio: ["ignore", "inherit", "inherit"] });
      procs.push(p);
      return p;
    };
    start("accounts", { DATABASE_URL: dbUrl("accounts") });
    start("ledger", { DATABASE_URL: dbUrl("ledger"), ACCOUNTS_URL: accountsUrl });
    matchingProc = start("matching", { DATABASE_URL: dbUrl("matching") });
    restartMatching = async () => {
      const old = matchingProc;
      old.kill("SIGKILL"); // no graceful shutdown: this is the crash case
      await new Promise((r) => (old.exitCode !== null || old.signalCode ? r(0) : old.once("exit", r)));
      matchingProc = start("matching", { DATABASE_URL: dbUrl("matching") });
      await until("matching ready again", async () => (await fetch(`http://127.0.0.1:${ports.matching}/readyz`)).ok, 90_000);
    };
    matchingUrl = `http://127.0.0.1:${ports.matching}`;
    start("gateway", { API_KEYS: `${ALICE}:alice,${BOB}:bob,${CAROL}:carol`, ADMIN_KEY: ADMIN, ACCOUNTS_URL: accountsUrl, LEDGER_URL: `http://127.0.0.1:${ports.ledger}` });
    for (const [name, port] of Object.entries(ports)) {
      await until(`${name} ready`, async () => (await fetch(`http://127.0.0.1:${port}/readyz`)).ok, 90_000);
    }
  });

  after(async () => {
    for (const p of procs) p.kill("SIGTERM");
    await Promise.all(procs.map((p) => new Promise((r) => (p.exitCode !== null || p.signalCode ? r(0) : p.once("exit", r)))));
    for (const c of containers) {
      try {
        execFileSync("docker", ["rm", "-f", c], { stdio: "ignore" });
      } catch {}
    }
    await pg?.stop();
  });

  it("rejects missing and wrong keys, and keeps accounts apart", async () => {
    assert.equal((await call("GET", "/balances/alice", null)).status, 401);
    assert.equal((await call("GET", "/balances/alice", "nope")).status, 401);
    assert.equal((await call("GET", "/balances/bob", ALICE)).status, 403);
    assert.equal((await call("POST", "/deposits", ALICE, { account: "alice", currency: "USD", amount: "5" })).status, 403);
  });

  it("deposits land in accounts, and replaying one changes nothing", async () => {
    assert.equal((await deposit("alice", "USD", "10000000", "dep-alice")).status, 202);
    assert.equal((await deposit("bob", "BTC", "100", "dep-bob")).status, 202);
    assert.equal((await deposit("carol", "USD", "100", "dep-carol")).status, 202);
    await waitBal("alice", "USD", 10_000_000n);
    await waitBal("bob", "BTC", 100n);
    await deposit("alice", "USD", "10000000", "dep-alice"); // same event id again
    await call("GET", "/audit", ADMIN); // round trip so the replay has been consumed by now
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await bal("alice", "USD"))!.available, 10_000_000n);
  });

  it("matches a crossing pair, settles at the resting price and frees the rest on cancel", async () => {
    const a = await order(ALICE, { symbol: "BTC-USD", side: "buy", price: "50000", qty: "10" });
    assert.equal(a.status, 202);
    await waitStatus(ALICE, a.body.orderId, "open");
    await waitBal("alice", "USD", 9_500_000n, 500_000n);

    const b = await order(BOB, { symbol: "BTC-USD", side: "sell", price: "49000", qty: "4" });
    await waitStatus(BOB, b.body.orderId, "filled");
    await waitStatus(ALICE, a.body.orderId, "partial");

    // 4 BTC at the maker's 50000 = 200000, alice still holds 300000 for the other 6
    await waitBal("alice", "USD", 9_500_000n, 300_000n);
    await waitBal("alice", "BTC", 4n);
    await waitBal("bob", "BTC", 96n);
    await waitBal("bob", "USD", 200_000n);

    const cancel = await call("DELETE", `/orders/${a.body.orderId}`, ALICE);
    assert.equal(cancel.status, 202);
    await waitStatus(ALICE, a.body.orderId, "cancelled");
    await waitBal("alice", "USD", 9_800_000n, 0n);
    assert.equal((await call("DELETE", `/orders/${a.body.orderId}`, ALICE)).status, 409);
    assert.equal((await call("GET", `/orders/${a.body.orderId}`, BOB)).status, 404);
  });

  it("rejects an order the account cannot pay for", async () => {
    const r = await order(CAROL, { symbol: "BTC-USD", side: "buy", price: "50000", qty: "1" });
    await waitStatus(CAROL, r.body.orderId, "rejected");
    const o = await call("GET", `/orders/${r.body.orderId}`, CAROL);
    assert.equal(o.body.reason, "insufficient_funds");
    await waitBal("carol", "USD", 100n);
  });

  it("validates input at the gateway", async () => {
    assert.equal((await order(ALICE, { symbol: "DOGE-USD", side: "buy", price: "1", qty: "1" })).status, 400);
    assert.equal((await order(ALICE, { symbol: "BTC-USD", side: "buy", price: "1.5", qty: "1" })).status, 400);
    assert.equal((await order(ALICE, { symbol: "BTC-USD", side: "hold", price: "1", qty: "1" })).status, 400);
    assert.equal((await order(ALICE, { symbol: "BTC-USD", side: "buy", price: "1", qty: "0" })).status, 400);
  });

  it("an Idempotency-Key makes a retried order the same order", async () => {
    const h = { "idempotency-key": "retry-1" };
    const first = await order(ALICE, { symbol: "BTC-USD", side: "buy", price: "1", qty: "1" }, h);
    const second = await order(ALICE, { symbol: "BTC-USD", side: "buy", price: "1", qty: "1" }, h);
    assert.equal(second.body.orderId, first.body.orderId);
    assert.equal(second.body.status, "duplicate");
    await waitStatus(ALICE, first.body.orderId, "open");
    await call("DELETE", `/orders/${first.body.orderId}`, ALICE);
    await waitStatus(ALICE, first.body.orderId, "cancelled");
  });

  it("the ledger agrees with accounts to the last unit", async () => {
    await waitBal("alice", "USD", 9_800_000n, 0n);
    const audit = await until("ledger to catch up", async () => {
      const r = await call("GET", "/audit", ADMIN);
      return r.body.entries === 4 ? r.body : undefined; // three deposits and one trade
    });
    assert.equal(audit.ok, true);
    assert.deepEqual(audit.drift, []);
    assert.deepEqual(audit.unbalancedCurrencies, []);
    assert.equal(audit.brokenAt, null);
  });

  it("exposes metrics and health on every service", async () => {
    const m = await (await fetch(`${accountsUrl}/metrics`)).text();
    assert.match(m, /mq_messages_total/);
    assert.equal((await fetch(`${gw}/healthz`)).status, 200);
  });

  it("a matching crash loses nothing: the book is rebuilt from the journal", async () => {
    const sell = await order(BOB, { symbol: "BTC-USD", side: "sell", price: "70000", qty: "10" });
    await waitStatus(BOB, sell.body.orderId, "open");
    const usdBefore = (await bal("alice", "USD"))!.available;
    const book = async () => ((await (await fetch(`${matchingUrl}/book/BTC-USD`)).json()) as { asks: { price: number; qty: number }[] }).asks;
    assert.deepEqual(await book(), [{ price: 70000, qty: 10, orders: 1 }]);

    await restartMatching();
    assert.deepEqual(await book(), [{ price: 70000, qty: 10, orders: 1 }], "resting order is back after the crash");

    // and it still trades: alice buys the restored order
    const buy = await order(ALICE, { symbol: "BTC-USD", side: "buy", price: "70000", qty: "10" });
    await waitStatus(ALICE, buy.body.orderId, "filled");
    await waitStatus(BOB, sell.body.orderId, "filled");
    await waitBal("alice", "USD", usdBefore - 700_000n);
    assert.deepEqual(await book(), []);
    await until("ledger to agree again", async () => (await call("GET", "/audit", ADMIN)).body.ok === true);
  });
});
