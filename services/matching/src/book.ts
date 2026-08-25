import type { BookLevel, OrderInput, Side, SubmitResult, Trade } from "./types.ts";

// One node per resting order. Levels are doubly linked lists, so a cancel
// is O(1) and FIFO order inside a price level comes for free.
interface Node {
  id: string;
  accountId: string;
  side: Side;
  price: number;
  qty: number;
  prev: Node | null;
  next: Node | null;
  level: Level;
}

interface Level {
  price: number;
  head: Node | null;
  tail: Node | null;
  qty: number;
  count: number;
}

// Each side keeps its prices in a sorted array with the BEST price at the end,
// so reading the top of the book and dropping an empty best level are O(1).
// Bids are ascending (best = highest), asks are descending (best = lowest).
class BookSide {
  readonly prices: number[] = [];
  readonly levels = new Map<number, Level>();
  private readonly ascending: boolean;
  constructor(ascending: boolean) {
    this.ascending = ascending;
  }

  best(): Level | undefined {
    const p = this.prices[this.prices.length - 1];
    return p === undefined ? undefined : this.levels.get(p);
  }

  // first index whose price sorts at or after `price` in this side's order
  private index(price: number): number {
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const p = this.prices[mid]!;
      if (this.ascending ? p < price : p > price) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  level(price: number): Level {
    let lvl = this.levels.get(price);
    if (!lvl) {
      lvl = { price, head: null, tail: null, qty: 0, count: 0 };
      this.levels.set(price, lvl);
      this.prices.splice(this.index(price), 0, price);
    }
    return lvl;
  }

  drop(lvl: Level): void {
    this.levels.delete(lvl.price);
    this.prices.splice(this.index(lvl.price), 1);
  }
}

export class OrderBook {
  private readonly bids = new BookSide(true);
  private readonly asks = new BookSide(false);
  private readonly orders = new Map<string, Node>();
  private tradeSeq = 0;

  get size(): number {
    return this.orders.size;
  }

  bestBid(): number | undefined {
    return this.bids.best()?.price;
  }

  bestAsk(): number | undefined {
    return this.asks.best()?.price;
  }

  has(id: string): boolean {
    return this.orders.has(id);
  }

  /** Open quantity left on a resting order, undefined if it isn't in the book. */
  remaining(id: string): number | undefined {
    return this.orders.get(id)?.qty;
  }

  /** Aggregated depth, best price first. */
  depth(side: Side, limit = Infinity): BookLevel[] {
    const s = side === "buy" ? this.bids : this.asks;
    const out: BookLevel[] = [];
    for (let i = s.prices.length - 1; i >= 0 && out.length < limit; i--) {
      const l = s.levels.get(s.prices[i]!)!;
      out.push({ price: l.price, qty: l.qty, orders: l.count });
    }
    return out;
  }

  submit(o: OrderInput): SubmitResult {
    const bad = this.validate(o);
    if (bad) return { orderId: o.id, status: "rejected", filled: 0, remaining: o.qty, trades: [], reason: bad };

    const tif = o.tif ?? (o.price === undefined ? "IOC" : "GTC");
    const market = o.price === undefined;
    const limit = o.price ?? 0;
    const opposite = o.side === "buy" ? this.asks : this.bids;
    const crosses = (p: number) => market || (o.side === "buy" ? p <= limit : p >= limit);

    // Fill-or-kill: make sure there is enough liquidity before touching anything.
    if (tif === "FOK" && this.available(o, crosses) < o.qty) {
      return { orderId: o.id, status: "cancelled", filled: 0, remaining: o.qty, trades: [], reason: "fok_unfillable" };
    }

    const trades: Trade[] = [];
    let remaining = o.qty;
    let stp = false;

    while (remaining > 0 && !stp) {
      const lvl = opposite.best();
      if (!lvl || !crosses(lvl.price)) break;
      let maker = lvl.head;
      while (maker && remaining > 0) {
        if (maker.accountId === o.accountId) {
          // self-trade prevention: stop the incoming order, leave the resting one alone
          stp = true;
          break;
        }
        const qty = Math.min(remaining, maker.qty);
        trades.push({
          seq: ++this.tradeSeq,
          makerOrderId: maker.id,
          takerOrderId: o.id,
          makerAccountId: maker.accountId,
          takerAccountId: o.accountId,
          takerSide: o.side,
          price: lvl.price,
          qty,
        });
        remaining -= qty;
        maker.qty -= qty;
        lvl.qty -= qty;
        const next: Node | null = maker.next;
        if (maker.qty === 0) this.unlink(maker, opposite);
        maker = next;
      }
    }

    const filled = o.qty - remaining;
    if (remaining === 0) return { orderId: o.id, status: "filled", filled, remaining, trades };

    // anything left over: only a plain GTC limit order rests
    if (market || tif !== "GTC" || stp) {
      const r: SubmitResult = { orderId: o.id, status: filled > 0 ? "partial" : "cancelled", filled, remaining, trades };
      if (stp) r.reason = "self_trade";
      else if (market) r.reason = "no_liquidity";
      return r;
    }
    this.rest(o, remaining);
    return { orderId: o.id, status: filled > 0 ? "partial" : "resting", filled, remaining, trades };
  }

