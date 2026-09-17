// End-to-end check against a running compose stack (docker compose up -d --build).
// Safe to run again and again: it works from balance deltas, not absolute numbers.
import assert from "node:assert/strict";

const GW = process.env.GATEWAY_URL ?? "http://127.0.0.1:3000";
const ALICE = process.env.ALICE_KEY ?? "key-alice";
const BOB = process.env.BOB_KEY ?? "key-bob";
const ADMIN = process.env.ADMIN_KEY ?? "admin-secret";
const run = Date.now().toString(36);

async function call(method: string, path: string, key: string, body?: unknown) {
  const res = await fetch(GW + path, {
    method,
    headers: { "x-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

type Bal = { available: bigint; held: bigint };
async function bal(acct: string, cur: string): Promise<Bal> {
  const r = await call("GET", `/balances/${acct}`, ADMIN);
  const b = r.body.balances?.[cur];
  return b ? { available: BigInt(b.available), held: BigInt(b.held) } : { available: 0n, held: 0n };
}
const waitBal = (acct: string, cur: string, want: Bal) =>
  until(`${acct}/${cur} = ${want.available}/${want.held}`, async () => {
    const b = await bal(acct, cur);
    return b.available === want.available && b.held === want.held && b;
  });
const waitStatus = (key: string, id: string, want: string) =>
  until(`order ${id} to be ${want}`, async () => (await call("GET", `/orders/${id}`, key)).body.status === want);

await until("gateway ready", async () => (await fetch(`${GW}/readyz`)).ok, 60_000);
console.log("gateway ready");

// 1. fund both sides. Starting points are read after the deposits land.
assert.equal((await call("POST", "/deposits", ADMIN, { account: "alice", currency: "USD", amount: "1000000", eventId: `e2e-${run}-a` })).status, 202);
assert.equal((await call("POST", "/deposits", ADMIN, { account: "bob", currency: "BTC", amount: "10", eventId: `e2e-${run}-b` })).status, 202);
await until("deposits to land", async () => (await bal("alice", "USD")).available >= 1_000_000n && (await bal("bob", "BTC")).available >= 10n);
await until("any earlier orders to settle", async () => (await bal("alice", "USD")).held === 0n && (await bal("bob", "BTC")).held === 0n);
const a0 = { usd: await bal("alice", "USD"), btc: await bal("alice", "BTC") };
const b0 = { usd: await bal("bob", "USD"), btc: await bal("bob", "BTC") };
console.log("funded");

// 2. alice rests a bid, bob sells into it for less, so the trade prints at alice's price
const buy = await call("POST", "/orders", ALICE, { symbol: "BTC-USD", side: "buy", price: "60000", qty: "5" });
assert.equal(buy.status, 202);
await waitStatus(ALICE, buy.body.orderId, "open");
const sell = await call("POST", "/orders", BOB, { symbol: "BTC-USD", side: "sell", price: "59000", qty: "5" });
assert.equal(sell.status, 202);
await waitStatus(ALICE, buy.body.orderId, "filled");
await waitStatus(BOB, sell.body.orderId, "filled");
console.log("traded");

// 3. 5 BTC at the resting 60000 = 300000 moves, and nothing stays held
await waitBal("alice", "USD", { available: a0.usd.available - 300_000n, held: 0n });
await waitBal("alice", "BTC", { available: a0.btc.available + 5n, held: 0n });
await waitBal("bob", "USD", { available: b0.usd.available + 300_000n, held: 0n });
await waitBal("bob", "BTC", { available: b0.btc.available - 5n, held: 0n });
console.log("balances moved by the right amounts");

// 4. the ledger has to agree with accounts to the last unit
const audit = await until("clean audit", async () => {
  const r = await call("GET", "/audit", ADMIN);
  return r.status === 200 && r.body.ok === true && r.body.entries >= 3 && r.body;
});
assert.deepEqual(audit.drift, []);
assert.deepEqual(audit.unbalancedCurrencies, []);
assert.equal(audit.brokenAt, null);
console.log(`audit clean over ${audit.entries} journal entries`);
console.log("e2e passed");
