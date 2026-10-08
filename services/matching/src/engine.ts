import { parseAmount, splitSymbol } from "@ledgerforge/shared";
import type { CancelMsg, OrderMsg, OrderUpdated, TradeExecuted } from "@ledgerforge/shared";
import { OrderBook } from "./book.ts";
import type { BookLevel, SubmitResult } from "./types.ts";

export interface EngineOutput {
  trades: TradeExecuted[];
  updates: OrderUpdated[];
}

export interface EngineHooks {
  onOrder?: (symbol: string, status: string) => void;
  onLatency?: (symbol: string, seconds: number) => void;
  onDepth?: (symbol: string, side: "buy" | "sell", levels: number) => void;
}

interface Known {
  accountId: string;
  symbol: string;
  qty: number;
}

/**
 * Turns messages into trades and order updates. Pure and synchronous, no I/O:
 * the service wrapper publishes whatever comes back. One book per symbol, and
 * the caller must feed each symbol from a single consumer (that is the
 * single-writer rule, the queue per symbol is what enforces it).
 */
export class MatchingEngine {
  private readonly books = new Map<string, OrderBook>();
  private readonly known = new Map<string, Known>();
  private readonly hooks: EngineHooks;

  constructor(symbols: string[], hooks: EngineHooks = {}) {
    for (const s of symbols) {
      splitSymbol(s);
      this.books.set(s, new OrderBook());
    }
    this.hooks = hooks;
  }

  private quiet = false;

  /** Hooks feed metrics, so they stay off while the log is replayed at boot. */
  private live(): EngineHooks {
    return this.quiet ? {} : this.hooks;
  }

  /** Runs fn with the hooks off. */
  silently<T>(fn: () => T): T {
    this.quiet = true;
    try {
      return fn();
    } finally {
      this.quiet = false;
    }
  }

  symbols(): string[] {
    return [...this.books.keys()];
  }

  depth(symbol: string, side: "buy" | "sell", limit = 20): BookLevel[] {
    return this.book(symbol).depth(side, limit);
  }

  private book(symbol: string): OrderBook {
    const b = this.books.get(symbol);
    if (!b) throw new RangeError(`unknown symbol ${symbol}`);
    return b;
  }

  place(m: OrderMsg): EngineOutput {
    const started = process.hrtime.bigint();
    const out: EngineOutput = { trades: [], updates: [] };
    const book = this.books.get(m.symbol);
    if (!book) {
      out.updates.push(update(m, "rejected", 0, 0, true, "unknown_symbol"));
      return out;
    }
    let price: number;
    let qty: number;
    try {
      price = Number(parseAmount(m.price, "price"));
      qty = Number(parseAmount(m.qty, "qty"));
    } catch {
      out.updates.push(update(m, "rejected", 0, 0, true, "bad_number"));
      return out;
    }
    if (this.known.has(m.orderId)) {
      // a redelivered message: say nothing new, the first answer already went out
      return out;
    }

    const res = book.submit({ id: m.orderId, accountId: m.accountId, side: m.side, price, qty, tif: m.tif });
    if (res.status === "rejected") {
      out.updates.push(update(m, "rejected", 0, qty, true, res.reason));
      this.live().onOrder?.(m.symbol, "rejected");
      return out;
    }
    this.known.set(m.orderId, { accountId: m.accountId, symbol: m.symbol, qty });

    const { base, quote } = splitSymbol(m.symbol);
    for (const t of res.trades) {
      const buyOrderId = t.takerSide === "buy" ? t.takerOrderId : t.makerOrderId;
      const sellOrderId = t.takerSide === "buy" ? t.makerOrderId : t.takerOrderId;
      out.trades.push({
        tradeId: `${m.symbol}:${t.seq}`,
        symbol: m.symbol,
        base,
        quote,
        buyer: t.takerSide === "buy" ? t.takerAccountId : t.makerAccountId,
        seller: t.takerSide === "buy" ? t.makerAccountId : t.takerAccountId,
        buyOrderId,
        sellOrderId,
        price: String(t.price),
        qty: String(t.qty),
      });
    }
    this.pushUpdates(out, m, book, res);

    this.live().onOrder?.(m.symbol, res.status);
    this.live().onLatency?.(m.symbol, Number(process.hrtime.bigint() - started) / 1e9);
    this.live().onDepth?.(m.symbol, "buy", book.depth("buy").length);
    this.live().onDepth?.(m.symbol, "sell", book.depth("sell").length);
    return out;
  }

  cancel(m: CancelMsg): EngineOutput {
    const out: EngineOutput = { trades: [], updates: [] };
    const book = this.books.get(m.symbol);
    const k = this.known.get(m.orderId);
    if (!book || !k || k.symbol !== m.symbol) return out;
    const remaining = book.remaining(m.orderId);
    if (remaining === undefined || !book.cancel(m.orderId)) return out; // already filled or gone
    out.updates.push({ orderId: m.orderId, accountId: k.accountId, symbol: m.symbol, status: "cancelled", filled: String(k.qty - remaining), remaining: String(remaining), final: true });
    this.live().onOrder?.(m.symbol, "cancelled");
    this.live().onDepth?.(m.symbol, "buy", book.depth("buy").length);
    this.live().onDepth?.(m.symbol, "sell", book.depth("sell").length);
    return out;
  }

  private pushUpdates(out: EngineOutput, m: OrderMsg, book: OrderBook, res: SubmitResult): void {
    // makers first, in trade order, one update per maker with its latest state
    const seen = new Set<string>();
    for (let i = res.trades.length - 1; i >= 0; i--) {
      const t = res.trades[i]!;
      if (seen.has(t.makerOrderId)) continue;
      seen.add(t.makerOrderId);
      const k = this.known.get(t.makerOrderId);
      if (!k) continue;
      const left = book.remaining(t.makerOrderId) ?? 0;
      out.updates.push({
        orderId: t.makerOrderId,
        accountId: k.accountId,
        symbol: m.symbol,
        status: left === 0 ? "filled" : "partial",
        filled: String(k.qty - left),
        remaining: String(left),
        final: left === 0,
      });
    }
    const resting = book.has(m.orderId);
    const status = res.remaining === 0 ? "filled" : resting ? (res.filled > 0 ? "partial" : "open") : "cancelled";
    out.updates.push({
      orderId: m.orderId,
      accountId: m.accountId,
      symbol: m.symbol,
      status,
      filled: String(res.filled),
      remaining: String(res.remaining),
      ...(res.reason ? { reason: res.reason } : {}),
      final: !resting,
    });
  }
}

function update(m: OrderMsg, status: OrderUpdated["status"], filled: number, remaining: number, final: boolean, reason?: string): OrderUpdated {
  return { orderId: m.orderId, accountId: m.accountId, symbol: m.symbol, status, filled: String(filled), remaining: String(remaining), final, ...(reason ? { reason } : {}) };
}
