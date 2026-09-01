import { KEYS } from "@ledgerforge/shared";
import type { Bus, DepositMade, TradeExecuted } from "@ledgerforge/shared";
import { LedgerStore } from "./store.ts";

export const QUEUES = { trades: "ledger.trade", deposits: "ledger.deposit" } as const;

/** Both consumers are idempotent (entry ids come from the event ids), so redelivery is harmless. */
export async function startConsumers(bus: Bus, store: LedgerStore): Promise<void> {
  await bus.subscribe<TradeExecuted>(QUEUES.trades, [KEYS.tradeExecuted], async (m) => void (await store.recordTrade(m.body)), { prefetch: 1 });
  await bus.subscribe<DepositMade>(QUEUES.deposits, [KEYS.depositMade], async (m) => void (await store.recordDeposit(m.body)), { prefetch: 1 });
}
