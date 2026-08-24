import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool, migrate } from "@ledgerforge/shared";
import { AccountsRepo } from "../../accounts/src/repo.ts";
import { startPg } from "../../../packages/shared/test/pg.ts";
import type { Pool } from "@ledgerforge/shared";
import type { TestPg } from "../../../packages/shared/test/pg.ts";
import { LedgerStore } from "../src/store.ts";

const ledgerDir = fileURLToPath(new URL("../migrations", import.meta.url));
const accountsDir = fileURLToPath(new URL("../../accounts/migrations", import.meta.url));

describe("postgres ledger", () => {
  let pg: TestPg;
  let store: LedgerStore;

  before(async () => {
    pg = await startPg();
    await migrate(pg.pool, ledgerDir, "ledger");
    store = new LedgerStore(pg.pool);
  });
  after(async () => { await pg.stop(); });

  const trade = (id: string, qty = "2", price = "50") => ({ tradeId: id, symbol: "BTC-USD", base: "BTC", quote: "USD", buyer: "alice", seller: "bob", buyOrderId: "o1", sellOrderId: "o2", price, qty });

  it("records a trade once and chains the hashes", async () => {
    assert.equal(await store.recordTrade(trade("t1")), true);
    assert.equal(await store.recordTrade(trade("t1")), false);
    await store.recordTrade(trade("t2", "1", "70"));
    const es = await store.entries();
    assert.equal(es.length, 2);
    assert.equal(es[1]!.prevHash, es[0]!.hash);
    assert.equal((await store.audit()).ok, true);
  });

  it("rejects bad amounts before touching the db", async () => {
    await assert.rejects(store.recordTrade(trade("bad1", "1.5")), RangeError);
    await assert.rejects(store.recordTrade(trade("bad2", "0")), RangeError);
    await assert.rejects(store.recordTrade(trade("bad3", "-3")), RangeError);
  });

  it("the db refuses UPDATE, DELETE and TRUNCATE", async () => {
    await assert.rejects(pg.pool.query("UPDATE journal_entries SET memo = 'x'"), /append-only/);
    await assert.rejects(pg.pool.query("DELETE FROM journal_postings"), /append-only/);
    await assert.rejects(pg.pool.query("TRUNCATE journal_entries CASCADE"), /append-only/);
  });

  it("the db refuses an unbalanced entry at commit", async () => {
    const c = await pg.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("INSERT INTO journal_entries (seq, id, prev_hash, hash) VALUES (900, 'rogue', 'a', 'b')");
      await c.query("INSERT INTO journal_postings VALUES (900, 0, 'x', 'debit', 10, 'USD'), (900, 1, 'y', 'credit', 9, 'USD')");
      await assert.rejects(c.query("COMMIT"), /does not balance/);
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  });

  it("concurrent writers keep one unbroken chain", async () => {
    const before = (await store.entries()).length;
    const res = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => store.recordTrade(trade(`cc${i}`, "1", String(10 + i)))));
    assert.deepEqual(res.filter((r) => r.status === "rejected"), []);
    const rep = await store.audit();
    assert.equal(rep.entries, before + 40);
    assert.equal(rep.brokenAt, null);
    assert.equal(rep.ok, true);
  });

  it("audit catches tampering done behind the triggers' back", async () => {
    const c = await pg.pool.connect();
    try {
      await c.query("SET session_replication_role = replica");
      await c.query("UPDATE journal_postings SET amount = amount + 1 WHERE entry_seq = 1 AND idx = 0");
      await c.query("SET session_replication_role = origin");
    } finally {
      c.release();
    }
    const rep = await store.audit();
    assert.equal(rep.ok, false);
    assert.equal(rep.brokenAt, 1);
  });
});

describe("cross-service audit", () => {
  let pg: TestPg;
  let store: LedgerStore;
  let repo: AccountsRepo;
  let acctPool: Pool;

  before(async () => {
    pg = await startPg();
    await migrate(pg.pool, ledgerDir, "ledger");
    // separate database, like prod: each service owns its own schema
    await pg.pool.query("CREATE DATABASE accts");
    acctPool = createPool(pg.url.replace(/\/postgres$/, "/accts"));
    await migrate(acctPool, accountsDir, "accounts");
    store = new LedgerStore(pg.pool);
    repo = new AccountsRepo(acctPool);
  });
  after(async () => { await acctPool.end(); await pg.stop(); });

  it("accounts and journal agree after deposits and a trade, and drift is caught", async () => {
    for (const a of ["alice", "bob"]) await repo.createAccount(a, a);
    const dep = async (id: string, account: string, currency: string, amount: bigint) => {
      await repo.deposit(id, account, currency, amount);
      await store.recordDeposit({ eventId: id, account, currency, amount: amount.toString() });
    };
    await dep("d1", "alice", "USD", 1000n);
    await dep("d2", "bob", "BTC", 10n);
    await repo.placeHold("bh", "alice", "USD", 200n);
    await repo.placeHold("sh", "bob", "BTC", 2n);
    await repo.settleTrade({ tradeId: "t1", buyer: "alice", seller: "bob", base: "BTC", quote: "USD", qty: 2n, price: 100n, buyHoldId: "bh", sellHoldId: "sh" });
    await store.recordTrade({ tradeId: "t1", symbol: "BTC-USD", base: "BTC", quote: "USD", buyer: "alice", seller: "bob", buyOrderId: "o1", sellOrderId: "o2", price: "100", qty: "2" });

    const ok = await store.audit(await repo.holdings());
    assert.deepEqual({ ok: ok.ok, drift: ok.drift }, { ok: true, drift: [] });

    // someone edits a balance directly in the accounts db
    await acctPool.query("UPDATE balances SET available = available + 5 WHERE account_id = 'alice' AND currency = 'USD'");
    const bad = await store.audit(await repo.holdings());
    assert.equal(bad.ok, false);
    assert.ok(bad.drift.some((d) => d.key === "alice|USD" && d.stored - d.journal === 5n));
  });
});
