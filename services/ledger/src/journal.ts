import { createHash } from "node:crypto";

// Amounts are bigint minor units. A posting is either a debit or a credit of a
// positive amount; an entry is only valid if debits equal credits per currency.
export type PostingSide = "debit" | "credit";

export interface Posting {
  account: string;
  side: PostingSide;
  amount: bigint;
  currency: string;
}

export interface EntryInput {
  /** idempotency key, e.g. "trade:42" */
  id: string;
  memo?: string;
  postings: Posting[];
}

export interface Entry extends EntryInput {
  seq: number;
  prevHash: string;
  hash: string;
}

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

/** Throws a LedgerError if the entry breaks double-entry rules. */
export function validateEntry(e: EntryInput): void {
  if (!e.id) throw new LedgerError("missing_id", "entry needs an id");
  if (e.postings.length < 2) throw new LedgerError("too_few_postings", "need at least two postings");
  const net = new Map<string, bigint>();
  for (const p of e.postings) {
    if (typeof p.amount !== "bigint" || p.amount <= 0n) throw new LedgerError("bad_amount", `amount must be a positive bigint (${p.account})`);
    if (p.side !== "debit" && p.side !== "credit") throw new LedgerError("bad_side", `bad side on ${p.account}`);
    if (!p.account || !p.currency) throw new LedgerError("bad_posting", "account and currency are required");
    net.set(p.currency, (net.get(p.currency) ?? 0n) + (p.side === "debit" ? p.amount : -p.amount));
  }
  for (const [cur, n] of net) if (n !== 0n) throw new LedgerError("unbalanced", `${cur} is out by ${n}`);
}

/** Stable text form for hashing. Postings are sorted so order doesn't matter. */
export function canonical(e: EntryInput): string {
  const ps = e.postings
    .map((p) => `${p.account}|${p.side}|${p.amount}|${p.currency}`)
    .sort();
  return `${e.id}\n${e.memo ?? ""}\n${ps.join("\n")}`;
}

export const GENESIS = "0".repeat(64);

export function hashEntry(prevHash: string, e: EntryInput): string {
  return createHash("sha256").update(prevHash).update("\n").update(canonical(e)).digest("hex");
}

/** key is `${account}|${currency}`, value is debits minus credits */
export type Balances = Map<string, bigint>;

export const balanceKey = (account: string, currency: string): string => `${account}|${currency}`;

export function computeBalances(entries: Iterable<EntryInput>): Balances {
  const out: Balances = new Map();
  for (const e of entries) {
    for (const p of e.postings) {
      const k = balanceKey(p.account, p.currency);
      out.set(k, (out.get(k) ?? 0n) + (p.side === "debit" ? p.amount : -p.amount));
    }
  }
  return out;
}

export interface AuditReport {
  ok: boolean;
  entries: number;
  /** every currency must net to zero across all accounts */
  unbalancedCurrencies: { currency: string; net: bigint }[];
  /** accounts whose stored balance differs from the journal */
  drift: { key: string; stored: bigint; journal: bigint }[];
  /** first entry where the hash chain or sequence breaks, if any */
  brokenAt: number | null;
}

/**
 * Re-derives everything from the journal and compares it to the stored
 * balances. `stored` is optional: leave it out to only check the journal.
 */
export function audit(entries: readonly Entry[], stored?: Balances): AuditReport {
  let brokenAt: number | null = null;
  let prev = GENESIS;
  entries.forEach((e, i) => {
    if (brokenAt !== null) return;
    if (e.seq !== i + 1 || e.prevHash !== prev || e.hash !== hashEntry(prev, e)) brokenAt = e.seq;
    else {
      try {
        validateEntry(e);
      } catch {
        brokenAt = e.seq;
      }
    }
    prev = e.hash;
  });

  const journal = computeBalances(entries);
  const perCurrency = new Map<string, bigint>();
  for (const [k, v] of journal) {
    const cur = k.slice(k.lastIndexOf("|") + 1);
    perCurrency.set(cur, (perCurrency.get(cur) ?? 0n) + v);
  }
  const unbalancedCurrencies = [...perCurrency].filter(([, n]) => n !== 0n).map(([currency, net]) => ({ currency, net }));

  const drift: AuditReport["drift"] = [];
  if (stored) {
    for (const k of new Set([...journal.keys(), ...stored.keys()])) {
      const j = journal.get(k) ?? 0n;
      const s = stored.get(k) ?? 0n;
      if (j !== s) drift.push({ key: k, stored: s, journal: j });
    }
  }
  return { ok: brokenAt === null && unbalancedCurrencies.length === 0 && drift.length === 0, entries: entries.length, unbalancedCurrencies, drift, brokenAt };
}

/** In-memory append-only journal. The Postgres store follows the same rules. */
export class Journal {
  private readonly log: Entry[] = [];
  private readonly byId = new Map<string, Entry>();
  private readonly bal: Balances = new Map();

  get length(): number {
    return this.log.length;
  }

  entries(): readonly Entry[] {
    return this.log;
  }

  balances(): Balances {
    return new Map(this.bal);
  }

  balance(account: string, currency: string): bigint {
    return this.bal.get(balanceKey(account, currency)) ?? 0n;
  }

  /**
   * Appends an entry. Replaying the same id with the same content is a no-op
   * that returns the original; the same id with different content is an error.
   */
  append(input: EntryInput): { entry: Entry; duplicate: boolean } {
    validateEntry(input);
    const existing = this.byId.get(input.id);
    if (existing) {
      if (canonical(existing) !== canonical(input)) throw new LedgerError("id_conflict", `${input.id} already used with different postings`);
      return { entry: existing, duplicate: true };
    }
    const prevHash = this.log.length ? this.log[this.log.length - 1]!.hash : GENESIS;
    const entry: Entry = {
      id: input.id,
      ...(input.memo !== undefined ? { memo: input.memo } : {}),
      postings: input.postings.map((p) => ({ ...p })),
      seq: this.log.length + 1,
      prevHash,
      hash: hashEntry(prevHash, input),
    };
    this.log.push(entry);
    this.byId.set(entry.id, entry);
    for (const p of entry.postings) {
      const k = balanceKey(p.account, p.currency);
      this.bal.set(k, (this.bal.get(k) ?? 0n) + (p.side === "debit" ? p.amount : -p.amount));
    }
    return { entry, duplicate: false };
  }

  audit(): AuditReport {
    return audit(this.log, this.bal);
  }
}

/** Builds the four-posting entry for one trade: asset for cash, cash for asset. */
export function tradeEntry(t: { id: string; buyer: string; seller: string; price: bigint; qty: bigint; base: string; quote: string }): EntryInput {
  const cash = t.price * t.qty;
  return {
    id: t.id,
    memo: `trade ${t.id}`,
    postings: [
      { account: t.buyer, side: "debit", amount: t.qty, currency: t.base },
      { account: t.seller, side: "credit", amount: t.qty, currency: t.base },
      { account: t.seller, side: "debit", amount: cash, currency: t.quote },
      { account: t.buyer, side: "credit", amount: cash, currency: t.quote },
    ],
  };
}
