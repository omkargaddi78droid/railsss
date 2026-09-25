// Route result cache, stored only in a shared remote store (Redis). Nothing is kept in process memory:
// every API process and gateway instance sees the same entries, and a restart loses nothing.
//   - Values are JSON, brotli-compressed (quality 4: a ~270 KB engine result becomes ~8 KB), and
//     (de)compressed on libuv's thread pool, off the event loop.
//   - Concurrent identical queries in one process share a single computation (in-flight coalescing;
//     this holds only the pending promise, never a result).
//   - Across processes, an optional remote lock (REDIS_LOCK_MS) makes other processes wait briefly for
//     the winner's value instead of recomputing (stampede protection).
//   - Remote failures fail open: they count as misses and never fail the request.
// Keys include date, time and the engine configuration, so results are never reused across different
// dates, times or routing settings. Without a store the cache is off and every search computes.
import { promisify } from "node:util";
import { brotliCompress, brotliDecompress, constants } from "node:zlib";

const compress = promisify(brotliCompress);
const decompress = promisify(brotliDecompress);
const BROTLI = { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } };

export interface RemoteStore {
  get(key: string): Promise<Buffer | null>;
  set(key: string, value: Buffer, ttlMs: number): Promise<void>;
  // true if this caller now holds the lock for key (released by expiry or by set of the value)
  lock(key: string, ttlMs: number): Promise<boolean>;
}

export interface CacheOptions {
  coalesce?: boolean;   // default true
  lockMs?: number;      // 0 = no cross-process lock
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RouteCache<V> {
  private readonly inflight = new Map<string, Promise<V>>();
  hits = 0;
  misses = 0;
  remoteHits = 0;
  coalesced = 0;
  lockWaits = 0;
  remoteErrors = 0;
  readonly ttlMs: number;
  private readonly remote: RemoteStore | null;
  private readonly coalesce: boolean;
  private readonly lockMs: number;

  constructor(remote: RemoteStore | null, ttlSeconds: number, opts: CacheOptions = {}) {
    this.remote = remote;
    this.ttlMs = ttlSeconds * 1000;
    this.coalesce = opts.coalesce ?? true;
    this.lockMs = opts.lockMs ?? 0;
  }

  get enabled(): boolean {
    return this.remote !== null;
  }

  static key(parts: { source: string; destination: string; date: string; time: string; configHash: string }): string {
    return `${parts.source}|${parts.destination}|${parts.date}|${parts.time}|${parts.configHash}`;
  }

  private async getRemote(key: string): Promise<V | undefined> {
    try {
      const b = await this.remote!.get(key);
      return b === null ? undefined : (JSON.parse((await decompress(b)).toString("utf8")) as V);
    } catch {
      this.remoteErrors++;
      return undefined;
    }
  }

  private async setRemote(key: string, value: V, ttlMs: number): Promise<void> {
    try {
      await this.remote!.set(key, await compress(JSON.stringify(value), BROTLI), ttlMs);
    } catch {
      this.remoteErrors++;
    }
  }

  // Remote lookup, then (optionally) the cross-process lock, then the computation.
  private async load(key: string, compute: () => Promise<V>, ttlMs: number): Promise<{ value: V; cached: boolean }> {
    const v = await this.getRemote(key);
    if (v !== undefined) {
      this.remoteHits++;
      return { value: v, cached: true };
    }
    if (this.lockMs > 0) {
      let mine = true;
      try {
        mine = await this.remote!.lock(key, this.lockMs);
      } catch {
        this.remoteErrors++;
      }
      if (!mine) {
        // Another process is computing this key: poll for its value until the lock would expire.
        this.lockWaits++;
        for (let waited = 0; waited < this.lockMs; waited += 10) {
          await sleep(10);
          const w = await this.getRemote(key);
          if (w !== undefined) {
            this.remoteHits++;
            return { value: w, cached: true };
          }
        }
      }
    }
    const value = await compute();
    await this.setRemote(key, value, ttlMs);
    return { value, cached: false };
  }

  // ttlSeconds overrides the default TTL for a value computed by this call (prewarmed entries live longer).
  async getOrCompute(key: string, compute: () => Promise<V>, ttlSeconds?: number): Promise<{ value: V; cached: boolean }> {
    if (!this.remote) {
      this.misses++;
      return { value: await compute(), cached: false };
    }
    if (this.coalesce) {
      const pending = this.inflight.get(key);
      if (pending) {
        this.hits++;
        this.coalesced++;
        return { value: await pending, cached: true };
      }
    }
    const p = this.load(key, compute, ttlSeconds !== undefined ? ttlSeconds * 1000 : this.ttlMs);
    if (this.coalesce) {
      const shared = p.then((r) => r.value);
      shared.catch(() => {}); // failures reach the waiters; do not leave an unhandled rejection
      this.inflight.set(key, shared);
    }
    try {
      const r = await p;
      if (r.cached) this.hits++;
      else this.misses++;
      return r;
    } finally {
      if (this.coalesce) this.inflight.delete(key);
    }
  }
}
