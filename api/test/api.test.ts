import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";
import { EngineError, Semaphore, type EngineQuery, type EngineResult, type RoutingEngine } from "../src/services/engineClient.ts";
import { RouteCache } from "../src/services/routeCache.ts";
import { RouteService, NO_ROUTE_MESSAGE } from "../src/services/routeService.ts";
import { StationService } from "../src/services/stationService.ts";
import { FakeRemote } from "./fakeRemote.ts";
import { journey, renderer, result } from "./fakeTimetable.ts";

const STATIONS = [
  { code: "BD", name: "BADNERA JN.", all_known_names: ["BADNERA JN."], train_count: 47 },
  { code: "BSL", name: "BHUSAVAL JN", all_known_names: ["BHUSAVAL JN"], train_count: 151 },
  { code: "NDLS", name: "NEW DELHI", all_known_names: ["NEW DELHI"], train_count: 118 },
  { code: "NK", name: "NASIK ROAD", all_known_names: ["NASIK ROAD"], train_count: 90 },
  { code: "SWM", name: "SAWAI MADHOPUR JN", all_known_names: ["SAWAI MADHOPUR", "SAWAI MADHOPUR JN"], train_count: 68 },
  { code: "B", name: "BHOPAL SOMETHING", all_known_names: [], train_count: 1 },
];

class FakeEngine implements RoutingEngine {
  calls: EngineQuery[] = [];
  mode: "ok" | "empty" | "down" = "ok";
  async route(q: EngineQuery): Promise<EngineResult> {
    this.calls.push(q);
    if (this.mode === "down") throw new EngineError("routing engine unreachable", 503, "unavailable");
    return result(this.mode === "empty" ? [] : Array.from({ length: 20 }, (_, i) => journey(i + 1, i % 4, 1000 + i * 150)));
  }
  async health() {
    if (this.mode === "down") throw new Error("down");
    return { status: "ok", timetable: renderer.hash, config: { min_transfer_minutes: 30 } };
  }
}

function setup(cacheEnabled = true) {
  const engine = new FakeEngine();
  const stations = new StationService(STATIONS, "test");
  const routes = new RouteService(engine, stations, new RouteCache<EngineResult>(cacheEnabled ? new FakeRemote() : null, 60), renderer, 20);
  const app = createApp({ logger: createLogger("silent"), stations, routes, engine, maxResults: 20, maxDurationFilterMinutes: 3000 });
  return { app, engine };
}

const body = { source: "BD", destination: "NDLS", date: "2026-09-25", time: "10:00" };

test("POST /api/routes returns ranked routes with pagination", async () => {
  const { app } = setup();
  const res = await request(app).post("/api/routes").send({ ...body, limit: 20 });
  assert.equal(res.status, 200);
  assert.equal(res.body.routes.length, 20);
  assert.equal(res.body.routes[0].rank, 1);
  assert.equal(res.body.pagination.returned, 20);
  assert.equal(res.body.query.source_name, "BADNERA JN.");
  assert.ok(res.headers["x-request-id"]);
});

test("limit above 20 is rejected, page slices the top 20", async () => {
  const { app } = setup();
  const bad = await request(app).post("/api/routes").send({ ...body, limit: 21 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, "VALIDATION_ERROR");
  const p2 = await request(app).post("/api/routes").send({ ...body, limit: 8, page: 3 });
  assert.equal(p2.status, 200);
  assert.deepEqual(p2.body.routes.map((r: any) => r.rank), [17, 18, 19, 20]);
  assert.equal(p2.body.pagination.total_pages, 3);
});

test("engine always asked for the full top 20; filters and pages reuse the cached result", async () => {
  const { app, engine } = setup();
  await request(app).post("/api/routes").send({ ...body, limit: 5 });
  await request(app).post("/api/routes").send({ ...body, limit: 5, page: 2 });
  const f = await request(app).post("/api/routes").send({ ...body, filters: { direct_only: true } });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].limit, 20);
  assert.ok(f.body.routes.every((r: any) => r.transfer_count === 0));
  assert.equal(f.body.meta.cached, true);
  // a different time is a different cache key
  await request(app).post("/api/routes").send({ ...body, time: "10:01" });
  assert.equal(engine.calls.length, 2);
});

