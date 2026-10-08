import { KEYS } from "@ledgerforge/shared";
import type { Bus, CancelMsg, Logger, Message, OrderMsg } from "@ledgerforge/shared";
import { MatchingEngine } from "./engine.ts";
import type { EngineOutput } from "./engine.ts";
import { MatchLog } from "./store.ts";
import { isDeepStrictEqual } from "node:util";

export const queueFor = (symbol: string) => `matching.${symbol}`;

/** Trades go out before the order updates so accounts settles a fill before it closes the hold. */
export async function publishOutput(bus: Bus, out: EngineOutput): Promise<void> {
  for (const t of out.trades) await bus.publish(KEYS.tradeExecuted, t, { id: `trade:${t.tradeId}` });
  for (const u of out.updates) await bus.publish(KEYS.orderUpdated, u, { id: `upd:${u.orderId}:${u.status}:${u.filled}` });
}

/**
 * Rebuilds every book from the journal. Each row is fed back in with its
 * original arrival order and the result is compared with what was stored the
 * first time. If they differ, the engine is no longer deterministic (or the
 * log was tampered with) and carrying on would trade against a wrong book, so
 * this throws and the service refuses to start.
 */
export async function restore(engine: MatchingEngine, store: MatchLog, log: Logger): Promise<number> {
  let n = 0;
  const known = new Set(engine.symbols());
  for await (const row of store.replay()) {
    if (!known.has(row.symbol)) continue; // a symbol that was switched off: its book is not rebuilt
    const out = engine.silently(() => (row.kind === "cancel" ? engine.cancel(row.body as CancelMsg) : engine.place(row.body as OrderMsg)));
    if (!isDeepStrictEqual(out, row.output)) {
      throw new Error(`replay diverged at log seq ${row.seq} (${row.msgId}): the book would not match what was already published`);
    }
    n++;
  }
  log.info({ replayed: n }, "book restored from journal");
  return n;
}

/**
 * One queue per symbol with prefetch 1: that queue is the single writer for the book.
 * Never run two replicas for the same symbol, they would each hold half a book.
 *
 * For each message: work out the result, commit input and result to the journal,
 * publish, then mark it published. A crash anywhere in there ends in a redelivery,
 * which finds the journal row and just publishes the stored result again. The
 * consumers downstream drop repeated event ids, so doing that twice is harmless.
 */
export async function startMatching(bus: Bus, engine: MatchingEngine, store: MatchLog, log: Logger, onFatal: () => void = () => process.exit(1)): Promise<void> {
  for (const symbol of engine.symbols()) {
    await bus.subscribe<OrderMsg | CancelMsg>(
      queueFor(symbol),
      [`${KEYS.orderAccepted}.${symbol}`, `${KEYS.orderCancel}.${symbol}`],
      async (msg: Message<OrderMsg | CancelMsg>) => {
        const prior = await store.find(msg.id);
        if (prior) {
          if (!prior.published) {
            await publishOutput(bus, prior.output);
            await store.markPublished(prior.seq);
          }
          return;
        }
        const isCancel = msg.key.startsWith(`${KEYS.orderCancel}.`);
        const out = isCancel ? engine.cancel(msg.body as CancelMsg) : engine.place(msg.body as OrderMsg);
        let seq: number | undefined;
        try {
          seq = await store.append(msg.id, symbol, isCancel ? "cancel" : "order", msg.body, out);
        } catch (err) {
          // The book has already moved but the journal has not. Memory and journal now disagree,
          // so stop and let the restart rebuild the book from the journal.
          log.fatal({ err: (err as Error).message, msgId: msg.id }, "journal write failed, restarting to resync");
          onFatal();
          throw err;
        }
        if (seq === undefined) throw new Error(`journal already had ${msg.id}`);
        if (out.trades.length) log.debug({ symbol, trades: out.trades.length }, "matched");
        await publishOutput(bus, out);
        await store.markPublished(seq);
      },
      { prefetch: 1 },
    );
  }
}
