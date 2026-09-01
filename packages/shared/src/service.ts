import type { Logger } from "pino";
import { shutdownTracing } from "./tracing.ts";

type Closer = { name: string; fn: () => Promise<unknown> | unknown };

/**
 * Collects things to close and runs them in reverse order on SIGTERM/SIGINT.
 * Reverse because whatever was opened last (the http server, then consumers)
 * should stop taking work before the pool and broker go away under it.
 */
export class Lifecycle {
  private readonly closers: Closer[] = [];
  private readonly log: Logger;
  private done: Promise<void> | undefined;
  private ok = true;

  constructor(log: Logger) {
    this.log = log;
  }

  add(name: string, fn: Closer["fn"]): void {
    this.closers.push({ name, fn });
  }

  /** Hooks signals. Exits 0 on a clean stop, 1 if something refused to close. */
  install(): void {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        this.log.info({ sig }, "shutting down");
        void this.shutdown().then((ok) => process.exit(ok ? 0 : 1));
      });
    }
  }

  shutdown(): Promise<boolean> {
    this.done ??= this.run();
    return this.done.then(() => this.ok);
  }

  private async run(): Promise<void> {
    const timer = setTimeout(() => {
      this.log.error("shutdown timed out");
      process.exit(1);
    }, 20_000);
    timer.unref();
    for (const c of [...this.closers].reverse()) {
      try {
        await c.fn();
      } catch (err) {
        this.ok = false;
        this.log.error({ closer: c.name, err: (err as Error).message }, "close failed");
      }
    }
    await shutdownTracing().catch(() => {});
  }
}
