import { firstTime, tx } from "@ledgerforge/shared";
import type { Client, Pool } from "@ledgerforge/shared";

export class InsufficientFunds extends Error {
  account: string;
  currency: string;
  need: bigint;
  have: bigint;
  constructor(account: string, currency: string, need: bigint, have: bigint) {
    super(`insufficient funds in ${account}/${currency}: need ${need}, have ${have}`);
    this.account = account;
    this.currency = currency;
    this.need = need;
    this.have = have;
  }
}
export class HoldError extends Error {}

export interface Balance {
  available: bigint;
  held: bigint;
}

/** Tiny cache seam so the repo doesn't care if it's Redis or a Map in a test. */
export interface BalanceCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(keys: string[]): Promise<void>;
}

export interface SettleInput {
  tradeId: string;
  buyer: string;
  seller: string;
  base: string;
  quote: string;
  qty: bigint;
  price: bigint;
  buyHoldId: string;
  sellHoldId: string;
}

type Key = { account: string; currency: string };

const cacheKey = (account: string) => `bal:${account}`;

export class AccountsRepo {
  private pool: Pool;
  private cache: BalanceCache | undefined;
  constructor(pool: Pool, cache?: BalanceCache) {
    this.pool = pool;
    this.cache = cache;
  }

  /** Runs the work, then drops cached balances for the touched accounts. Only after commit, never before. */
  private async write<T>(fn: (c: Client, touched: Set<string>) => Promise<T>): Promise<T> {
    const touched = new Set<string>();
    const out = await tx(this.pool, (c) => fn(c, touched));
    if (this.cache && touched.size) await this.cache.del([...touched].map(cacheKey)).catch(() => {});
    return out;
  }

  async createAccount(id: string, owner: string): Promise<void> {
    await this.pool.query("INSERT INTO accounts (id, owner) VALUES ($1, $2) ON CONFLICT DO NOTHING", [id, owner]);
  }

  async deposit(eventId: string, account: string, currency: string, amount: bigint): Promise<boolean> {
    if (amount <= 0n) throw new RangeError("deposit must be positive");
    return this.write(async (c, touched) => {
      if (!(await firstTime(c, "deposit", eventId))) return false;
      await ensureBalances(c, [{ account, currency }]);
      await lockBalances(c, [{ account, currency }]);
      await c.query("UPDATE balances SET available = available + $3, version = version + 1, updated_at = now() WHERE account_id = $1 AND currency = $2", [account, currency, amount]);
      touched.add(account);
      return true;
    });
  }

  /** Earmarks funds for an order. Same holdId again returns the first result untouched. */
  async placeHold(holdId: string, account: string, currency: string, amount: bigint): Promise<boolean> {
    if (amount <= 0n) throw new RangeError("hold must be positive");
    return this.write(async (c, touched) => {
      const k = { account, currency };
      await ensureBalances(c, [k]);
      const [bal] = await lockBalances(c, [k]);
      const dup = await c.query("SELECT 1 FROM holds WHERE id = $1", [holdId]);
      if (dup.rowCount) return false;
      if (bal!.available < amount) throw new InsufficientFunds(account, currency, amount, bal!.available);
      await c.query("UPDATE balances SET available = available - $3, held = held + $3, version = version + 1, updated_at = now() WHERE account_id = $1 AND currency = $2", [account, currency, amount]);
      await c.query("INSERT INTO holds (id, account_id, currency, amount) VALUES ($1, $2, $3, $4)", [holdId, account, currency, amount]);
      touched.add(account);
      return true;
    });
  }

  /** Gives back whatever is left on a hold. Safe to call twice. Returns the amount released. */
  async releaseHold(holdId: string): Promise<bigint> {
    return this.write(async (c, touched) => {
      // Peek without a lock to learn which balance row to lock; the hold row
      // is then re-read under that lock. Balance first, hold second, always.
      const peek = await c.query("SELECT account_id, currency FROM holds WHERE id = $1", [holdId]);
      if (!peek.rowCount) throw new HoldError(`no such hold ${holdId}`);
      const k = { account: peek.rows[0].account_id as string, currency: peek.rows[0].currency as string };
      await lockBalances(c, [k]);
      const h = (await c.query("SELECT amount, consumed, status FROM holds WHERE id = $1 FOR UPDATE", [holdId])).rows[0];
      if (h.status === "closed") return 0n;
      const left = (h.amount as bigint) - (h.consumed as bigint);
      await c.query("UPDATE holds SET status = 'closed' WHERE id = $1", [holdId]);
      if (left > 0n) {
        await c.query("UPDATE balances SET available = available + $3, held = held - $3, version = version + 1, updated_at = now() WHERE account_id = $1 AND currency = $2", [k.account, k.currency, left]);
        touched.add(k.account);
      }
      return left;
    });
  }

