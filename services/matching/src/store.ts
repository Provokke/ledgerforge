import { tx } from "@ledgerforge/shared";
import type { CancelMsg, OrderMsg, Pool } from "@ledgerforge/shared";
import type { EngineOutput } from "./engine.ts";

export interface LogRow {
  seq: number;
  msgId: string;
  symbol: string;
  kind: "order" | "cancel";
  body: OrderMsg | CancelMsg;
  output: EngineOutput;
  published: boolean;
}

/** The matching journal. See migrations/001_init.sql for why it exists. */
export class MatchLog {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Every row in arrival order, streamed in pages so a long log does not sit in memory twice. */
  async *replay(pageSize = 5000): AsyncGenerator<LogRow> {
    let after = 0;
    for (;;) {
      const { rows } = await this.pool.query(
        "SELECT seq, msg_id, symbol, kind, body, output, published FROM match_log WHERE seq > $1 ORDER BY seq LIMIT $2",
        [after, pageSize],
      );
      for (const r of rows) yield toRow(r);
      if (rows.length < pageSize) return;
      after = Number(rows[rows.length - 1].seq);
    }
  }

  async find(msgId: string): Promise<LogRow | undefined> {
    const { rows } = await this.pool.query("SELECT seq, msg_id, symbol, kind, body, output, published FROM match_log WHERE msg_id = $1", [msgId]);
    return rows[0] ? toRow(rows[0]) : undefined;
  }

  /** Commits the input and its result together. Returns false if this message id was already logged. */
  async append(msgId: string, symbol: string, kind: "order" | "cancel", body: unknown, output: EngineOutput): Promise<number | undefined> {
    return tx(this.pool, async (c) => {
      const r = await c.query(
        "INSERT INTO match_log (msg_id, symbol, kind, body, output) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (msg_id) DO NOTHING RETURNING seq",
        [msgId, symbol, kind, JSON.stringify(body), JSON.stringify(output)],
      );
      return r.rows[0] ? Number(r.rows[0].seq) : undefined;
    });
  }

  async markPublished(seq: number): Promise<void> {
    await this.pool.query("UPDATE match_log SET published = true WHERE seq = $1", [seq]);
  }
}

function toRow(r: Record<string, any>): LogRow {
  return { seq: Number(r.seq), msgId: r.msg_id, symbol: r.symbol, kind: r.kind, body: r.body, output: r.output, published: r.published };
}
