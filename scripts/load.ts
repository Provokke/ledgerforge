// End-to-end load test against a running compose stack. Alice buys and bob sells at
// the same price, so every pair of orders trades. It measures what a client sees:
// how fast the gateway accepts orders, and how long until everything has settled in
// accounts and the ledger agrees. Start the stack with a high rate limit first:
//   RATE_LIMIT=1000000 docker compose up -d --build --wait
//   node scripts/load.ts [orders] [concurrency]
import assert from "node:assert/strict";

const GW = process.env.GATEWAY_URL ?? "http://127.0.0.1:3000";
const ALICE = process.env.ALICE_KEY ?? "key-alice";
const BOB = process.env.BOB_KEY ?? "key-bob";
const ADMIN = process.env.ADMIN_KEY ?? "admin-secret";
const N = Number(process.argv[2] ?? 2000) & ~1; // even, so every order has a partner
const CONC = Number(process.argv[3] ?? 32);
const PRICE = 50_000n;
const run = Date.now().toString(36);

async function call(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(GW + path, {
    method,
    headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function bal(acct: string, cur: string) {
  const b = (await call("GET", `/balances/${acct}`, ADMIN)).body.balances?.[cur];
  return b ? { available: BigInt(b.available), held: BigInt(b.held) } : { available: 0n, held: 0n };
}

async function until(what: string, fn: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (!(await fn().catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]!.toFixed(1);

await until("gateway", async () => (await fetch(`${GW}/readyz`)).ok, 60_000);
const half = BigInt(N / 2);
await call("POST", "/deposits", ADMIN, { account: "alice", currency: "USD", amount: String(half * PRICE), eventId: `load-${run}-a` });
await call("POST", "/deposits", ADMIN, { account: "bob", currency: "BTC", amount: String(half), eventId: `load-${run}-b` });
await until("funds", async () => (await bal("alice", "USD")).available >= half * PRICE && (await bal("bob", "BTC")).available >= half, 30_000);
await until("quiet", async () => (await bal("alice", "USD")).held === 0n && (await bal("bob", "BTC")).held === 0n, 60_000);
const a0 = { usd: await bal("alice", "USD"), btc: await bal("alice", "BTC") };
const b0 = { usd: await bal("bob", "USD"), btc: await bal("bob", "BTC") };

console.log(`${N} orders, ${CONC} in flight`);
const accept: number[] = [];
let next = 0;
let rejected = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = next++;
      if (i >= N) return;
      const buy = i % 2 === 0;
      const started = performance.now();
      const r = await call("POST", "/orders", buy ? ALICE : BOB, { symbol: "BTC-USD", side: buy ? "buy" : "sell", price: String(PRICE), qty: "1" });
      accept.push(performance.now() - started);
      if (r.status !== 202) rejected++;
    }
  }),
);
const tAccepted = performance.now() - t0;
assert.equal(rejected, 0, `${rejected} orders were not accepted (rate limit? start with RATE_LIMIT=1000000)`);

// Every order fills at one price, so settled means alice holds N/2 more BTC and nothing is held.
await until(
  "everything to settle",
  async () => {
    const [ab, au, bu, bb] = await Promise.all([bal("alice", "BTC"), bal("alice", "USD"), bal("bob", "USD"), bal("bob", "BTC")]);
    return ab.available === a0.btc.available + half && au.held === 0n && bb.held === 0n && bu.available === b0.usd.available + half * PRICE;
  },
  300_000,
);
const tSettled = performance.now() - t0;
await until("ledger", async () => (await call("GET", "/audit", ADMIN)).body.ok === true, 120_000);
const tAudited = performance.now() - t0;
const audit = (await call("GET", "/audit", ADMIN)).body;
assert.deepEqual(audit.drift, []);
assert.deepEqual(audit.unbalancedCurrencies, []);

accept.sort((x, y) => x - y);
const rate = (ms: number) => Math.round((N / ms) * 1000).toLocaleString();
console.log(`accepted by the gateway : ${rate(tAccepted)} orders/s   (accept latency p50 ${pct(accept, 0.5)} ms, p99 ${pct(accept, 0.99)} ms)`);
console.log(`settled in accounts     : ${rate(tSettled)} orders/s   (${(tSettled / 1000).toFixed(1)} s for ${N} orders, ${N / 2} trades)`);
console.log(`ledger caught up        : ${(tAudited / 1000).toFixed(1)} s, ${audit.entries} entries, zero drift`);
