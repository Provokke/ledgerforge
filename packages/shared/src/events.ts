// Event shapes that cross service boundaries. Amounts travel as decimal
// strings (JSON has no bigint) and are turned back into bigint at the edge.

export const KEYS = {
  orderPlaced: "order.placed",
  orderCancel: "order.cancel",
  orderUpdated: "order.updated",
  tradeExecuted: "trade.executed",
  depositMade: "deposit.made",
} as const;

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
