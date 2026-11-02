import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Bus, createLogger } from "../src/index.ts";

// Real RabbitMQ. This is about what replicas of one service can and can't do to
// message order when they share a queue.
describe("bus @integration", () => {
  const name = `lf-test-mq-${randomBytes(4).toString("hex")}`;
  const log = createLogger("mq-itest", "silent");
  let url: string;
  const buses: Bus[] = [];

  before(async () => {
    execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-e", "RABBITMQ_DEFAULT_USER=lf", "-e", "RABBITMQ_DEFAULT_PASS=lf", "-p", "127.0.0.1::5672", "rabbitmq:4-alpine"], { stdio: "ignore" });
    const out = execFileSync("docker", ["port", name, "5672/tcp"]).toString().trim().split("\n")[0]!;
    url = `amqp://lf:lf@127.0.0.1:${out.slice(out.lastIndexOf(":") + 1)}`;
  });

  after(async () => {
    for (const b of buses) await b.close().catch(() => {});
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {}
  });

  async function connect(): Promise<Bus> {
    const bus = await Bus.connect(url, log, { retries: 60 });
    buses.push(bus);
    return bus;
  }

  it("a single active consumer keeps a slow message ahead of the next one across replicas", async () => {
    const [a, b, pub] = [await connect(), await connect(), await connect()];
    const done: string[] = [];
    const handler = async (m: { id: string }) => {
      if (m.id === "first") await new Promise((r) => setTimeout(r, 400)); // slow one
      done.push(m.id);
    };
    const opts = { prefetch: 1, singleActiveConsumer: true };
    await a.subscribe("order.test", ["order.key"], handler, opts);
    await b.subscribe("order.test", ["order.key"], handler, opts);

    await pub.publish("order.key", {}, { id: "first" });
    await pub.publish("order.key", {}, { id: "second" });

    const end = Date.now() + 10_000;
    while (done.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(done, ["first", "second"]);
  });
});
