import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { Logger } from "pino";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

// bigint columns come back as strings by default. Hand them back as bigint
// so money never passes through a float on the way out.
pg.types.setTypeParser(20, (v) => BigInt(v));

export function createPool(url: string, max = 10): Pool {
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30_000 });
}

/** Runs fn in a transaction. Rolls back on any throw, always releases the client. */
export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>, isolation: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE" = "READ COMMITTED"): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

/**
 * Plain-SQL migrations: files named 001_name.sql, applied in order, each in
 * its own transaction. Applied files are recorded with a checksum, so editing
 * an old migration is caught instead of silently ignored. An advisory lock
 * keeps two replicas starting at once from racing.
 */
export async function migrate(pool: Pool, dir: string, scope: string, log?: Logger): Promise<string[]> {
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query("SELECT pg_advisory_lock(hashtext($1))", [`migrate:${scope}`]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      scope text NOT NULL, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope, name))`);
    const done = new Map<string, string>(
      (await c.query("SELECT name, checksum FROM schema_migrations WHERE scope = $1", [scope])).rows.map((r) => [r.name, r.checksum]),
    );
    for (const f of files) {
      const sql = readFileSync(join(dir, f), "utf8");
      const sum = createHash("sha256").update(sql).digest("hex");
      const prev = done.get(f);
      if (prev) {
        if (prev !== sum) throw new Error(`migration ${f} changed after it was applied`);
        continue;
      }
      try {
        await c.query("BEGIN");
        await c.query(sql);
        await c.query("INSERT INTO schema_migrations (scope, name, checksum) VALUES ($1, $2, $3)", [scope, f, sum]);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
      applied.push(f);
      log?.info({ migration: f, scope }, "migration applied");
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtext($1))", [`migrate:${scope}`]).catch(() => {});
    c.release();
  }
  return applied;
}

/**
 * Consumer-side idempotency: returns true the first time an event id is seen
 * for a consumer, false on every replay. Call it inside the same transaction
 * as the work so a crash can't mark an event done without doing it.
 */
export async function firstTime(c: Client, consumer: string, eventId: string): Promise<boolean> {
  const r = await c.query("INSERT INTO processed_events (consumer, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [consumer, eventId]);
  return r.rowCount === 1;
}

export async function waitForDb(pool: Pool, tries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
