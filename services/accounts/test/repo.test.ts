import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { migrate } from "@ledgerforge/shared";
import { AccountsRepo, InsufficientFunds } from "../src/repo.ts";
import type { BalanceCache } from "../src/repo.ts";
import { startPg } from "./pg.ts";
import type { TestPg } from "./pg.ts";

const dir = fileURLToPath(new URL("../migrations", import.meta.url));

class MapCache implements BalanceCache {
  m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; }
  async set(k: string, v: string) { this.m.set(k, v); }
  async del(ks: string[]) { for (const k of ks) this.m.delete(k); }
}

describe("accounts repo @integration", () => {
  let pg: TestPg;
  let repo: AccountsRepo;
  const cache = new MapCache();
  let n = 0;
  const uid = (p: string) => `${p}-${++n}`;

  before(async () => {
    pg = await startPg();
    await migrate(pg.pool, dir, "accounts");
    repo = new AccountsRepo(pg.pool, cache);
  });
  after(async () => { await pg.stop(); });

  async function fund(id: string, currency: string, amt: bigint) {
    await repo.createAccount(id, id);
    await repo.deposit(uid("dep"), id, currency, amt);
  }

  it("deposit is idempotent by event id", async () => {
    await repo.createAccount("a1", "a1");
    assert.equal(await repo.deposit("e1", "a1", "USD", 500n), true);
    assert.equal(await repo.deposit("e1", "a1", "USD", 500n), false);
    assert.deepEqual((await repo.balances("a1")).USD, { available: 500n, held: 0n });
  });

  it("hold moves available to held and refuses overdraw", async () => {
    await fund("h1", "USD", 100n);
    assert.equal(await repo.placeHold("hold-h1", "h1", "USD", 60n), true);
    assert.equal(await repo.placeHold("hold-h1", "h1", "USD", 60n), false, "same hold id is a replay");
    assert.deepEqual((await repo.balances("h1")).USD, { available: 40n, held: 60n });
    await assert.rejects(repo.placeHold("hold-h1b", "h1", "USD", 41n), InsufficientFunds);
    assert.equal(await repo.releaseHold("hold-h1"), 60n);
    assert.equal(await repo.releaseHold("hold-h1"), 0n, "second release is a no-op");
    assert.deepEqual((await repo.balances("h1")).USD, { available: 100n, held: 0n });
  });

  it("settleTrade swaps both legs, keeps the surplus on the hold, replay is a no-op", async () => {
    await fund("buy", "USD", 1000n);
    await fund("sell", "BTC", 10n);
    await repo.placeHold("bh", "buy", "USD", 500n); // buyer would pay up to 500
    await repo.placeHold("sh", "sell", "BTC", 5n);
    const t = { tradeId: "t1", buyer: "buy", seller: "sell", base: "BTC", quote: "USD", qty: 4n, price: 100n, buyHoldId: "bh", sellHoldId: "sh" };
    assert.equal(await repo.settleTrade(t), true);
    assert.equal(await repo.settleTrade(t), false);
    const b = await repo.balances("buy");
    const s = await repo.balances("sell");
    assert.deepEqual(b.USD, { available: 500n, held: 100n });
    assert.deepEqual(b.BTC, { available: 4n, held: 0n });
    assert.deepEqual(s.BTC, { available: 5n, held: 1n });
    assert.deepEqual(s.USD, { available: 400n, held: 0n });
    assert.equal(await repo.releaseHold("bh"), 100n);
  });

  it("settleTrade rejects a hold that is too small and changes nothing", async () => {
    await fund("b2", "USD", 100n);
    await fund("s2", "BTC", 5n);
    await repo.placeHold("bh2", "b2", "USD", 50n);
    await repo.placeHold("sh2", "s2", "BTC", 5n);
    await assert.rejects(repo.settleTrade({ tradeId: "t2", buyer: "b2", seller: "s2", base: "BTC", quote: "USD", qty: 1n, price: 100n, buyHoldId: "bh2", sellHoldId: "sh2" }));
    assert.deepEqual((await repo.balances("b2")).USD, { available: 50n, held: 50n });
    // and the failed trade id wasn't burned, so a corrected retry works
    assert.equal(await repo.settleTrade({ tradeId: "t2", buyer: "b2", seller: "s2", base: "BTC", quote: "USD", qty: 1n, price: 50n, buyHoldId: "bh2", sellHoldId: "sh2" }), true);
  });

  it("cache is dropped after a write, not before", async () => {
    await fund("c1", "USD", 10n);
    await repo.balances("c1");
    assert.ok(cache.m.has("bal:c1"));
    await repo.deposit(uid("dep"), "c1", "USD", 5n);
    assert.ok(!cache.m.has("bal:c1"));
    assert.equal((await repo.balances("c1")).USD!.available, 15n);
  });

  it("the CHECK constraint is the backstop even for raw SQL", async () => {
    await fund("k1", "USD", 10n);
    await assert.rejects(pg.pool.query("UPDATE balances SET available = available - 11 WHERE account_id = 'k1'"), /balances_available_nonneg/);
  });

  it("concurrent crossing trades never overdraw and never deadlock", async () => {
    // Two accounts trade BTC for USD against each other in both directions at once.
    await fund("x", "USD", 100_000n);
    await fund("x", "BTC", 1_000n);
    await fund("y", "USD", 100_000n);
    await fund("y", "BTC", 1_000n);
    const total = async () => (await repo.totals());
    const before = await total();
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 60; i++) {
      const [buyer, seller] = i % 2 ? ["x", "y"] : ["y", "x"];
      jobs.push((async () => {
        const bh = `cb${i}`, sh = `cs${i}`;
        await repo.placeHold(bh, buyer!, "USD", 100n);
        await repo.placeHold(sh, seller!, "BTC", 2n);
        await repo.settleTrade({ tradeId: `ct${i}`, buyer: buyer!, seller: seller!, base: "BTC", quote: "USD", qty: 2n, price: 50n, buyHoldId: bh, sellHoldId: sh });
        await repo.releaseHold(bh);
        await repo.releaseHold(sh);
      })());
    }
    const res = await Promise.allSettled(jobs);
    assert.deepEqual(res.filter((r) => r.status === "rejected"), []);
    assert.deepEqual(await total(), before, "money was neither created nor destroyed");
    for (const a of ["x", "y"]) {
      const b = await repo.balances(a);
      assert.equal(b.USD!.held, 0n);
      assert.equal(b.BTC!.held, 0n);
    }
  });

  it("concurrent holds on one account can't overspend", async () => {
    await fund("race", "USD", 1000n);
    const res = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => repo.placeHold(`rh${i}`, "race", "USD", 100n)));
    const ok = res.filter((r) => r.status === "fulfilled").length;
    assert.equal(ok, 10);
    assert.ok(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof InsufficientFunds));
    assert.deepEqual((await repo.balances("race")).USD, { available: 0n, held: 1000n });
  });
});
