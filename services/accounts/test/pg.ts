import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createPool, waitForDb } from "@ledgerforge/shared";
import type { Pool } from "@ledgerforge/shared";

export interface TestPg {
  pool: Pool;
  stop: () => Promise<void>;
}

/** Throwaway postgres in docker on a random port. Always call stop(). */
export async function startPg(): Promise<TestPg> {
  const name = `lf-test-pg-${randomBytes(4).toString("hex")}`;
  execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_PASSWORD=test", "-p", "127.0.0.1::5432", "postgres:17-alpine"], { stdio: "ignore" });
  const out = execFileSync("docker", ["port", name, "5432/tcp"]).toString().trim().split("\n")[0]!;
  const port = out.slice(out.lastIndexOf(":") + 1);
  const pool = createPool(`postgres://postgres:test@127.0.0.1:${port}/postgres`, 20);
  try {
    await waitForDb(pool, 60, 500);
  } catch (err) {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    throw err;
  }
  return {
    pool,
    stop: async () => {
      await pool.end().catch(() => {});
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    },
  };
}
