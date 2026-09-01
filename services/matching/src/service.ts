import { KEYS } from "@ledgerforge/shared";
import type { Bus, CancelMsg, Logger, Message, OrderMsg } from "@ledgerforge/shared";
import { MatchingEngine } from "./engine.ts";
import type { EngineOutput } from "./engine.ts";

export const queueFor = (symbol: string) => `matching.${symbol}`;

/** Trades go out before the order updates so accounts settles a fill before it closes the hold. */
export async function publishOutput(bus: Bus, out: EngineOutput): Promise<void> {
  for (const t of out.trades) await bus.publish(KEYS.tradeExecuted, t, { id: `trade:${t.tradeId}` });
  for (const u of out.updates) await bus.publish(KEYS.orderUpdated, u, { id: `upd:${u.orderId}:${u.status}:${u.filled}` });
}

/**
 * One queue per symbol with prefetch 1: that queue is the single writer for the book.
 * Never run two replicas for the same symbol, they would each hold half a book.
 */
export async function startMatching(bus: Bus, engine: MatchingEngine, log: Logger): Promise<void> {
  for (const symbol of engine.symbols()) {
    await bus.subscribe<OrderMsg | CancelMsg>(
      queueFor(symbol),
      [`${KEYS.orderAccepted}.${symbol}`, `${KEYS.orderCancel}.${symbol}`],
      async (msg: Message<OrderMsg | CancelMsg>) => {
        const out = msg.key.startsWith(`${KEYS.orderCancel}.`) ? engine.cancel(msg.body as CancelMsg) : engine.place(msg.body as OrderMsg);
        if (out.trades.length) log.debug({ symbol, trades: out.trades.length }, "matched");
        await publishOutput(bus, out);
      },
      { prefetch: 1 },
    );
  }
}
