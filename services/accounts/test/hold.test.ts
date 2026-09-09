import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrderMsg } from "@ledgerforge/shared";
import { holdFor } from "../src/consumers.ts";

const base: OrderMsg = { orderId: "o1", accountId: "a", symbol: "BTC-USD", side: "buy", price: "50000", qty: "3", tif: "GTC" };

test("a buy holds quote currency: qty * price", () => {
  assert.deepEqual(holdFor(base), { currency: "USD", amount: 150000n });
});

test("a sell holds base currency: qty", () => {
  assert.deepEqual(holdFor({ ...base, side: "sell" }), { currency: "BTC", amount: 3n });
});

test("big notional stays exact as a bigint", () => {
  const r = holdFor({ ...base, price: "9007199254740991", qty: "9007199254740991" });
  assert.equal(r.amount, 9007199254740991n * 9007199254740991n);
});

test("a bad symbol throws", () => {
  assert.throws(() => holdFor({ ...base, symbol: "btcusd" }), RangeError);
});
