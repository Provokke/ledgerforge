import { KEYS, parseAmount, splitSymbol } from "@ledgerforge/shared";
import type { Bus, DepositMade, Logger, Message, OrderMsg, OrderUpdated, TradeExecuted } from "@ledgerforge/shared";
import { AccountsRepo, HoldError, InsufficientFunds } from "./repo.ts";

export const QUEUES = {
  orders: "accounts.orders",
  fills: "accounts.fills",
  deposits: "accounts.deposits",
} as const;

function rejected(m: OrderMsg, reason: string): OrderUpdated {
  return { orderId: m.orderId, accountId: m.accountId, symbol: m.symbol, status: "rejected", filled: "0", remaining: m.qty, reason, final: true };
}

/** What an order has to reserve: quote for a buy (qty * price), base for a sell. */
export function holdFor(m: OrderMsg): { currency: string; amount: bigint } {
  const { base, quote } = splitSymbol(m.symbol);
  const qty = parseAmount(m.qty, "qty");
  const price = parseAmount(m.price, "price");
  return m.side === "buy" ? { currency: quote, amount: qty * price } : { currency: base, amount: qty };
}

/**
 * Wires the accounts queues.
 *
 *  - accounts.orders: reserve funds, then hand the order to matching. Prefetch
 *    1 keeps one account's orders in the order they arrived.
 *  - accounts.fills: trades and final order updates share ONE queue with
 *    prefetch 1 and a single active consumer, so a trade is always settled
 *    before the hold it draws on is released, even with several replicas.
 *  - accounts.deposits: credit the balance.
 */
export async function startConsumers(bus: Bus, repo: AccountsRepo, log: Logger): Promise<void> {
  await bus.subscribe<OrderMsg>(
    QUEUES.orders,
    [KEYS.orderPlaced],
    async (msg) => {
      const m = msg.body;
      let hold: { currency: string; amount: bigint };
      try {
        hold = holdFor(m);
      } catch {
        await bus.publish(KEYS.orderUpdated, rejected(m, "bad_order"), { id: `rej:${m.orderId}` });
        return;
      }
      try {
        // false means this order already has a hold (a redelivery). Still forward it,
        // since the first attempt may have died before publishing. Matching ignores repeats.
        await repo.placeHold(m.orderId, m.accountId, hold.currency, hold.amount);
      } catch (err) {
        if (err instanceof InsufficientFunds || err instanceof HoldError) {
          const reason = err instanceof InsufficientFunds ? "insufficient_funds" : "unknown_account";
          log.info({ orderId: m.orderId, reason }, "order rejected");
          await bus.publish(KEYS.orderUpdated, rejected(m, reason), { id: `rej:${m.orderId}` });
          return;
        }
        throw err;
      }
      await bus.publish(`${KEYS.orderAccepted}.${m.symbol}`, m, { id: `acc:${m.orderId}` });
    },
    { prefetch: 1 },
  );

  await bus.subscribe<TradeExecuted | OrderUpdated>(
    QUEUES.fills,
    [KEYS.tradeExecuted, KEYS.orderUpdated],
    async (msg: Message<TradeExecuted | OrderUpdated>) => {
      if (msg.key === KEYS.tradeExecuted) {
        const t = msg.body as TradeExecuted;
        await repo.settleTrade({
          tradeId: t.tradeId,
          buyer: t.buyer,
          seller: t.seller,
          base: t.base,
          quote: t.quote,
          qty: parseAmount(t.qty, "qty"),
          price: parseAmount(t.price, "price"),
          buyHoldId: t.buyOrderId,
          sellHoldId: t.sellOrderId,
        });
        return;
      }
      const u = msg.body as OrderUpdated;
      if (!u.final) return;
      try {
        const back = await repo.releaseHold(u.orderId);
        if (back > 0n) log.info({ orderId: u.orderId, status: u.status, released: back.toString() }, "hold released");
      } catch (err) {
        // our own rejections never had a hold, so there is nothing to give back
        if (err instanceof HoldError && /no such hold/.test(err.message)) return;
        throw err;
      }
    },
    { prefetch: 1, singleActiveConsumer: true },
  );

  await bus.subscribe<DepositMade>(
    QUEUES.deposits,
    [KEYS.depositMade],
    async (msg) => {
      const d = msg.body;
      await repo.createAccount(d.account, d.account);
      await repo.deposit(d.eventId, d.account, d.currency, parseAmount(d.amount));
    },
    { prefetch: 5 },
  );
}
