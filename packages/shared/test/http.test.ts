import { test, after } from "node:test";
import assert from "node:assert/strict";
import { App, HttpError } from "../src/http.ts";
import { createLogger } from "../src/logger.ts";
import { createMetrics } from "../src/metrics.ts";

const metrics = createMetrics("test", false);
const app = new App(createLogger("test", "silent"), metrics);
app.use((c) => {
  if (c.req.headers["x-api-key"] !== "k") throw new HttpError(401, "unauthorised");
});
app.standardRoutes(() => true);
app.get("/orders/:id", (c) => ({ id: c.params.id, big: 2n ** 70n }));
app.post("/echo", (c) => ({ got: c.body }));
const port = await app.listen(0, "127.0.0.1");
after(() => app.close());
const url = (p: string) => `http://127.0.0.1:${port}${p}`;
const auth = { "x-api-key": "k" };

test("routes params and serialises bigint as strings", async () => {
  const r = await fetch(url("/orders/a%20b"), { headers: auth });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { id: "a b", big: (2n ** 70n).toString() });
});

test("auth middleware guards routes but not open ones", async () => {
  assert.equal((await fetch(url("/orders/1"))).status, 401);
  assert.equal((await fetch(url("/healthz"))).status, 200);
  assert.equal((await fetch(url("/readyz"))).status, 200);
});

test("404, 405, bad json and oversized bodies", async () => {
  assert.equal((await fetch(url("/nope"), { headers: auth })).status, 404);
  assert.equal((await fetch(url("/orders/1"), { method: "POST", headers: auth, body: "{}" })).status, 405);
  assert.equal((await fetch(url("/echo"), { method: "POST", headers: auth, body: "{oops" })).status, 400);
  assert.equal((await fetch(url("/echo"), { method: "POST", headers: auth, body: "x".repeat(70_000) })).status, 413);
});

test("request id is echoed and errors carry it", async () => {
  const r = await fetch(url("/nope"), { headers: { ...auth, "x-request-id": "req-1" } });
  assert.equal(r.headers.get("x-request-id"), "req-1");
  assert.equal(((await r.json()) as { requestId: string }).requestId, "req-1");
});

test("/metrics exposes request counters with route labels, not raw paths", async () => {
  await fetch(url("/orders/777"), { headers: auth });
  const text = await (await fetch(url("/metrics"))).text();
  assert.match(text, /http_requests_total\{[^}]*route="\/orders\/:id"[^}]*\} \d+/);
  assert.doesNotMatch(text, /orders\/777/);
});