  cancel(id: string): boolean {
    const n = this.orders.get(id);
    if (!n) return false;
    this.unlink(n, n.side === "buy" ? this.bids : this.asks);
    return true;
  }

  private validate(o: OrderInput): string | null {
    if (!o.id || this.orders.has(o.id)) return "duplicate_or_missing_id";
    if (!Number.isSafeInteger(o.qty) || o.qty <= 0) return "bad_qty";
    if (o.price !== undefined && (!Number.isSafeInteger(o.price) || o.price <= 0)) return "bad_price";
    // price * qty must stay a safe integer so notional maths never loses precision
    if (o.price !== undefined && !Number.isSafeInteger(o.price * o.qty)) return "notional_overflow";
    if (o.side !== "buy" && o.side !== "sell") return "bad_side";
    if (o.price === undefined && o.tif === "GTC") return "market_cannot_rest";
    return null;
  }

  // How much of the order could fill right now (stops early once it's enough).
  private available(o: OrderInput, crosses: (p: number) => boolean): number {
    const opposite = o.side === "buy" ? this.asks : this.bids;
    let sum = 0;
    for (let i = opposite.prices.length - 1; i >= 0; i--) {
      const l = opposite.levels.get(opposite.prices[i]!)!;
      if (!crosses(l.price)) break;
      for (let n = l.head; n; n = n.next) {
        // a same-account order would trigger self-trade prevention and block the rest
        if (n.accountId === o.accountId) return sum;
        sum += n.qty;
        if (sum >= o.qty) return sum;
      }
    }
    return sum;
  }

  private rest(o: OrderInput, qty: number): void {
    const side = o.side === "buy" ? this.bids : this.asks;
    const lvl = side.level(o.price!);
    const n: Node = { id: o.id, accountId: o.accountId, side: o.side, price: o.price!, qty, prev: lvl.tail, next: null, level: lvl };
    if (lvl.tail) lvl.tail.next = n;
    else lvl.head = n;
    lvl.tail = n;
    lvl.qty += qty;
    lvl.count++;
    this.orders.set(o.id, n);
  }

  // Removes the node and takes whatever qty it still has off the level total.
  private unlink(n: Node, side: BookSide): void {
    const lvl = n.level;
    if (n.prev) n.prev.next = n.next;
    else lvl.head = n.next;
    if (n.next) n.next.prev = n.prev;
    else lvl.tail = n.prev;
    lvl.qty -= n.qty;
    lvl.count--;
    this.orders.delete(n.id);
    if (lvl.count === 0) side.drop(lvl);
  }

  /** Test helper: walks the whole book and throws if an invariant is broken. */
  checkInvariants(): void {
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (bb !== undefined && ba !== undefined && bb >= ba) throw new Error(`book crossed ${bb} >= ${ba}`);
    let count = 0;
    for (const s of [this.bids, this.asks]) {
      for (let i = 1; i < s.prices.length; i++) {
        const a = s.prices[i - 1]!;
        const b = s.prices[i]!;
        if (!(s === this.bids ? a < b : a > b)) throw new Error("prices not sorted");
      }
      if (s.prices.length !== s.levels.size) throw new Error("price index drifted");
      for (const [p, l] of s.levels) {
        let q = 0;
        let c = 0;
        for (let n = l.head; n; n = n.next) {
          q += n.qty;
          c++;
          if (n.price !== p || n.qty <= 0) throw new Error("bad node");
        }
        if (q !== l.qty || c !== l.count || c === 0) throw new Error("level totals drifted");
        count += c;
      }
    }
    if (count !== this.orders.size) throw new Error("order index drifted");
  }
}
