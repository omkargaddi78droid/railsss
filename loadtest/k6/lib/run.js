// The per-iteration work shared by every scenario, plus the common options.
//
// Env: BASE_URL (default http://nginx), PAGE_SIZE (10), THINK_S (session pause between steps, 0),
//      TESTID (tag on every sample, so Grafana can pick one run out of the remote-write stream).
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { DATE, WORKLOAD, nextQuery, prefixFor } from "./queries.js";

const BASE = (__ENV.BASE_URL || "http://nginx").replace(/\/$/, "");
const PAGE_SIZE = Number(__ENV.PAGE_SIZE || 10);
const THINK_S = Number(__ENV.THINK_S || 0);
// accept-encoding: nginx compresses only when GZIP=on (E9); k6 decompresses by content-encoding
const HEADERS = { "content-type": "application/json", "accept-encoding": "gzip" };

// Server-reported timings and outcomes (from the response's meta), next to k6's own http_req_*.
const engineMs = new Trend("route_engine_ms");
const apiMs = new Trend("route_api_ms");
const routeLatency = new Trend("route_latency_ms", true); // client latency, tagged cached=true|false
const cacheHit = new Rate("route_cache_hit");
const searchComplete = new Rate("route_search_complete");
const withRoutes = new Rate("route_with_routes");
const overloaded = new Counter("route_overloaded");
const perWorker = new Counter("route_worker_requests"); // tagged worker=<WORKER_ID>

export function search(q, page = 1) {
  const body = JSON.stringify({ source: q.source, destination: q.destination, date: DATE, time: q.time, limit: PAGE_SIZE, page });
  const res = http.post(`${BASE}/api/routes`, body, { headers: HEADERS, tags: { name: page === 1 ? "search" : "search_page" } });
  if (res.status === 429) overloaded.add(1);
  const ok = check(res, { "search 200": (r) => r.status === 200 });
  if (!ok) return null;
  // gjson selector: pulls meta/pagination without building the whole (large) body as a JS object
  const meta = res.json("meta");
  const total = res.json("pagination.total_unfiltered");
  const cached = meta.cached === true;
  routeLatency.add(res.timings.duration, { cached: String(cached) });
  cacheHit.add(cached);
  if (!cached) {
    if (typeof meta.engine_ms === "number") engineMs.add(meta.engine_ms);
    if (meta.worker) perWorker.add(1, { worker: meta.worker });
  }
  apiMs.add(meta.api_ms);
  searchComplete.add(meta.search_complete === true);
  withRoutes.add(total > 0);
  return { total };
}

function autocomplete(code) {
  const res = http.get(`${BASE}/api/stations?q=${encodeURIComponent(prefixFor(code))}&limit=8`, { tags: { name: "stations" } });
  check(res, { "stations 200": (r) => r.status === 200 });
}

export function iteration() {
  if (WORKLOAD !== "session") {
    search(nextQuery());
    return;
  }
  const q = nextQuery();
  autocomplete(q.source);
  if (THINK_S) sleep(THINK_S);
  autocomplete(q.destination);
  if (THINK_S) sleep(THINK_S);
  const first = search(q, 1);
  if (first && first.total > PAGE_SIZE) {
    if (THINK_S) sleep(THINK_S);
    search(q, 2);
  }
}

// SLO from docs/scaling-plan.md: errors < 0.1 %, p99 < 500 ms. abort=true stops the run once broken
// (breakpoint tests), after a grace period so the warm-up does not trip it.
export function thresholds(abort = false) {
  const t = (threshold) => (abort ? { threshold, abortOnFail: true, delayAbortEval: "15s" } : threshold);
  return {
    http_req_failed: [t("rate<0.001")],
    http_req_duration: [t("p(99)<500")],
    checks: ["rate>0.999"],
  };
}

export const common = {
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "p(99.9)", "max"],
  tags: { testid: __ENV.TESTID || "adhoc", workload: WORKLOAD },
};

export const env = (name, def) => (__ENV[name] !== undefined && __ENV[name] !== "" ? __ENV[name] : def);
