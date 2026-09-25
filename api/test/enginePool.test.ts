import { test } from "node:test";
import assert from "node:assert/strict";
import { EngineError, type EngineQuery, type EngineResult } from "../src/services/engineClient.ts";
import { EnginePool, type LbStrategy, type PoolOptions } from "../src/services/enginePool.ts";

const URLS = ["http://w1", "http://w2", "http://w3", "http://w4"];
const q = (source = "BD", destination = "NDLS"): EngineQuery => ({ source, destination, date: "2026-09-25", time: "10:00" });

function result(worker: string): EngineResult {
  return { status: "ok", query: { source: "BD", destination: "NDLS", search_datetime: "" }, routes: [], stats: { worker } as any, search_complete: true };
}

// Fake workers: per-URL latency and failure behaviour, and a log of which worker served each call.
function fakeWorkers(behaviour: Record<string, { ms?: number; fail?: boolean }> = {}) {
  const log: string[] = [];
  const aborted: string[] = [];
  const call: PoolOptions["call"] = (url, _q, signal) =>
    new Promise((resolve, reject) => {
      const b = behaviour[url] ?? {};
      const t = setTimeout(() => {
        log.push(url);
        if (b.fail) reject(new EngineError("routing engine unreachable", 503, "unavailable"));
        else resolve(result(url));
      }, b.ms ?? 1);
      // like postRoute: an aborted fetch surfaces as "unavailable"
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        aborted.push(url);
        reject(new EngineError(`routing engine unreachable: ${signal.reason?.message}`, 503, "unavailable"));
      }, { once: true });
    });
  const healthCall: PoolOptions["healthCall"] = async (url) => {
    if (behaviour[url]?.fail) throw new Error("down");
    return { status: "ok", config: { top_k: 50 }, worker: url };
  };
  return { log, aborted, call, healthCall };
}

function pool(strategy: LbStrategy, fw: ReturnType<typeof fakeWorkers>, extra: Partial<PoolOptions> = {}) {
  return new EnginePool({
    urls: URLS, timeoutMs: 1000, perWorkerConcurrency: 1, strategy, retryMax: 0, hedgeAfterMs: 0, maxQueue: -1,
    failThreshold: 2, healthIntervalMs: 0, call: fw.call, healthCall: fw.healthCall, ...extra,
  });
}

test("round_robin cycles through workers in order", async () => {
  const fw = fakeWorkers();
  const p = pool("round_robin", fw);
  for (let i = 0; i < 8; i++) await p.route(q());
  assert.deepEqual(fw.log, [...URLS, ...URLS]);
});

test("least_outstanding rotates among idle workers", async () => {
  const fw = fakeWorkers();
  const p = pool("least_outstanding", fw);
  for (let i = 0; i < 4; i++) await p.route(q());
  assert.equal(new Set(fw.log).size, 4);
});

test("least_outstanding avoids a busy worker; p2c picks the less loaded of two", async () => {
  const fw = fakeWorkers({ "http://w1": { ms: 50 } });
  const p = pool("least_outstanding", fw);
  const slow = p.route(q());                       // w1 (all idle, first wins)
  for (let i = 0; i < 3; i++) await p.route(q());  // never w1 while it is busy
  await slow;
  assert.deepEqual(fw.log.slice(0, 3).includes("http://w1"), false);

  // p2c with a scripted random: candidates w1 (busy) and w2 -> w2
  const fw2 = fakeWorkers({ "http://w1": { ms: 50 } });
  const seq = [0, 0, 0.3];
  const p2 = pool("p2c", fw2, { random: () => seq.shift() ?? 0 });
  const busy = p2.route(q());                      // a = b = w1
  await p2.route(q());                             // a = w1 (busy), b = w2
  await busy;
  assert.deepEqual(fw2.log, ["http://w2", "http://w1"]);
});

test("consistent_hash keeps a pair on one worker and moves only the ejected worker's keys", async () => {
  const fw = fakeWorkers();
  const p = pool("consistent_hash", fw);
  const pairs = Array.from({ length: 40 }, (_, i) => q(`S${i}`, `D${i}`));
  const first: string[] = [];
  for (const x of pairs) { await p.route(x); first.push(fw.log.at(-1)!); }
  for (const x of pairs) await p.route(x);
  assert.deepEqual(fw.log.slice(40), first);
  assert.ok(new Set(first).size >= 3, "keys spread over workers");

  p.setWorkers(URLS.slice(0, 3));                  // w4 leaves
  const moved: string[] = [];
  for (const x of pairs) { await p.route(x); moved.push(fw.log.at(-1)!); }
  first.forEach((w, i) => { if (w !== "http://w4") assert.equal(moved[i], w); });
});

