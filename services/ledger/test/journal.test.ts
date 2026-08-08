import { test } from "node:test";
import assert from "node:assert/strict";
import { Journal, LedgerError, audit, tradeEntry, validateEntry, type Entry, type EntryInput } from "../src/journal.ts";

const e = (id: string, amount = 100n): EntryInput => ({
  id,
  postings: [
    { account: "cash", side: "debit", amount, currency: "USD" },
    { account: "equity", side: "credit", amount, currency: "USD" },
  ],
});

test("rejects unbalanced, empty and malformed entries", () => {
  const code = (x: EntryInput) => { try { validateEntry(x); } catch (err) { return (err as LedgerError).code; } return "ok"; };
  assert.equal(code({ id: "a", postings: [{ account: "x", side: "debit", amount: 5n, currency: "USD" }, { account: "y", side: "credit", amount: 4n, currency: "USD" }] }), "unbalanced");
  assert.equal(code({ id: "a", postings: [{ account: "x", side: "debit", amount: 5n, currency: "USD" }] }), "too_few_postings");
  assert.equal(code({ id: "a", postings: [{ account: "x", side: "debit", amount: 0n, currency: "USD" }, { account: "y", side: "credit", amount: 0n, currency: "USD" }] }), "bad_amount");
  assert.equal(code({ id: "a", postings: [{ account: "x", side: "debit", amount: -5n, currency: "USD" }, { account: "y", side: "credit", amount: -5n, currency: "USD" }] }), "bad_amount");
  assert.equal(code({ id: "", postings: e("z").postings }), "missing_id");
});

test("each currency has to balance on its own", () => {
  const x: EntryInput = { id: "fx", postings: [
    { account: "a", side: "debit", amount: 10n, currency: "USD" },
    { account: "b", side: "credit", amount: 10n, currency: "EUR" },
  ] };
  assert.throws(() => validateEntry(x), /out by/);
});

test("append updates balances and keeps the books zero-sum", () => {
  const j = new Journal();
  j.append(e("1", 100n));
  j.append(e("2", 50n));
  assert.equal(j.balance("cash", "USD"), 150n);
  assert.equal(j.balance("equity", "USD"), -150n);
  assert.equal(j.audit().ok, true);
});

test("idempotent by id: same content is a no-op, different content is refused", () => {
  const j = new Journal();
  const a = j.append(e("1"));
  const b = j.append(e("1"));
  assert.equal(b.duplicate, true);
  assert.equal(b.entry, a.entry);
  assert.equal(j.length, 1);
  assert.equal(j.balance("cash", "USD"), 100n);
  assert.throws(() => j.append(e("1", 999n)), (err) => (err as LedgerError).code === "id_conflict");
});

test("posting order inside an entry does not change the hash", () => {
  const a = new Journal();
  const b = new Journal();
  const x = e("1");
  a.append(x);
  b.append({ ...x, postings: [...x.postings].reverse() });
  assert.equal(a.entries()[0]!.hash, b.entries()[0]!.hash);
});

test("audit catches drift between stored balances and the journal", () => {
  const j = new Journal();
  j.append(e("1"));
  const stored = j.balances();
  stored.set("cash|USD", 101n);
  const r = audit(j.entries(), stored);
  assert.equal(r.ok, false);
  assert.deepEqual(r.drift, [{ key: "cash|USD", stored: 101n, journal: 100n }]);
});

test("audit catches a stored balance for an account the journal never saw", () => {
  const j = new Journal();
  j.append(e("1"));
  const stored = j.balances();
  stored.set("ghost|USD", 5n);
  assert.equal(audit(j.entries(), stored).drift[0]!.key, "ghost|USD");
});

test("audit catches a tampered entry via the hash chain", () => {
  const j = new Journal();
  for (let i = 1; i <= 5; i++) j.append(e(String(i)));
  const copy: Entry[] = structuredClone(j.entries()) as Entry[];
  copy[2]!.postings[0]!.amount = 1n;
  copy[2]!.postings[1]!.amount = 1n; // still balanced, so only the hash can catch it
  assert.equal(audit(copy).brokenAt, 3);
});

test("audit catches a deleted entry", () => {
  const j = new Journal();
  for (let i = 1; i <= 4; i++) j.append(e(String(i)));
  const copy = j.entries().filter((x) => x.seq !== 2);
  assert.equal(audit(copy).brokenAt, 3);
});

test("a trade entry moves both legs and conserves each currency", () => {
  const j = new Journal();
  j.append(tradeEntry({ id: "t1", buyer: "alice", seller: "bob", price: 25000n, qty: 3n, base: "BTC", quote: "USD" }));
  assert.equal(j.balance("alice", "BTC"), 3n);
  assert.equal(j.balance("bob", "BTC"), -3n);
  assert.equal(j.balance("bob", "USD"), 75000n);
  assert.equal(j.balance("alice", "USD"), -75000n);
  assert.equal(j.audit().ok, true);
});

test("bigint maths stays exact beyond 2^53", () => {
  const j = new Journal();
  const big = 2n ** 80n;
  j.append(e("big", big));
  j.append(e("one", 1n));
  assert.equal(j.balance("cash", "USD"), big + 1n);
  assert.equal(j.audit().ok, true);
});

test("fuzz: any run of valid trades leaves every currency at zero net", () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const j = new Journal();
  for (let i = 0; i < 500; i++) {
    const buyer = `u${Math.floor(rand() * 8)}`;
    const seller = `u${Math.floor(rand() * 8)}`;
    if (buyer === seller) continue;
    j.append(tradeEntry({ id: `t${i}`, buyer, seller, price: BigInt(1 + Math.floor(rand() * 1e6)), qty: BigInt(1 + Math.floor(rand() * 1e4)), base: "BTC", quote: "USD" }));
  }
  const r = j.audit();
  assert.equal(r.ok, true);
  assert.deepEqual(r.unbalancedCurrencies, []);
});
