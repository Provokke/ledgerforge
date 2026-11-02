import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from "amqplib";
import type { Logger } from "pino";
import { extract, inject, withSpan } from "./tracing.ts";
import type { Metrics } from "./metrics.ts";

export const EXCHANGE = "ledgerforge";
export const DLX = "ledgerforge.dlx";

export interface Message<T = unknown> {
  id: string;
  key: string;
  body: T;
  headers: Record<string, unknown>;
}

export interface SubscribeOptions {
  /** how many times a failing message is retried before it lands in the dead-letter queue */
  maxRetries?: number;
  retryDelayMs?: number;
  prefetch?: number;
  /** only one consumer reads at a time, so replicas can't process messages out of order */
  singleActiveConsumer?: boolean;
}

/**
 * Thin wrapper over amqplib.
 *  - one topic exchange, durable queues, persistent messages, publisher confirms
 *  - consumers use manual ack
 *  - a failed message goes to `<queue>.retry` (TTL, then back to the queue) and
 *    after maxRetries to `<queue>.dlq`
 */
export class Bus {
  private readonly conn: ChannelModel;
  private readonly pub: ConfirmChannel;
  private readonly chans: Channel[] = [];
  private readonly log: Logger;
  private readonly metrics: Metrics | undefined;
  private closing = false;

  private constructor(conn: ChannelModel, pub: ConfirmChannel, log: Logger, metrics: Metrics | undefined, onFatal: () => void) {
    this.conn = conn;
    this.pub = pub;
    this.log = log;
    this.metrics = metrics;
    conn.on("error", (err: Error) => log.error({ err: err.message }, "amqp connection error"));
    conn.on("close", () => {
      if (this.closing) return;
      log.error("amqp connection closed unexpectedly");
      onFatal();
    });
  }

  static async connect(url: string, log: Logger, opts: { metrics?: Metrics; retries?: number; onFatal?: () => void } = {}): Promise<Bus> {
    const tries = opts.retries ?? 30;
    for (let i = 0; ; i++) {
      try {
        const conn = await amqp.connect(url);
        const pub = await conn.createConfirmChannel();
        await pub.assertExchange(EXCHANGE, "topic", { durable: true });
        await pub.assertExchange(DLX, "direct", { durable: true });
        return new Bus(conn, pub, log, opts.metrics, opts.onFatal ?? (() => process.exit(1)));
      } catch (err) {
        if (i >= tries) throw err;
        log.warn({ attempt: i + 1, err: (err as Error).message }, "rabbitmq not ready, retrying");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Resolves once the broker has confirmed the message. */
  async publish(key: string, body: unknown, opts: { id: string; headers?: Record<string, unknown> }): Promise<void> {
    const headers = inject({ ...(opts.headers ?? {}) });
    await new Promise<void>((resolve, reject) => {
      this.pub.publish(EXCHANGE, key, Buffer.from(JSON.stringify(body)), { persistent: true, messageId: opts.id, contentType: "application/json", headers }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  async subscribe<T>(queue: string, keys: string[], handler: (m: Message<T>) => Promise<void>, opts: SubscribeOptions = {}): Promise<void> {
    const maxRetries = opts.maxRetries ?? 3;
    const retryDelayMs = opts.retryDelayMs ?? 5000;
    const ch = await this.conn.createChannel();
    this.chans.push(ch);
    await ch.prefetch(opts.prefetch ?? 10);

    await ch.assertQueue(`${queue}.dlq`, { durable: true });
    await ch.bindQueue(`${queue}.dlq`, DLX, queue);
    await ch.assertQueue(`${queue}.retry`, {
      durable: true,
      arguments: { "x-message-ttl": retryDelayMs, "x-dead-letter-exchange": "", "x-dead-letter-routing-key": queue },
    });
    await ch.assertQueue(queue, {
      durable: true,
      arguments: {
        "x-dead-letter-exchange": DLX,
        "x-dead-letter-routing-key": queue,
        ...(opts.singleActiveConsumer ? { "x-single-active-consumer": true } : {}),
      },
    });
    for (const k of keys) await ch.bindQueue(queue, EXCHANGE, k);

    await ch.consume(queue, (raw) => {
      if (raw) void this.handle(ch, queue, raw, handler as (m: Message) => Promise<void>, maxRetries);
    });
  }

  private async handle(ch: Channel, queue: string, raw: ConsumeMessage, handler: (m: Message) => Promise<void>, maxRetries: number): Promise<void> {
    const headers = raw.properties.headers ?? {};
    const retries = Number(headers["x-retries"] ?? 0);
    const end = this.metrics?.messageDuration.startTimer({ queue });
    let msg: Message;
    try {
      msg = { id: raw.properties.messageId ?? "", key: raw.fields.routingKey, body: JSON.parse(raw.content.toString()), headers };
    } catch {
      // unparseable payloads will never succeed, so straight to the dead-letter queue
      this.log.error({ queue }, "poison message, dead-lettering");
      this.metrics?.messages.inc({ queue, outcome: "poison" });
      ch.nack(raw, false, false);
      return;
    }
    try {
      await withSpan(`consume ${queue}`, () => handler(msg), extract(headers));
      ch.ack(raw);
      this.metrics?.messages.inc({ queue, outcome: "ok" });
    } catch (err) {
      this.log.warn({ queue, id: msg.id, retries, err: (err as Error).message }, "message handler failed");
      if (retries >= maxRetries) {
        ch.nack(raw, false, false); // broker routes it to the dead-letter queue
        this.metrics?.messages.inc({ queue, outcome: "dead" });
      } else {
        ch.sendToQueue(`${queue}.retry`, raw.content, { persistent: true, messageId: msg.id, contentType: "application/json", headers: { ...headers, "x-retries": retries + 1 } });
        ch.ack(raw);
        this.metrics?.messages.inc({ queue, outcome: "retry" });
      }
    } finally {
      end?.();
    }
  }

  async depth(queue: string): Promise<number> {
    const ch = await this.conn.createChannel();
    try {
      return (await ch.checkQueue(queue)).messageCount;
    } finally {
      await ch.close().catch(() => {});
    }
  }

  get ready(): boolean {
    return !this.closing;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const c of this.chans) await c.close().catch(() => {});
    await this.pub.close().catch(() => {});
    await this.conn.close().catch(() => {});
  }
}
