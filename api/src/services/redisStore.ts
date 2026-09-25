// Redis-backed RemoteStore for the route cache and the dynamic worker registry.
// Commands are bounded by a short timeout so a slow or dead Redis degrades to cache misses
// instead of stalling requests (the cache fails open).
import { createClient, RESP_TYPES } from "redis";
import type { Logger } from "pino";
import type { RemoteStore } from "./routeCache.ts";

type Client = ReturnType<typeof createClient>;
// Same connection, but bulk strings come back as Buffers (the compressed cache values).
const binary = (c: Client) => c.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`redis timeout after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export class RedisStore implements RemoteStore {
  readonly client: Client;
  private readonly bin: ReturnType<typeof binary>;
  private readonly timeoutMs: number;
  private readonly prefix: string;

  constructor(url: string, logger: Logger, timeoutMs = 50, prefix = "route:") {
    this.timeoutMs = timeoutMs;
    this.prefix = prefix;
    // No offline queue: while disconnected, commands fail at once (fail open) instead of piling up.
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: (n) => Math.min(n * 100, 2000) },
    });
    this.bin = binary(this.client);
    let up = false;
    this.client.on("error", (e) => {
      if (up) logger.warn({ err: (e as Error).message }, "redis error");
      up = false;
    });
    this.client.on("ready", () => {
      up = true;
      logger.info("redis ready");
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  get ready(): boolean {
    return this.client.isReady;
  }

  async get(key: string): Promise<Buffer | null> {
    return withTimeout(this.bin.get(this.prefix + key), this.timeoutMs);
  }

  async set(key: string, value: Buffer, ttlMs: number): Promise<void> {
    const k = this.prefix + key;
    await withTimeout(this.client.multi().set(k, value, { PX: ttlMs }).del(`lock:${k}`).exec(), this.timeoutMs);
  }

  async lock(key: string, ttlMs: number): Promise<boolean> {
    const r = await withTimeout(this.client.set(`lock:${this.prefix}${key}`, "1", { NX: true, PX: ttlMs }), this.timeoutMs);
    return r === "OK";
  }

  // A named, expiring mutex (e.g. one cache prewarm per deployment), not on the request path, so it
  // gets a longer timeout. true if the caller holds it: newly set, or already set with the caller's
  // token (a retry after a SET whose reply timed out).
  async tryLock(name: string, token: string, ttlMs: number): Promise<boolean> {
    const k = `lock:${name}`;
    if ((await withTimeout(this.client.set(k, token, { NX: true, PX: ttlMs }), 2000)) === "OK") return true;
    return (await withTimeout(this.client.get(k), 2000)) === token;
  }

  async unlock(name: string, token: string): Promise<void> {
    const k = `lock:${name}`;
    if ((await withTimeout(this.client.get(k), 2000)) === token) await withTimeout(this.client.del(k), 2000);
  }

  // Worker registry: engine workers add themselves to a set (deploy scripts or a sidecar); the pool polls it.
  async members(setKey: string): Promise<string[]> {
    return withTimeout(this.client.sMembers(setKey), this.timeoutMs);
  }
}
