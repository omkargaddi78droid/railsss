// Prometheus metrics for the API process: HTTP latency, engine pool state (per worker) and cache
// counters. Served on METRICS_PORT, not the public port. Under NODE_CLUSTER the primary process
// serves the sum over its workers (prom-client AggregatorRegistry).
import client from "prom-client";
import type { EnginePool } from "./services/enginePool.ts";
import type { RouteCache } from "./services/routeCache.ts";

export function createMetrics(pool: EnginePool, cache: RouteCache<unknown>) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const http = new client.Histogram({
    name: "api_http_request_duration_seconds",
    help: "API request latency by route and status.",
    labelNames: ["method", "route", "status"],
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  // Values read at scrape time from the pool and cache objects.
  const gauge = (name: string, help: string, labelNames: string[], read: (g: client.Gauge) => void) =>
    new client.Gauge({ name, help, labelNames, registers: [registry], collect() { read(this); } });

  gauge("api_pool_in_flight", "Requests admitted to the engine pool and not finished.", [], (g) => g.set(pool.snapshot().in_flight));
  gauge("api_pool_events_total", "Pool events: retries, hedges, hedge wins, 429 rejections.", ["event"], (g) => {
    const c = pool.counters;
    g.set({ event: "retry" }, c.retries);
    g.set({ event: "hedge" }, c.hedges);
    g.set({ event: "hedge_win" }, c.hedgeWins);
    g.set({ event: "rejected" }, c.rejected);
  });
  gauge("api_worker_outstanding", "Requests queued or running on each engine worker.", ["worker"], (g) => {
    for (const w of pool.snapshot().workers) g.set({ worker: w.url }, w.outstanding);
  });
  gauge("api_worker_healthy", "1 if the worker is in rotation.", ["worker"], (g) => {
    for (const w of pool.snapshot().workers) g.set({ worker: w.url }, w.healthy ? 1 : 0);
  });
  gauge("api_worker_requests_total", "Successful engine calls per worker.", ["worker"], (g) => {
    for (const w of pool.snapshot().workers) g.set({ worker: w.url }, w.requests);
  });
  gauge("api_worker_errors_total", "Failed engine calls per worker.", ["worker"], (g) => {
    for (const w of pool.snapshot().workers) g.set({ worker: w.url }, w.errors);
  });
  gauge("api_cache_events_total", "Route cache lookups by outcome.", ["outcome"], (g) => {
    g.set({ outcome: "remote_hit" }, cache.remoteHits);
    g.set({ outcome: "coalesced" }, cache.coalesced);
    g.set({ outcome: "miss" }, cache.misses);
    g.set({ outcome: "lock_wait" }, cache.lockWaits);
    g.set({ outcome: "remote_error" }, cache.remoteErrors);
  });

  return {
    registry,
    observe(method: string, route: string, status: number, seconds: number) {
      http.observe({ method, route, status: String(status) }, seconds);
    },
  };
}
