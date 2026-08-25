import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrderMsg } from "@ledgerforge/shared";
import { MatchingEngine } from "../src/engine.ts";

const o = (orderId: string, accountId: string, side: "buy" | "sell", price: string, qty: string, tif: OrderMsg["tif"] = "GTC"): OrderMsg => ({ orderId, accountId, symbol: "BTC-USD", side, price, qty, tif });

describe("matching engine", () => {
  it("rests an order, then trades against it and updates both sides", () => {
    const e = new MatchingEngine(["BTC-USD"]);
    const a = e.place(o("s1", "bob", "sell", "100", "5"));
    assert.equal(a.updates[0]!.status, "open");
    assert.equal(a.updates[0]!.final, false);

    const b = e.place(o("b1", "alice", "buy", "105", "2"));
    assert.equal(b.trades.length, 1);
    assert.deepEqual({ ...b.trades[0]! }, {
      tradeId: "BTC-USD:1", symbol: "BTC-USD", base: "BTC", quote: "USD", buyer: "alice", seller: "bob", buyOrderId: "b1", sellOrderId: "s1", price: "100", qty: "2",
    });
    const maker = b.updates.find((u) => u.orderId === "s1")!;
    assert.deepEqual([maker.status, maker.filled, maker.remaining, maker.final], ["partial", "2", "3", false]);
    const taker = b.updates.find((u) => u.orderId === "b1")!;
    assert.deepEqual([taker.status, taker.final], ["filled", true]);
  });

  it("buyer is the buy order's account whichever side was the taker", () => {
    const e = new MatchingEngine(["BTC-USD"]);
    e.place(o("b1", "alice", "buy", "100", "1"));
    const r = e.place(o("s1", "bob", "sell", "100", "1"));
    assert.equal(r.trades[0]!.buyer, "alice");
    assert.equal(r.trades[0]!.buyOrderId, "b1");
    assert.equal(r.trades[0]!.sellOrderId, "s1");
  });

  it("IOC remainder is final and cancelled, FOK with no liquidity is final", () => {
    const e = new MatchingEngine(["BTC-USD"]);
    e.place(o("s1", "bob", "sell", "100", "1"));
    const r = e.place(o("b1", "alice", "buy", "100", "3", "IOC"));
    const u = r.updates.find((x) => x.orderId === "b1")!;
    assert.deepEqual([u.status, u.filled, u.remaining, u.final], ["cancelled", "1", "2", true]);
    const f = e.place(o("b2", "alice", "buy", "100", "1", "FOK"));
    assert.equal(f.updates[0]!.final, true);
    assert.equal(f.trades.length, 0);
  });

  it("cancel releases a resting order once, then does nothing", () => {
    const e = new MatchingEngine(["BTC-USD"]);
    e.place(o("s1", "bob", "sell", "100", "4"));
    e.place(o("b1", "alice", "buy", "100", "1"));
    const c = e.cancel({ orderId: "s1", symbol: "BTC-USD" });
    assert.deepEqual([c.updates[0]!.status, c.updates[0]!.filled, c.updates[0]!.remaining, c.updates[0]!.final], ["cancelled", "1", "3", true]);
    assert.equal(e.cancel({ orderId: "s1", symbol: "BTC-USD" }).updates.length, 0);
    assert.equal(e.cancel({ orderId: "b1", symbol: "BTC-USD" }).updates.length, 0, "filled order is not cancellable");
  });

  it("a redelivered order is ignored, bad input is rejected", () => {
    const e = new MatchingEngine(["BTC-USD"]);
    e.place(o("s1", "bob", "sell", "100", "1"));
    const again = e.place(o("s1", "bob", "sell", "100", "1"));
    assert.deepEqual(again, { trades: [], updates: [] });
    assert.equal(e.place(o("x", "a", "buy", "1.5", "1")).updates[0]!.reason, "bad_number");
    assert.equal(e.place({ ...o("y", "a", "buy", "1", "1"), symbol: "ETH-USD" }).updates[0]!.reason, "unknown_symbol");
  });

  it("every fill is conserved: sum of trade qty equals what left the book", () => {
    const e = new MatchingEngine(["BTC-USD"]);
    let sold = 0n;
    let bought = 0n;
    for (let i = 0; i < 50; i++) e.place(o(`s${i}`, `m${i % 5}`, "sell", String(100 + (i % 7)), String(1 + (i % 4))));
    for (let i = 0; i < 50; i++) {
      const r = e.place(o(`b${i}`, `t${i % 3}`, "buy", String(100 + (i % 9)), String(1 + (i % 3)), "IOC"));
      for (const t of r.trades) { bought += BigInt(t.qty); sold += BigInt(t.qty); }
    }
    assert.equal(bought, sold);
    assert.ok(sold > 0n);
  });
});