  /**
   * Moves both legs of a trade in one transaction: the buyer's quote hold
   * pays the seller, the seller's base hold pays the buyer. Idempotent on the
   * trade id. Locks are always taken balances-sorted so two trades crossing
   * the same accounts in opposite directions can't deadlock.
   */
  async settleTrade(s: SettleInput): Promise<boolean> {
    if (s.qty <= 0n || s.price <= 0n) throw new RangeError("qty and price must be positive");
    const quoteAmt = s.qty * s.price;
    return this.write(async (c, touched) => {
      if (!(await firstTime(c, "settle", s.tradeId))) return false;
      const keys: Key[] = [
        { account: s.buyer, currency: s.quote },
        { account: s.buyer, currency: s.base },
        { account: s.seller, currency: s.base },
        { account: s.seller, currency: s.quote },
      ];
      await ensureBalances(c, keys);
      await lockBalances(c, keys);

      const holds = (await c.query("SELECT id, account_id, currency, amount, consumed, status FROM holds WHERE id = ANY($1) ORDER BY id FOR UPDATE", [[s.buyHoldId, s.sellHoldId]])).rows;
      const byId = new Map(holds.map((h) => [h.id as string, h]));
      const bh = byId.get(s.buyHoldId);
      const sh = byId.get(s.sellHoldId);
      if (!bh || !sh) throw new HoldError("hold missing for trade " + s.tradeId);
      if (bh.account_id !== s.buyer || bh.currency !== s.quote) throw new HoldError("buy hold does not match buyer/quote");
      if (sh.account_id !== s.seller || sh.currency !== s.base) throw new HoldError("sell hold does not match seller/base");
      if (bh.status !== "open" || sh.status !== "open") throw new HoldError("hold is closed");
      if (bh.amount - bh.consumed < quoteAmt) throw new HoldError("buy hold too small");
      if (sh.amount - sh.consumed < s.qty) throw new HoldError("sell hold too small");

      await c.query("UPDATE holds SET consumed = consumed + $2 WHERE id = $1", [s.buyHoldId, quoteAmt]);
      await c.query("UPDATE holds SET consumed = consumed + $2 WHERE id = $1", [s.sellHoldId, s.qty]);
      const bump = "version = version + 1, updated_at = now()";
      await c.query(`UPDATE balances SET held = held - $3, ${bump} WHERE account_id = $1 AND currency = $2`, [s.buyer, s.quote, quoteAmt]);
      await c.query(`UPDATE balances SET available = available + $3, ${bump} WHERE account_id = $1 AND currency = $2`, [s.buyer, s.base, s.qty]);
      await c.query(`UPDATE balances SET held = held - $3, ${bump} WHERE account_id = $1 AND currency = $2`, [s.seller, s.base, s.qty]);
      await c.query(`UPDATE balances SET available = available + $3, ${bump} WHERE account_id = $1 AND currency = $2`, [s.seller, s.quote, quoteAmt]);
      touched.add(s.buyer).add(s.seller);
      return true;
    });
  }

  async balances(account: string): Promise<Record<string, Balance>> {
    const hit = await this.cache?.get(cacheKey(account)).catch(() => null);
    if (hit) return decode(hit);
    const rows = (await this.pool.query("SELECT currency, available, held FROM balances WHERE account_id = $1 ORDER BY currency", [account])).rows;
    const out: Record<string, Balance> = {};
    for (const r of rows) out[r.currency] = { available: r.available, held: r.held };
    await this.cache?.set(cacheKey(account), encode(out), 30).catch(() => {});
    return out;
  }

  /** Holdings (available + held) per `account|currency`, the same key shape the journal uses. */
  async holdings(): Promise<Map<string, bigint>> {
    const rows = (await this.pool.query("SELECT account_id, currency, available + held AS total FROM balances")).rows;
    return new Map(rows.map((r) => [`${r.account_id}|${r.currency}`, r.total as bigint]));
  }

  /** Sum per currency across every account. The ledger audit compares this to the journal. */
  async totals(): Promise<Record<string, bigint>> {
    const rows = (await this.pool.query("SELECT currency, sum(available + held)::bigint AS total FROM balances GROUP BY currency ORDER BY currency")).rows;
    return Object.fromEntries(rows.map((r) => [r.currency, r.total as bigint]));
  }
}

async function ensureBalances(c: Client, keys: Key[]): Promise<void> {
  for (const k of uniqueSorted(keys)) {
    const a = await c.query("SELECT 1 FROM accounts WHERE id = $1", [k.account]);
    if (!a.rowCount) throw new HoldError(`unknown account ${k.account}`);
    await c.query("INSERT INTO balances (account_id, currency) VALUES ($1, $2) ON CONFLICT DO NOTHING", [k.account, k.currency]);
  }
}

/** Locks rows in (account, currency) order and returns them in that same order. */
async function lockBalances(c: Client, keys: Key[]): Promise<Balance[]> {
  const out: Balance[] = [];
  for (const k of uniqueSorted(keys)) {
    const r = await c.query("SELECT available, held FROM balances WHERE account_id = $1 AND currency = $2 FOR UPDATE", [k.account, k.currency]);
    out.push({ available: r.rows[0].available, held: r.rows[0].held });
  }
  return out;
}

function uniqueSorted(keys: Key[]): Key[] {
  const m = new Map(keys.map((k) => [`${k.account}\u0000${k.currency}`, k]));
  return [...m.keys()].sort().map((id) => m.get(id)!);
}

const encode = (b: Record<string, Balance>) => JSON.stringify(Object.fromEntries(Object.entries(b).map(([k, v]) => [k, [v.available.toString(), v.held.toString()]])));
const decode = (s: string): Record<string, Balance> =>
  Object.fromEntries(Object.entries(JSON.parse(s) as Record<string, [string, string]>).map(([k, [a, h]]) => [k, { available: BigInt(a), held: BigInt(h) }]));
