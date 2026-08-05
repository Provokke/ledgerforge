import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderBook } from "../src/book.ts";
import type { OrderInput, Trade } from "../src/types.ts";

const buy = (id: string, price: number | undefined, qty: number, acc = "b", extra: Partial<OrderInput> = {}): OrderInput =>
  ({ id, accountId: acc, side: "buy", price, qty, ...extra });
const sell = (id: string, price: number | undefined, qty: number, acc = "s", extra: Partial<OrderInput> = {}): OrderInput =>
  ({ id, accountId: acc, side: "sell", price, qty, ...extra });

test("limit order rests when nothing crosses", () => {
  const b = new OrderBook();
  const r = b.submit(buy("1", 100, 5));
  assert.equal(r.status, "resting");
  assert.equal(b.bestBid(), 100);
  assert.equal(b.bestAsk(), undefined);
});

test("trades at the resting order's price, not the taker's", () => {
  const b = new OrderBook();
  b.submit(sell("m", 100, 10));
  const r = b.submit(buy("t", 105, 4));
  assert.equal(r.status, "filled");
  assert.equal(r.trades[0]!.price, 100);
  assert.equal(r.trades[0]!.makerOrderId, "m");
  assert.equal(b.depth("sell")[0]!.qty, 6);
});

test("price-time priority: best price first, then FIFO", () => {
  const b = new OrderBook();
  b.submit(sell("a", 101, 5, "s1"));
  b.submit(sell("b", 100, 5, "s2"));
  b.submit(sell("c", 100, 5, "s3"));
  const r = b.submit(buy("t", undefined, 12, "x"));
  assert.deepEqual(r.trades.map((t) => [t.makerOrderId, t.qty]), [["b", 5], ["c", 5], ["a", 2]]);
  b.checkInvariants();
});

test("partial fill rests the remainder", () => {
  const b = new OrderBook();
  b.submit(sell("m", 100, 3));
  const r = b.submit(buy("t", 100, 10));
  assert.equal(r.status, "partial");
  assert.equal(r.filled, 3);
  assert.equal(b.depth("buy")[0]!.qty, 7);
  b.checkInvariants();
});

test("market order never rests and reports no_liquidity", () => {
  const b = new OrderBook();
  b.submit(sell("m", 100, 3));
  const r = b.submit(buy("t", undefined, 10));
  assert.equal(r.filled, 3);
  assert.equal(r.remaining, 7);
  assert.equal(r.reason, "no_liquidity");
  assert.equal(b.size, 0);
});

test("market order with GTC is rejected", () => {
  assert.equal(new OrderBook().submit(buy("t", undefined, 1, "b", { tif: "GTC" })).status, "rejected");
});

test("FOK is all or nothing", () => {
  const b = new OrderBook();
  b.submit(sell("m", 100, 5));
  const no = b.submit(buy("t1", 100, 6, "b", { tif: "FOK" }));
  assert.equal(no.status, "cancelled");
  assert.equal(b.depth("sell")[0]!.qty, 5, "book untouched");
  const yes = b.submit(buy("t2", 100, 5, "b", { tif: "FOK" }));
  assert.equal(yes.status, "filled");
});

test("IOC drops the remainder", () => {
  const b = new OrderBook();
  b.submit(sell("m", 100, 2));
  const r = b.submit(buy("t", 100, 5, "b", { tif: "IOC" }));
  assert.equal(r.status, "partial");
  assert.equal(b.size, 0);
});

test("cancel removes an order and its empty level", () => {
  const b = new OrderBook();
  b.submit(buy("1", 100, 5));
  b.submit(buy("2", 99, 5));
  assert.equal(b.cancel("1"), true);
  assert.equal(b.cancel("1"), false);
  assert.equal(b.bestBid(), 99);
  b.checkInvariants();
});

test("cancelling a middle order keeps FIFO for the rest", () => {
  const b = new OrderBook();
  for (const id of ["a", "b", "c"]) b.submit(sell(id, 100, 1, id));
  b.cancel("b");
  const r = b.submit(buy("t", 100, 2));
  assert.deepEqual(r.trades.map((t) => t.makerOrderId), ["a", "c"]);
});

