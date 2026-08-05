export type Side = "buy" | "sell";
export type TimeInForce = "GTC" | "IOC" | "FOK";

// Prices and quantities are integers in minor units. No floats anywhere.
export interface OrderInput {
  id: string;
  accountId: string;
  side: Side;
  /** leave price out for a market order */
  price?: number;
  qty: number;
  tif?: TimeInForce;
}

export interface Trade {
  seq: number;
  makerOrderId: string;
  takerOrderId: string;
  makerAccountId: string;
  takerAccountId: string;
  takerSide: Side;
  /** always the resting (maker) order's price */
  price: number;
  qty: number;
}

export type OrderStatus = "filled" | "partial" | "resting" | "cancelled" | "rejected";

export interface SubmitResult {
  orderId: string;
  status: OrderStatus;
  filled: number;
  remaining: number;
  trades: Trade[];
  reason?: string;
}

export interface BookLevel {
  price: number;
  qty: number;
  orders: number;
}
