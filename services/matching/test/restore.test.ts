import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger } from "@ledgerforge/shared";
import type { OrderMsg } from "@ledgerforge/shared";
import { MatchingEngine } from "../src/engine.ts";
import { restore } from "../src/service.ts";
import type { LogRow } from "../src/store.ts";
import type { MatchLog } from "../src/store.ts";

const log = createLogger("test", "silent");
const o = (id: string, account: string, side: "buy" | "sell", price: string, qty: string): OrderMsg => ({ orderId: id, accountId: account, symbol: "BTC-USD", side, price, qty, tif: "GTC" });

// Plays some traffic through a live engine and records it the way the service would.
function journal(): LogRow[] {
  const e = new MatchingEngine(["BTC-USD"]);
  const rows: LogRow[] = [];
  const add = (kind: "order" | "cancel", body: any, output: any) => rows.push({ seq: rows.length + 1, msgId: `m${rows.length + 1}`, symbol: "BTC-USD", kind, body, output, published: true });
  for (const m of [o("s1", "bob", "sell", "100", "5"), o("s2", "bob", "sell", "101", "5"), o("b1", "alice", "buy", "100", "2")]) add("order", m, e.place(m));
  const c = { orderId: "s2", symbol: "BTC-USD" };
  add("cancel", c, e.cancel(c));
  return rows;
}

const storeOf = (rows: LogRow[]) => ({ replay: async function* () { yield* rows; } }) as unknown as MatchLog;

test("replaying the journal rebuilds the same book", async () => {
  const fresh = new MatchingEngine(["BTC-USD"]);
  assert.equal(await restore(fresh, storeOf(journal()), log), 4);
  assert.deepEqual(fresh.depth("BTC-USD", "sell"), [{ price: 100, qty: 3, orders: 1 }]);
  assert.deepEqual(fresh.depth("BTC-USD", "buy"), []);
});

test("a restored engine carries on exactly as the original would", async () => {
  const fresh = new MatchingEngine(["BTC-USD"]);
  await restore(fresh, storeOf(journal()), log);
  const r = fresh.place(o("b2", "carol", "buy", "100", "3"));
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0]!.tradeId, "BTC-USD:2", "trade numbering carries on from the replayed trade");
  assert.equal(r.trades[0]!.sellOrderId, "s1");
  // an order seen before the crash is still recognised as a redelivery
  assert.deepEqual(fresh.place(o("s1", "bob", "sell", "100", "5")), { trades: [], updates: [] });
});

test("replay does not touch the metrics hooks", async () => {
  let calls = 0;
  const fresh = new MatchingEngine(["BTC-USD"], { onOrder: () => calls++, onLatency: () => calls++, onDepth: () => calls++ });
  await restore(fresh, storeOf(journal()), log);
  assert.equal(calls, 0);
});

test("a journal that no longer replays to the stored result stops the boot", async () => {
  const rows = journal();
  (rows[2]!.output.trades[0] as any).qty = "9"; // someone edited what was published
  await assert.rejects(restore(new MatchingEngine(["BTC-USD"]), storeOf(rows), log), /replay diverged at log seq 3/);
});

test("rows for a symbol that is switched off are skipped", async () => {
  const fresh = new MatchingEngine(["ETH-USD"]);
  assert.equal(await restore(fresh, storeOf(journal()), log), 0);
});
