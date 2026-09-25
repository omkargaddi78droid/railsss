// Load test for POST /api/routes using autocannon.
//
//   node bench/load.ts [--url http://localhost:8080] [--mode cold|cached] [--connections 10] [--duration 20] [--seed 1]
//
// cold:   every request is a distinct (source, destination, time) query, so the route cache never hits.
// cached: a small fixed set of queries, warmed once before measuring, so almost every request is a cache hit.
// Besides autocannon's throughput/latency, it aggregates the server-reported meta.engine_ms and
// meta.api_ms per response, which separates engine time from API overhead.
import autocannon from "autocannon";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    mode: { type: "string", default: "cold" },
    connections: { type: "string", default: "10" },
    duration: { type: "string", default: "20" },
    seed: { type: "string", default: "1" },
    date: { type: "string", default: "2026-09-25" },
    stations: { type: "string" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const stationsFile = args.stations ?? resolve(here, "../../data/processed/stations.json");
const codes: string[] = JSON.parse(readFileSync(stationsFile, "utf8")).map((s: { code: string }) => s.code);

let state = Number(args.seed) >>> 0 || 1;
function rand(n: number): number {
  // xorshift32: deterministic query sets across runs
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state % n;
}

function makeQuery() {
  let a = rand(codes.length), b = rand(codes.length);
  while (b === a) b = rand(codes.length);
  const hh = String(rand(24)).padStart(2, "0"), mm = String(rand(4) * 15).padStart(2, "0");
  return JSON.stringify({ source: codes[a], destination: codes[b], date: args.date, time: `${hh}:${mm}` });
}

const cold = args.mode === "cold";
const pool = Array.from({ length: cold ? 200_000 : 50 }, makeQuery);
const target = `${args.url.replace(/\/$/, "")}/api/routes`;
const headers = { "content-type": "application/json" };

if (!cold) {
  for (const body of pool) await fetch(target, { method: "POST", headers, body });
}

const engineMs: number[] = [], apiMs: number[] = [];
let withRoutes = 0, cachedHits = 0, incomplete = 0, parsed = 0;
let next = 0;

const instance = autocannon({
  url: target,
  connections: Number(args.connections),
  duration: Number(args.duration),
  requests: [{
    method: "POST",
    headers,
    setupRequest: (req) => ({ ...req, body: pool[next++ % pool.length] }),
    onResponse: (status, body) => {
      if (status !== 200) return;
      const r = JSON.parse(body);
      parsed++;
      if (r.routes.length) withRoutes++;
      if (r.meta.cached) cachedHits++;
      else engineMs.push(r.meta.engine_ms);
      if (!r.meta.search_complete) incomplete++;
      apiMs.push(r.meta.api_ms);
    },
  }],
});
autocannon.track(instance, { renderProgressBar: false });

instance.on("done", (res) => {
  const pct = (xs: number[], p: number) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((x, y) => x - y);
    return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2);
  };
  const row = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), max: pct(xs, 100) });
  console.log(JSON.stringify({
    mode: args.mode,
    url: target,
    connections: res.connections,
    duration_s: res.duration,
    requests: res.requests.total,
    rps_avg: res.requests.average,
    non2xx: res.non2xx,
    errors: res.errors,
    timeouts: res.timeouts,
    client_latency_ms: { p50: res.latency.p50, p90: res.latency.p90, p99: res.latency.p99, max: res.latency.max },
    server_engine_ms: row(engineMs),
    server_api_ms: row(apiMs),
    responses: { parsed, with_routes: withRoutes, cache_hits: cachedHits, search_incomplete: incomplete },
  }, null, 2));
});
