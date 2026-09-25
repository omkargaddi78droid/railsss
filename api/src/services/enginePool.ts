// Dispatcher over many single-core routing engine workers (ENGINE_URLS).
//
// Each worker gets its own FIFO semaphore (per-worker concurrency, which also caps the keep-alive
// sockets per worker; see engineClient.ts). On top of that the pool adds the knobs the scaling study
// compares:
//   - LB_STRATEGY: round_robin | random | least_outstanding | p2c | consistent_hash
//   - RETRY_MAX: retry an "unavailable" failure on a different worker
//   - HEDGE_AFTER_MS: send a duplicate to a second worker if the first has not answered by then
//   - MAX_QUEUE: admission control; beyond capacity + MAX_QUEUE in-flight requests, reject with 429
//     ("auto", the default, queues up to one capacity: workers * concurrency; -1 = unlimited)
//   - health checks: FAIL_THRESHOLD consecutive failures eject a worker until /health passes again
import { createHash } from "node:crypto";
import { lookup, Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { EngineError, postRoute, Semaphore, type EngineQuery, type EngineResult, type RoutingEngine } from "./engineClient.ts";

export const LB_STRATEGIES = ["round_robin", "random", "least_outstanding", "p2c", "consistent_hash"] as const;
export type LbStrategy = (typeof LB_STRATEGIES)[number];

export type RouteCall = (baseUrl: string, q: EngineQuery, signal: AbortSignal) => Promise<EngineResult>;
export type HealthCall = (baseUrl: string, signal: AbortSignal) => Promise<Record<string, unknown>>;

export interface PoolOptions {
  urls: string[];
  timeoutMs: number;
  perWorkerConcurrency: number;
  strategy: LbStrategy;
  retryMax: number;         // extra attempts after the first (0 = no retry)
  hedgeAfterMs: number;     // 0 = off
  maxQueue: number | "auto"; // -1 = unlimited; "auto" = one capacity (tracks worker membership)
  failThreshold: number;    // consecutive failures before ejection
  healthIntervalMs: number; // 0 = no background health checks
  random?: () => number;
  call?: RouteCall;
  healthCall?: HealthCall;
}

interface Worker {
  url: string;
  slots: Semaphore;
  outstanding: number;      // queued on this worker's semaphore + running
  healthy: boolean;
  failures: number;         // consecutive
  requests: number;
  errors: number;
  totalMs: number;
}

export interface PoolCounters {
  retries: number;
  hedges: number;
  hedgeWins: number;
  rejected: number;
}

// Worker host names are resolved with c-ares (resolve4) rather than getaddrinfo. A stopped
// container's name takes ~5 s to fail in getaddrinfo, and health checks every HEALTH_INTERVAL_MS
// would fill libuv's 4-thread pool, which brotli and every other lookup share: all workers then
// time out and look unhealthy. The last good address is kept while resolution fails.
const resolver = new Resolver({ timeout: 1000, tries: 1 });
const lastAddress = new Map<string, string>();

async function resolveHost(host: string): Promise<string> {
  if (isIP(host)) return host;
  try {
    const [addr] = await resolver.resolve4(host);
    lastAddress.set(host, addr);
    return addr;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // names only in /etc/hosts (localhost) are unknown to DNS; getaddrinfo answers those at once
    if (code === "ENOTFOUND" || code === "ENODATA") {
      const { address } = await lookup(host);
      lastAddress.set(host, address);
      return address;
    }
    const cached = lastAddress.get(host);
    if (cached) return cached;
    throw e;
  }
}

// Health checks use a fresh connection that is closed after the reply (agent: false sends
// "Connection: close"): a kept-alive socket would park one of the engine's routing threads.
async function httpHealth(baseUrl: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const url = new URL(`${baseUrl}/health`);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const hostname = await resolveHost(url.hostname.replace(/^\[|\]$/g, ""));
  return new Promise((resolve, reject) => {
    const opts = { hostname, servername: url.hostname, headers: { host: url.host }, agent: false as const, signal };
    const req = request(url, opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`engine health HTTP ${res.statusCode}`));
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function hash32(s: string): number {
  return createHash("md5").update(s).digest().readUInt32BE(0);
}

const VNODES = 100;

export class EnginePool implements RoutingEngine {
  private readonly opts: Required<Omit<PoolOptions, "urls">>;
  private workers: Worker[] = [];
  private ring: { h: number; w: Worker }[] = [];
  private rr = 0;
  private inFlight = 0;
  private timer: NodeJS.Timeout | null = null;
  readonly counters: PoolCounters = { retries: 0, hedges: 0, hedgeWins: 0, rejected: 0 };

  constructor(options: PoolOptions) {
    const { urls, ...rest } = options;
    this.opts = { random: Math.random, call: postRoute, healthCall: httpHealth, ...rest };
    this.setWorkers(urls);
    if (this.opts.healthIntervalMs > 0) {
      this.timer = setInterval(() => void this.checkHealth(), this.opts.healthIntervalMs);
      this.timer.unref();
    }
  }

  // Replace the worker list, keeping state for workers that stay (dynamic join/leave).
  setWorkers(urls: string[]): void {
    const old = new Map(this.workers.map((w) => [w.url, w]));
    this.workers = [...new Set(urls.map((u) => u.replace(/\/$/, "")))].map(
      (url) =>
        old.get(url) ?? {
          url, slots: new Semaphore(this.opts.perWorkerConcurrency), outstanding: 0,
          healthy: true, failures: 0, requests: 0, errors: 0, totalMs: 0,
        },
    );
    this.ring = this.workers
      .flatMap((w) => Array.from({ length: VNODES }, (_, i) => ({ h: hash32(`${w.url}#${i}`), w })))
      .sort((a, b) => a.h - b.h);
  }

  get size(): number {
    return this.workers.length;
  }

  get urls(): string[] {
    return this.workers.map((w) => w.url);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  snapshot() {
    return {
      strategy: this.opts.strategy,
      in_flight: this.inFlight,
      ...this.counters,
      workers: this.workers.map((w) => ({
        url: w.url, healthy: w.healthy, outstanding: w.outstanding, requests: w.requests, errors: w.errors,
        avg_ms: w.requests ? Math.round((w.totalMs / w.requests) * 100) / 100 : 0,
      })),
    };
  }

  // Candidates: healthy workers not yet tried for this request; if none are healthy, fall back to
  // any untried worker (an ejected worker may have recovered before the next health check).
  private pick(q: EngineQuery, tried: Set<Worker>): Worker | null {
    let c = this.workers.filter((w) => w.healthy && !tried.has(w));
    if (!c.length) c = this.workers.filter((w) => !tried.has(w));
    if (!c.length) return null;
    const rnd = this.opts.random;
    switch (this.opts.strategy) {
      case "random":
        return c[Math.floor(rnd() * c.length)];
      case "least_outstanding": {
        // ties rotate, otherwise an idle pool would send everything to the first worker
        const min = Math.min(...c.map((w) => w.outstanding));
        const best = c.filter((w) => w.outstanding === min);
        return best[this.rr++ % best.length];
      }
      case "p2c": {
        const a = c[Math.floor(rnd() * c.length)];
        const b = c[Math.floor(rnd() * c.length)];
        return b.outstanding < a.outstanding ? b : a;
      }
      case "consistent_hash": {
        // Same (source, destination) always lands on the same worker while membership is stable.
        const h = hash32(`${q.source}|${q.destination}`);
        let lo = 0, hi = this.ring.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (this.ring[mid].h < h) lo = mid + 1; else hi = mid;
        }
        for (let i = 0; i < this.ring.length; i++) {
          const w = this.ring[(lo + i) % this.ring.length].w;
          if (c.includes(w)) return w;
        }
        return c[0];
      }
      default: {
        // round_robin over the full list, skipping non-candidates, so ejection does not shift the order
        for (let i = 0; i < this.workers.length; i++) {
          const w = this.workers[this.rr++ % this.workers.length];
          if (c.includes(w)) return w;
        }
        return c[0];
      }
    }
  }

  private async attempt(w: Worker, q: EngineQuery, signal: AbortSignal): Promise<EngineResult> {
    w.outstanding++;
    try {
      try {
        await w.slots.acquire(signal);
      } catch (e) {
        throw new EngineError(`routing engine busy: ${(e as Error).message}`, 503, "unavailable");
      }
      const t0 = performance.now();
      try {
        const r = await this.opts.call(w.url, q, signal);
        w.requests++;
        w.totalMs += performance.now() - t0;
        w.failures = 0;
        return r;
      } catch (e) {
        // A hedge loser aborted by us is not the worker's fault.
        if (!(signal.aborted && signal.reason?.name === "HedgeLost")) {
          w.errors++;
          if (e instanceof EngineError && e.kind === "unavailable" && ++w.failures >= this.opts.failThreshold) w.healthy = false;
        }
        throw e;
      } finally {
        w.slots.release();
      }
    } finally {
      w.outstanding--;
    }
  }

  // One logical try: the primary, plus a hedge on another worker if the primary is slow.
  private tryOnce(q: EngineQuery, tried: Set<Worker>, signal: AbortSignal): Promise<EngineResult> {
    const first = this.pick(q, tried);
    if (!first) return Promise.reject(new EngineError("no routing engine workers", 503, "unavailable"));
    tried.add(first);
    const hedgeMs = this.opts.hedgeAfterMs;
    if (hedgeMs <= 0) return this.attempt(first, q, signal);

    return new Promise((resolve, reject) => {
      const ctrls: AbortController[] = [];
      let pending = 0, settled = false;
      const launch = (w: Worker, isHedge: boolean) => {
        const ctrl = new AbortController();
        ctrls.push(ctrl);
        pending++;
        this.attempt(w, q, AbortSignal.any([signal, ctrl.signal])).then(
          (r) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (isHedge) this.counters.hedgeWins++;
            for (const c of ctrls) if (c !== ctrl) c.abort(Object.assign(new Error("hedge lost"), { name: "HedgeLost" }));
            resolve(r);
          },
          (e) => {
            // Fail only when nothing else is running; a primary that fails before the hedge timer
            // cancels the hedge and leaves the decision to the caller's retry loop.
            if (--pending > 0 || settled) return;
            settled = true;
            clearTimeout(timer);
            reject(e);
          },
        );
      };
      const timer = setTimeout(() => {
        if (settled) return;
        const second = this.pick(q, tried);
        if (!second) return;
        tried.add(second);
        this.counters.hedges++;
        launch(second, true);
      }, hedgeMs);
      launch(first, false);
    });
  }

  async route(q: EngineQuery): Promise<EngineResult> {
    const capacity = this.workers.length * this.opts.perWorkerConcurrency;
    const maxQueue = this.opts.maxQueue === "auto" ? capacity : this.opts.maxQueue;
    if (maxQueue >= 0 && this.inFlight >= capacity + maxQueue) {
      this.counters.rejected++;
      throw new EngineError("routing engine overloaded, retry later", 429, "overloaded");
    }
    this.inFlight++;
    // The timeout covers queueing, retries and hedges.
    const signal = AbortSignal.timeout(this.opts.timeoutMs);
    const tried = new Set<Worker>();
    try {
      for (let attemptNo = 0; ; attemptNo++) {
        try {
          return await this.tryOnce(q, tried, signal);
        } catch (e) {
          const retryable = e instanceof EngineError && e.kind === "unavailable" && !signal.aborted;
          if (!retryable || attemptNo >= this.opts.retryMax || tried.size >= this.workers.length) throw e;
          this.counters.retries++;
        }
      }
    } finally {
      this.inFlight--;
    }
  }

  async checkHealth(): Promise<void> {
    await Promise.all(
      this.workers.map(async (w) => {
        try {
          await this.opts.healthCall(w.url, AbortSignal.timeout(2000));
          if (!w.healthy) w.failures = 0;
          w.healthy = true;
        } catch {
          w.healthy = false;
        }
      }),
    );
  }

  // First reachable worker's health body (its routing config feeds the cache key) plus pool state.
  async health(): Promise<Record<string, unknown>> {
    let err: unknown = new Error("no routing engine workers");
    for (const w of [...this.workers].sort((a, b) => Number(b.healthy) - Number(a.healthy))) {
      try {
        const h = await this.opts.healthCall(w.url, AbortSignal.timeout(2000));
        return { ...h, pool: this.snapshot() };
      } catch (e) {
        err = e;
      }
    }
    throw err;
  }
}
