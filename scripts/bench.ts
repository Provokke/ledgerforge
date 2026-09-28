// Micro-benchmark for the order book alone: no network, no database, one thread.
// It says nothing about the whole system, which is limited by Postgres and RabbitMQ.
//   node scripts/bench.ts [orders]
import { OrderBook } from "../services/matching/src/book.ts";

const N = Number(process.argv[2] ?? 1_000_000);

// small deterministic generator so every run does the same work
let s = 123456789;
const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);

function run(label: string, n: number, mix: (i: number) => { side: "buy" | "sell"; price: number; qty: number }, cancelEvery = 0) {
  const book = new OrderBook();
  const lat = new Float64Array(n);
  let trades = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    const o = mix(i);
    const a = process.hrtime.bigint();
    const r = book.submit({ id: `o${i}`, accountId: `a${i % 100}`, side: o.side, price: o.price, qty: o.qty, tif: "GTC" });
    if (cancelEvery && i % cancelEvery === 0 && i > 0) book.cancel(`o${i - cancelEvery}`);
    lat[i] = Number(process.hrtime.bigint() - a);
    trades += r.trades.length;
  }
  const secs = Number(process.hrtime.bigint() - t0) / 1e9;
  const sorted = lat.slice().sort();
  const q = (p: number) => (sorted[Math.min(n - 1, Math.floor(n * p))]! / 1000).toFixed(2);
  console.log(
    `${label.padEnd(22)} ${Math.round(n / secs).toLocaleString().padStart(10)} orders/s  p50 ${q(0.5)}us  p99 ${q(0.99)}us  p99.9 ${q(0.999)}us  trades ${trades.toLocaleString()}  resting ${book.size.toLocaleString()}`,
  );
}

// warm up the JIT so the first run is not unfairly slow
run("warm-up", 100_000, (i) => ({ side: i % 2 ? "buy" : "sell", price: 10_000 + Math.floor(rnd() * 100), qty: 1 + Math.floor(rnd() * 10) }));

// everything rests: bids low, asks high, nothing crosses
run("rest only", N, (i) => (i % 2 ? { side: "buy", price: 9_000 - Math.floor(rnd() * 500), qty: 5 } : { side: "sell", price: 11_000 + Math.floor(rnd() * 500), qty: 5 }));

// both sides around the same price, so a good share of orders cross
run("crossing mix", N, (i) => ({ side: i % 2 ? "buy" : "sell", price: 10_000 + Math.floor(rnd() * 100) - 50, qty: 1 + Math.floor(rnd() * 10) }));

// resting orders with a cancel for every few submits
run("rest + cancel", N, (i) => (i % 2 ? { side: "buy", price: 9_000 - Math.floor(rnd() * 500), qty: 5 } : { side: "sell", price: 11_000 + Math.floor(rnd() * 500), qty: 5 }), 3);