test("self-trade prevention stops the taker and leaves the maker", () => {
  const b = new OrderBook();
  b.submit(sell("m", 100, 5, "same"));
  const r = b.submit(buy("t", 100, 5, "same"));
  assert.equal(r.trades.length, 0);
  assert.equal(r.reason, "self_trade");
  assert.equal(b.has("m"), true);
  b.checkInvariants();
});

test("rejects bad input", () => {
  const b = new OrderBook();
  for (const o of [
    buy("1", 100, 0), buy("2", 100, 1.5), buy("3", -1, 1), buy("4", 0.5, 1),
    buy("5", Number.MAX_SAFE_INTEGER, 2), buy("", 1, 1),
  ]) assert.equal(b.submit(o).status, "rejected", JSON.stringify(o));
  b.submit(buy("dup", 100, 1));
  assert.equal(b.submit(buy("dup", 100, 1)).status, "rejected");
});

// tiny seeded PRNG so any failure is reproducible
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function fuzz(seed: number, steps: number) {
  const rand = rng(seed);
  const b = new OrderBook();
  const live: string[] = [];
  const restingQty = new Map<string, number>();
  const all: Trade[] = [];
  let n = 0;
  for (let i = 0; i < steps; i++) {
    if (live.length && rand() < 0.25) {
      const id = live.splice(Math.floor(rand() * live.length), 1)[0]!;
      assert.equal(b.cancel(id), true);
      restingQty.delete(id);
    } else {
      const side = rand() < 0.5 ? "buy" : "sell";
      const id = `o${n++}`;
      const qty = 1 + Math.floor(rand() * 20);
      const market = rand() < 0.1;
      const o: OrderInput = {
        id, accountId: `a${Math.floor(rand() * 6)}`, side, qty,
        price: market ? undefined : 95 + Math.floor(rand() * 11),
        tif: market ? "IOC" : (["GTC", "GTC", "GTC", "IOC", "FOK"] as const)[Math.floor(rand() * 5)]!,
      };
      const r = b.submit(o);
      assert.equal(r.filled + r.remaining, qty, "quantity conserved per order");
      assert.equal(r.trades.reduce((s, t) => s + t.qty, 0), r.filled);
      for (const t of r.trades) {
        all.push(t);
        assert.notEqual(t.makerAccountId, t.takerAccountId, "no self trades");
        const left = (restingQty.get(t.makerOrderId) ?? 0) - t.qty;
        assert.ok(left >= 0, "never overfills a maker");
        if (left === 0) {
          restingQty.delete(t.makerOrderId);
          live.splice(live.indexOf(t.makerOrderId), 1);
        } else restingQty.set(t.makerOrderId, left);
        if (o.price !== undefined) {
          if (t.takerSide === "buy") assert.ok(t.price <= o.price, "buyer never pays above limit");
          else assert.ok(t.price >= o.price, "seller never gets below limit");
        }
      }
      if (b.has(id)) {
        live.push(id);
        restingQty.set(id, r.remaining);
      }
    }
    b.checkInvariants();
  }
  const resting = [...restingQty.values()].reduce((s, q) => s + q, 0);
  const book = [...b.depth("buy"), ...b.depth("sell")].reduce((s, l) => s + l.qty, 0);
  assert.equal(resting, book, "tracked resting qty matches the book");
  const seqs = all.map((t) => t.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), "trade seq is monotonic");
}

test("fuzz: never crossed, qty conserved, no self trades (50 seeds x 400 ops)", () => {
  for (let seed = 1; seed <= 50; seed++) fuzz(seed, 400);
});

test("deterministic: same input gives the same trades", () => {
  const run = () => {
    const b = new OrderBook();
    const rand = rng(7);
    const out: Trade[] = [];
    for (let i = 0; i < 300; i++) {
      const r = b.submit({
        id: `o${i}`, accountId: `a${Math.floor(rand() * 5)}`, side: rand() < 0.5 ? "buy" : "sell",
        price: 90 + Math.floor(rand() * 20), qty: 1 + Math.floor(rand() * 9),
      });
      out.push(...r.trades);
    }
    return out;
  };
  assert.deepEqual(run(), run());
});