test("filters: max transfers and max duration (<= 3000)", async () => {
  const { app } = setup();
  const r = await request(app).post("/api/routes").send({ ...body, filters: { max_transfers: 1, max_duration_minutes: 2000 } });
  assert.equal(r.status, 200);
  assert.ok(r.body.routes.length > 0);
  assert.ok(r.body.routes.every((x: any) => x.transfer_count <= 1 && x.duration_minutes <= 2000));
  assert.deepEqual(r.body.filters_applied, { max_duration_minutes: 2000, max_transfers: 1 });
  const bad = await request(app).post("/api/routes").send({ ...body, filters: { max_duration_minutes: 3001 } });
  assert.equal(bad.status, 400);
});

test("validation errors are distinct from no-route results", async () => {
  const { app, engine } = setup();
  for (const b of [
    { ...body, destination: "BD" },
    { ...body, source: "XXXX" },
    { ...body, date: "2026-02-30" },
    { ...body, time: "25:00" },
    { ...body, extra: 1 },
    { source: "BD" },
  ]) {
    const r = await request(app).post("/api/routes").send(b);
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.ok(r.body.error.code);
  }
  const malformed = await request(app).post("/api/routes").set("content-type", "application/json").send("{bad");
  assert.equal(malformed.status, 400);
  engine.mode = "empty";
  const none = await request(app).post("/api/routes").send(body);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.routes, []);
  assert.equal(none.body.message, NO_ROUTE_MESSAGE);
});

test("lower-case codes are normalized", async () => {
  const { app, engine } = setup();
  const r = await request(app).post("/api/routes").send({ ...body, source: "bd", destination: " ndls " });
  assert.equal(r.status, 200);
  assert.equal(engine.calls[0].source, "BD");
  assert.equal(engine.calls[0].destination, "NDLS");
});

test("engine outage is a 503, health reports unhealthy", async () => {
  const { app, engine } = setup(false);
  engine.mode = "down";
  const r = await request(app).post("/api/routes").send(body);
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "ENGINE_UNAVAILABLE");
  const h = await request(app).get("/health");
  assert.equal(h.status, 503);
  assert.equal(h.body.status, "unhealthy");
  engine.mode = "ok";
  const ok = await request(app).get("/health");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, "healthy");
});

test("station prefix search ranks exact code, code prefix, then name prefix", async () => {
  const { app } = setup();
  const r = await request(app).get("/api/stations").query({ q: "b" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.stations.map((s: any) => s.code), ["B", "BSL", "BD"]);
  assert.equal(r.body.stations[1].label, "BHUSAVAL JN (BSL)");
  const byName = await request(app).get("/api/stations").query({ q: "nasik" });
  assert.deepEqual(byName.body.stations.map((s: any) => s.code), ["NK"]);
  const variant = await request(app).get("/api/stations").query({ q: "SAWAI MADHOPUR" });
  assert.equal(variant.body.stations[0].code, "SWM");
  const one = await request(app).get("/api/stations/ndls");
  assert.equal(one.body.label, "NEW DELHI (NDLS)");
  assert.equal((await request(app).get("/api/stations/NOPE")).status, 404);
});

test("cache: in-flight coalescing", async () => {
  const c = new RouteCache<number>(new FakeRemote(), 60);
  let calls = 0;
  const slow = () => new Promise<number>((r) => setTimeout(() => r(++calls), 10));
  const [a, b] = await Promise.all([c.getOrCompute("k", slow), c.getOrCompute("k", slow)]);
  assert.equal(calls, 1);
  assert.equal(a.value, b.value);
  assert.equal(c.coalesced, 1);
});

test("Semaphore caps concurrency, grants FIFO and drops aborted waiters", async () => {
  const sem = new Semaphore(2);
  const never = new AbortController().signal;
  await sem.acquire(never);
  await sem.acquire(never);
  const order: string[] = [];
  const ac = new AbortController();
  const a = sem.acquire(never).then(() => order.push("a"));
  const b = sem.acquire(ac.signal).then(() => order.push("b"), () => order.push("b-aborted"));
  const c = sem.acquire(never).then(() => order.push("c"));
  ac.abort();
  await b;
  sem.release();
  sem.release();
  await Promise.all([a, c]);
  assert.deepEqual(order, ["b-aborted", "a", "c"]);
});