test("retry moves to another worker; repeated failures eject until health passes", async () => {
  const behaviour: Record<string, { fail?: boolean }> = { "http://w1": { fail: true } };
  const fw = fakeWorkers(behaviour);
  const p = pool("round_robin", fw, { retryMax: 1 });
  const r = await p.route(q());
  assert.equal((r.stats as any).worker, "http://w2");
  assert.equal(p.counters.retries, 1);

  await p.route(q()); await p.route(q()); await p.route(q()); // w3, w4, then w1 fails again -> ejected
  assert.equal(p.snapshot().workers[0].healthy, false);
  fw.log.length = 0;
  for (let i = 0; i < 6; i++) await p.route(q());
  assert.ok(!fw.log.includes("http://w1"), "ejected worker gets no traffic");

  behaviour["http://w1"] = {};
  await p.checkHealth();
  assert.equal(p.snapshot().workers[0].healthy, true);

  const noRetry = pool("round_robin", fakeWorkers({ "http://w1": { fail: true } }));
  await assert.rejects(noRetry.route(q()), (e: EngineError) => e.kind === "unavailable");
});

test("invalid queries are not retried", async () => {
  const p = pool("round_robin", fakeWorkers(), {
    retryMax: 3,
    call: async () => { throw new EngineError("unknown source station", 400, "invalid"); },
  });
  await assert.rejects(p.route(q()), (e: EngineError) => e.kind === "invalid");
  assert.equal(p.counters.retries, 0);
});

test("hedging answers from the fast worker and aborts the slow one", async () => {
  const fw = fakeWorkers({ "http://w1": { ms: 200 } });
  const p = pool("round_robin", fw, { hedgeAfterMs: 20 });
  const t0 = performance.now();
  const r = await p.route(q());
  assert.equal((r.stats as any).worker, "http://w2");
  assert.ok(performance.now() - t0 < 150);
  assert.deepEqual(fw.aborted, ["http://w1"]);
  assert.equal(p.counters.hedges, 1);
  assert.equal(p.counters.hedgeWins, 1);
  assert.equal(p.snapshot().workers[0].errors, 0, "a hedge loser is not counted as a worker error");

  const fast = await p.route(q());                 // w3 answers before the timer: no hedge
  assert.equal((fast.stats as any).worker, "http://w3");
  assert.equal(p.counters.hedges, 1);
});

test("admission control rejects beyond capacity + MAX_QUEUE with 429", async () => {
  const fw = fakeWorkers(Object.fromEntries(URLS.map((u) => [u, { ms: 30 }])));
  const p = pool("least_outstanding", fw, { maxQueue: 2 });
  const running = Array.from({ length: 6 }, () => p.route(q()));   // 4 slots + 2 queued
  await assert.rejects(p.route(q()), (e: EngineError) => e.kind === "overloaded" && e.status === 429);
  await Promise.all(running);
  assert.equal(p.counters.rejected, 1);
  await p.route(q());                                               // capacity is back
});

test("timeout covers queueing on a busy worker", async () => {
  const fw = fakeWorkers({ "http://w1": { ms: 100 } });
  const p = new EnginePool({
    urls: ["http://w1"], timeoutMs: 30, perWorkerConcurrency: 1, strategy: "round_robin", retryMax: 0, hedgeAfterMs: 0,
    maxQueue: -1, failThreshold: 5, healthIntervalMs: 0, call: fw.call, healthCall: fw.healthCall,
  });
  const a = p.route(q()).catch((e) => e);
  const b = p.route(q()).catch((e) => e);
  const [ea, eb] = await Promise.all([a, b]);
  for (const e of [ea, eb]) assert.ok(e instanceof EngineError && e.kind === "unavailable");
  assert.equal(p.snapshot().in_flight, 0);
});

test("health returns a reachable worker's config plus pool state", async () => {
  const fw = fakeWorkers({ "http://w1": { fail: true } });
  const p = pool("round_robin", fw);
  const h = await p.health();
  assert.deepEqual(h.config, { top_k: 50 });
  assert.equal((h.pool as any).workers.length, 4);
});
