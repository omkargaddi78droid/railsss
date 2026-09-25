// Small LRU + TTL cache for engine results, with in-flight request coalescing so concurrent identical
// queries trigger a single engine call. Keys include date, time and the engine configuration, so
// results are never reused across different dates, times or routing settings.

interface Entry<V> {
  value: V;
  expires: number;
}

export class RouteCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  hits = 0;
  misses = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly enabled: boolean;

  constructor(maxEntries: number, ttlSeconds: number, enabled = true) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlSeconds * 1000;
    this.enabled = enabled && maxEntries > 0;
  }

  static key(parts: { source: string; destination: string; date: string; time: string; configHash: string }): string {
    return `${parts.source}|${parts.destination}|${parts.date}|${parts.time}|${parts.configHash}`;
  }

  get size(): number {
    return this.map.size;
  }

  async getOrCompute(key: string, compute: () => Promise<V>): Promise<{ value: V; cached: boolean }> {
    if (this.enabled) {
      const e = this.map.get(key);
      if (e && e.expires > Date.now()) {
        this.map.delete(key); // refresh LRU position
        this.map.set(key, e);
        this.hits++;
        return { value: e.value, cached: true };
      }
      if (e) this.map.delete(key);
      const pending = this.inflight.get(key);
      if (pending) {
        this.hits++;
        return { value: await pending, cached: true };
      }
    }
    this.misses++;
    const p = compute();
    if (!this.enabled) return { value: await p, cached: false };
    this.inflight.set(key, p);
    try {
      const value = await p;
      this.map.set(key, { value, expires: Date.now() + this.ttlMs });
      while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value!);
      return { value, cached: false };
    } finally {
      this.inflight.delete(key);
    }
  }
}
