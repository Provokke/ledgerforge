import { EXTERNAL, firstTime, parseAmount, tx } from "@ledgerforge/shared";
import type { Client, DepositMade, Pool, TradeExecuted } from "@ledgerforge/shared";
import { GENESIS, LedgerError, audit, balanceKey, canonical, hashEntry, tradeEntry, validateEntry } from "./journal.ts";
import type { AuditReport, Balances, Entry, EntryInput, Posting } from "./journal.ts";

/** Postgres-backed journal. Same rules as the in-memory Journal, enforced again by triggers. */
export class LedgerStore {
  private pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Appends inside the caller's transaction. The single journal_head row is the
   * chain lock: every writer queues on it, so seq and prev_hash can never fork.
   */
  async appendIn(c: Client, input: EntryInput): Promise<{ entry: Entry; duplicate: boolean }> {
    validateEntry(input);
    const head = (await c.query("SELECT seq, last_hash FROM journal_head FOR UPDATE")).rows[0];
    const dup = await readEntry(c, "id", input.id);
    if (dup) {
      if (canonical(dup) !== canonical(input)) throw new LedgerError("id_conflict", `${input.id} already used with different postings`);
      return { entry: dup, duplicate: true };
    }
    const seq = Number(head.seq) + 1;
    const prevHash: string = head.last_hash;
    const hash = hashEntry(prevHash, input);
    await c.query("INSERT INTO journal_entries (seq, id, memo, prev_hash, hash) VALUES ($1, $2, $3, $4, $5)", [seq, input.id, input.memo ?? "", prevHash, hash]);
    for (const [i, p] of input.postings.entries()) {
      await c.query("INSERT INTO journal_postings (entry_seq, idx, account, side, amount, currency) VALUES ($1, $2, $3, $4, $5, $6)", [seq, i, p.account, p.side, p.amount, p.currency]);
    }
    await c.query("UPDATE journal_head SET seq = $1, last_hash = $2", [seq, hash]);
    const entry: Entry = { ...input, postings: input.postings.map((p) => ({ ...p })), seq, prevHash, hash };
    return { entry, duplicate: false };
  }

  append(input: EntryInput): Promise<{ entry: Entry; duplicate: boolean }> {
    return tx(this.pool, (c) => this.appendIn(c, input));
  }

  /** trade.executed handler. Event-id idempotent and atomic with the journal write. */
  async recordTrade(t: TradeExecuted): Promise<boolean> {
    const entry = tradeEntry({ id: `trade:${t.tradeId}`, buyer: t.buyer, seller: t.seller, base: t.base, quote: t.quote, price: parseAmount(t.price, "price"), qty: parseAmount(t.qty, "qty") });
    return tx(this.pool, async (c) => {
      if (!(await firstTime(c, "ledger.trade", t.tradeId))) return false;
      await this.appendIn(c, entry);
      return true;
    });
  }

  /** Money in from outside: debit the account, credit the external account. */
  async recordDeposit(d: DepositMade): Promise<boolean> {
    const amount = parseAmount(d.amount);
    const postings: Posting[] = [
      { account: d.account, side: "debit", amount, currency: d.currency },
      { account: EXTERNAL, side: "credit", amount, currency: d.currency },
    ];
    return tx(this.pool, async (c) => {
      if (!(await firstTime(c, "ledger.deposit", d.eventId))) return false;
      await this.appendIn(c, { id: `deposit:${d.eventId}`, memo: `deposit ${d.eventId}`, postings });
      return true;
    });
  }

  async entries(): Promise<Entry[]> {
    const es = (await this.pool.query("SELECT seq, id, memo, prev_hash, hash FROM journal_entries ORDER BY seq")).rows;
    const ps = (await this.pool.query("SELECT entry_seq, account, side, amount, currency FROM journal_postings ORDER BY entry_seq, idx")).rows;
    const by = new Map<bigint, Posting[]>();
    for (const p of ps) {
      const list = by.get(p.entry_seq) ?? [];
      list.push({ account: p.account, side: p.side, amount: p.amount, currency: p.currency });
      by.set(p.entry_seq, list);
    }
    return es.map((e) => ({ seq: Number(e.seq), id: e.id, memo: e.memo, prevHash: e.prev_hash, hash: e.hash, postings: by.get(e.seq) ?? [] }));
  }

  /**
   * Re-derives everything from the journal. If `holdings` (account|currency to
   * total) is given, it also checks each account against the journal and that
   * the money held adds up to what came in from outside.
   */
  async audit(holdings?: Map<string, bigint>): Promise<AuditReport> {
    const entries = await this.entries();
    if (!holdings) return audit(entries);
    const stored: Balances = new Map(holdings);
    const heldByCurrency = new Map<string, bigint>();
    for (const [k, v] of holdings) {
      const cur = k.slice(k.lastIndexOf("|") + 1);
      heldByCurrency.set(cur, (heldByCurrency.get(cur) ?? 0n) + v);
    }
    // The external account mirrors everything the system holds, so it's the negative of the sum.
    for (const [cur, total] of heldByCurrency) stored.set(balanceKey(EXTERNAL, cur), -total);
    return audit(entries, stored);
  }

  async head(): Promise<{ seq: number; hash: string }> {
    const r = (await this.pool.query("SELECT seq, last_hash FROM journal_head")).rows[0];
    return { seq: Number(r.seq), hash: r.last_hash ?? GENESIS };
  }
}

async function readEntry(c: Client, col: "id", value: string): Promise<Entry | undefined> {
  const e = (await c.query(`SELECT seq, id, memo, prev_hash, hash FROM journal_entries WHERE ${col} = $1`, [value])).rows[0];
  if (!e) return undefined;
  const ps = (await c.query("SELECT account, side, amount, currency FROM journal_postings WHERE entry_seq = $1 ORDER BY idx", [e.seq])).rows;
  return { seq: Number(e.seq), id: e.id, memo: e.memo, prevHash: e.prev_hash, hash: e.hash, postings: ps.map((p) => ({ account: p.account, side: p.side, amount: p.amount, currency: p.currency })) };
}
