// In-memory stand-in for Redis, shared by several RouteCache instances (= several API processes).
import type { RemoteStore } from "../src/services/routeCache.ts";

export class FakeRemote implements RemoteStore {
  data = new Map<string, Buffer>();
  locks = new Set<string>();
  down = false;
  async get(k: string) {
    if (this.down) throw new Error("down");
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: Buffer) {
    if (this.down) throw new Error("down");
    this.data.set(k, v);
    this.locks.delete(k);
  }
  async lock(k: string) {
    if (this.down) throw new Error("down");
    if (this.locks.has(k)) return false;
    this.locks.add(k);
    return true;
  }
}
