// HTTP client for the long-running C++ routing engine. Node's fetch (undici) keeps connections alive.
//
// The engine's HTTP server (cpp-httplib) dedicates one pool thread to each open connection until
// its keep-alive expires, so an idle kept-alive socket still occupies a thread. Capping in-flight
// requests here also caps the sockets undici opens, keeping them below ENGINE_THREADS; without the
// cap, a burst opens more sockets than threads and the extra requests stall for the keep-alive timeout.

export interface EngineQuery {
  source: string;
  destination: string;
  date: string;
  time: string;
  limit?: number;
}

export interface EngineStation { code: string | null; name: string }

export interface EngineStop extends EngineStation {
  arrival_datetime: string | null;
  departure_datetime: string | null;
  distance_km: number;
  boardable: boolean;
}

export interface EngineSegment {
  train_number: string;
  train_name: string;
  train_type: string;
  train_start_date: string;
  from_station: EngineStation;
  to_station: EngineStation;
  departure_datetime: string;
  arrival_datetime: string;
  duration_minutes: number;
  distance_km: number;
  stop_count: number;
  stops: EngineStop[];
}

export interface EngineTransfer {
  station: EngineStation;
  arrival_datetime: string;
  departure_datetime: string;
  wait_minutes: number;
}

export interface EngineRoute {
  rank: number;
  signature: string;
  departure_datetime: string;
  arrival_datetime: string;
  duration_minutes: number;
  elapsed_from_search_minutes: number;
  initial_wait_minutes: number;
  train_travel_minutes: number;
  waiting_minutes: number;
  transfer_count: number;
  segment_count: number;
  is_direct: boolean;
  distance_km: number;
  segments: EngineSegment[];
  transfers: EngineTransfer[];
}

export interface EngineResult {
  status: "ok" | "no_route";
  query: { source: string; destination: string; search_datetime: string };
  routes: EngineRoute[];
  stats: Record<string, number | boolean>;
  search_complete: boolean;
}

export class EngineError extends Error {
  readonly status: number;
  readonly kind: "invalid" | "unavailable";
  constructor(message: string, status: number, kind: "invalid" | "unavailable") {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

export interface RoutingEngine {
  route(q: EngineQuery): Promise<EngineResult>;
  health(): Promise<Record<string, unknown>>;
}

// FIFO counting semaphore. acquire() rejects if the signal aborts while still queued.
export class Semaphore {
  private free: number;
  private readonly waiters: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters.splice(this.waiters.indexOf(grant), 1);
        reject(signal.reason);
      };
      this.waiters.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

export class HttpRoutingEngine implements RoutingEngine {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly slots: Semaphore;
  constructor(baseUrl: string, timeoutMs: number, concurrency = 4) {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.slots = new Semaphore(concurrency);
  }

  async route(q: EngineQuery): Promise<EngineResult> {
    // The timeout covers time spent queued for a slot as well as the engine call itself.
    const signal = AbortSignal.timeout(this.timeoutMs);
    try {
      await this.slots.acquire(signal);
    } catch (e) {
      throw new EngineError(`routing engine busy: ${(e as Error).message}`, 503, "unavailable");
    }
    try {
      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/route`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(q),
          signal,
        });
      } catch (e) {
        throw new EngineError(`routing engine unreachable: ${(e as Error).message}`, 503, "unavailable");
      }
      const body = (await res.json().catch(() => null)) as any;
      if (res.status === 400) throw new EngineError(body?.error ?? "invalid query", 400, "invalid");
      if (!res.ok || !body) throw new EngineError(`routing engine error (HTTP ${res.status})`, 502, "unavailable");
      return body as EngineResult;
    } finally {
      this.slots.release();
    }
  }

  async health(): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`engine health HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
}
