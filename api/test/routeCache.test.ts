import { test } from "node:test";
import assert from "node:assert/strict";
import { RouteCache } from "../src/services/routeCache.ts";
import { FakeRemote } from "./fakeRemote.ts";

const slowCounter = () => {
  let calls = 0;
  return { fn: () => new Promise<number>((r) => setTimeout(() => r(++calls), 20)), calls: () => calls };
};

test("a second process gets the value from the store; nothing is kept in process", async () => {
  const remote = new FakeRemote();
  const a = new RouteCache<number>(remote, 60);
  const b = new RouteCache<number>(remote, 60);
  const c = slowCounter();
  assert.equal((await a.getOrCompute("k", c.fn)).cached, false);
  const r = await b.getOrCompute("k", c.fn);
  assert.deepEqual([r.cached, r.value, c.calls(), b.remoteHits], [true, 1, 1, 1]);
  // the store holds compressed bytes, not JSON text
  assert.ok(Buffer.isBuffer(remote.data.get("k")));
  // a store wipe (Redis flush/restart) means a recompute: there is no local copy
  remote.data.clear();
  assert.equal((await a.getOrCompute("k", c.fn)).cached, false);
  assert.equal(c.calls(), 2);
});

test("round trip keeps the value; a per-call TTL overrides the default", async () => {
  const ttls: number[] = [];
  const remote = new FakeRemote();
  const set = remote.set.bind(remote);
  remote.set = async (k: string, v: Buffer, ttl?: number) => { ttls.push(ttl!); return set(k, v); };
  const cache = new RouteCache<{ routes: string[] }>(remote, 60);
  const v = { routes: Array.from({ length: 200 }, (_, i) => `route-${i}`) };
  await cache.getOrCompute("a", async () => v);
  await cache.getOrCompute("b", async () => v, 3600);
  assert.deepEqual((await cache.getOrCompute("a", async () => ({ routes: [] }))).value, v);
  assert.deepEqual(ttls, [60_000, 3_600_000]);
});

test("remote failures fail open", async () => {
  const remote = new FakeRemote();
  remote.down = true;
  const cache = new RouteCache<number>(remote, 60, { lockMs: 100 });
  const c = slowCounter();
  const r = await cache.getOrCompute("k", c.fn);
  assert.deepEqual([r.value, r.cached], [1, false]);
  assert.ok(cache.remoteErrors >= 2);
});

test("stampede: coalescing off computes per request; lock makes other processes wait for the value", async () => {
  const c1 = slowCounter();
  const off = new RouteCache<number>(new FakeRemote(), 60, { coalesce: false });
  await Promise.all(Array.from({ length: 5 }, () => off.getOrCompute("k", c1.fn)));
  assert.equal(c1.calls(), 5);

  const remote = new FakeRemote();
  const c2 = slowCounter();
  const procs = Array.from({ length: 4 }, () => new RouteCache<number>(remote, 60, { lockMs: 500 }));
  const rs = await Promise.all(procs.map((p) => p.getOrCompute("k", c2.fn)));
  assert.equal(c2.calls(), 1);
  assert.equal(rs.filter((r) => r.cached).length, 3);
  assert.equal(procs.reduce((n, p) => n + p.lockWaits, 0), 3);
});

test("no store (CACHE_BACKEND=none) computes every time", async () => {
  const c = slowCounter();
  const cache = new RouteCache<number>(null, 60);
  await cache.getOrCompute("k", c.fn);
  await cache.getOrCompute("k", c.fn);
  assert.equal(c.calls(), 2);
});
