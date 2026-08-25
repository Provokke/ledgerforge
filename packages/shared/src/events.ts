// Event shapes that cross service boundaries. Amounts travel as decimal
// strings (JSON has no bigint) and are turned back into bigint at the edge.

export const KEYS = {
  /** gateway to accounts: please reserve funds and pass it on */
  orderPlaced: "order.placed",
  /** accounts to matching, one routing key per symbol: order.accepted.BTC-USD */
  orderAccepted: "order.accepted",
  /** gateway to matching, per symbol: order.cancel.BTC-USD */
  orderCancel: "order.cancel",
  orderUpdated: "order.updated",
  tradeExecuted: "trade.executed",
  depositMade: "deposit.made",
} as const;

export interface OrderMsg {
  orderId: string;
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  /** limit price in quote minor units per base unit; every order is a limit order */
  price: string;
  qty: string;
  tif: "GTC" | "IOC" | "FOK";
}

export interface CancelMsg {
  orderId: string;
  symbol: string;
}

export type OrderStatusMsg = "open" | "partial" | "filled" | "cancelled" | "rejected";

export interface OrderUpdated {
  orderId: string;
  accountId: string;
  symbol: string;
  status: OrderStatusMsg;
  filled: string;
  remaining: string;
  reason?: string;
  /** true once the order can never trade again, so held funds can be released */
  final: boolean;
}

export function splitSymbol(symbol: string): { base: string; quote: string } {
  const m = /^([A-Z0-9]{2,10})-([A-Z0-9]{2,10})$/.exec(symbol);
  if (!m) throw new RangeError(`bad symbol ${symbol}`);
  return { base: m[1]!, quote: m[2]! };
}

export interface TradeExecuted {
  tradeId: string;
  symbol: string;
  base: string;
  quote: string;
  buyer: string;
  seller: string;
  buyOrderId: string;
  sellOrderId: string;
  price: string;
  qty: string;
}

export interface DepositMade {
  eventId: string;
  account: string;
  currency: string;
  amount: string;
}

/** Strict positive-integer string to bigint. Rejects floats, signs, blanks and junk. */
export function parseAmount(s: unknown, what = "amount"): bigint {
  if (typeof s !== "string" || !/^[1-9][0-9]{0,30}$/.test(s)) throw new RangeError(`${what} must be a positive integer string`);
  return BigInt(s);
}

export const EXTERNAL = "@external";
