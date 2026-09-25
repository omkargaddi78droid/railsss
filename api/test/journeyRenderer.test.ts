import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fnv1a64Hex, formatDate, formatDatetime, JourneyRenderer } from "../src/services/journeyRenderer.ts";
import { RouteCache } from "../src/services/routeCache.ts";
import { engineIdentity, RouteService } from "../src/services/routeService.ts";
import { StationService } from "../src/services/stationService.ts";
import type { EngineQuery, EngineResult, RoutingEngine } from "../src/services/engineClient.ts";
import { FakeRemote } from "./fakeRemote.ts";
import { journey, renderer, result } from "./fakeTimetable.ts";

const enc = (s: string) => new TextEncoder().encode(s);

test("FNV-1a 64 matches the engine's reference values", () => {
  assert.equal(fnv1a64Hex(enc("")), "cbf29ce484222325");
  assert.equal(fnv1a64Hex(enc("a")), "af63dc4c8601ec8c");
  assert.equal(fnv1a64Hex(enc("foobar")), "85944171f73967e8");
  assert.equal(fnv1a64Hex(new Uint8Array([0xff, 0x80, 0x00, 0x7f])), fnv1a64Hex(new Uint8Array([0xff, 0x80, 0x00, 0x7f])));
});

test("datetimes: absolute minutes in naive local time", () => {
  assert.equal(formatDatetime(20721 * 1440 + 605), "2026-09-25T10:05:00");
  assert.equal(formatDatetime(20721 * 1440 + 1440 + 15), "2026-09-26T00:15:00");
  assert.equal(formatDate(20721), "2026-09-25");
});

test("render: names, stops, transfers, placeholders; never-running trains are skipped", () => {
  const day = 20721;
  const r = renderer.render(
    { signature: "s", dep: day * 1440 + 60, arr: day * 1440 + 1920, transfers: 1, train_minutes: 1000, waiting_minutes: 40, legs: [[4, 0, 2, day], [1, 1, 2, day]] },
    3,
    day * 1440,
  );
  assert.equal(r.rank, 3);
  assert.equal(r.initial_wait_minutes, 60);
  assert.equal(r.segments[0].train_name, "20000");         // name defaults to the number
  assert.equal(r.segments[0].train_type, "UNKNOWN");
  assert.deepEqual(r.segments[0].stops[1], {
    code: null, name: "UNNAMED POINT", arrival_datetime: "2026-09-25T02:00:00", departure_datetime: "2026-09-25T02:01:00", distance_km: 50, boardable: false,
  });
  assert.equal(r.segments[0].stops[0].arrival_datetime, null);
  assert.equal(r.segments[0].stops[2].departure_datetime, null);
  assert.deepEqual(r.transfers[0], {
    station: { code: "NDLS", name: "NEW DELHI" }, arrival_datetime: "2026-09-25T03:20:00", departure_datetime: "2026-09-25T15:05:00", wait_minutes: 705,
  });
  assert.equal(r.segments[1].from_station.code, "B");
  assert.equal(r.distance_km, 90 + Math.fround(700.25 - 300.5));
  assert.throws(() => renderer.render({ ...journey(1, 0, 10), legs: [[5, 0, 1, day]] }, 1, 0), /does not match/);
});

test("results from another timetable are refused", () => {
  assert.throws(() => renderer.check("0000000000000000"), /timetable mismatch/);
  renderer.check(renderer.hash);
});

class CountingEngine implements RoutingEngine {
  calls: EngineQuery[] = [];
  async route(q: EngineQuery): Promise<EngineResult> {
    this.calls.push(q);
    return result(Array.from({ length: 20 }, (_, i) => journey(i + 1, i % 4, 1000 + i * 150)));
  }
  async health() { return { status: "ok", timetable: renderer.hash, config: { top_k: 50 } }; }
}

test("search renders only the returned page; the cache key includes the timetable hash", async () => {
  const remote = new FakeRemote();
  const engine = new CountingEngine();
  const routes = new RouteService(engine, new StationService([
    { code: "BD", name: "BADNERA JN.", all_known_names: [], train_count: 1 },
    { code: "NDLS", name: "NEW DELHI", all_known_names: [], train_count: 1 },
  ], "test"), new RouteCache<EngineResult>(remote, 60), renderer, 20);
  let rendered = 0;
  const orig = renderer.render.bind(renderer);
  renderer.render = (...a) => (rendered++, orig(...a));
  try {
    routes.configHash = engineIdentity(await engine.health());
    const q = { source: "BD", destination: "NDLS", date: "2026-09-25", time: "10:00", limit: 5, page: 2, filters: { max_transfers: 1 } };
    const r = await routes.search(q);
    assert.equal(rendered, 5);
    assert.deepEqual(r.routes.map((x) => x.rank), [10, 13, 14, 17, 18]);
    assert.equal(r.pagination.total_available, 10);
    assert.equal(r.query.search_datetime, "2026-09-25T10:00:00");
    // a different timetable is a different key
    routes.configHash = engineIdentity({ ...(await engine.health()), timetable: "other" });
    await routes.search(q);
    assert.equal(engine.calls.length, 2);
  } finally {
    renderer.render = orig;
  }
});

// Captured from the engine's former fully rendered output ({"format":"full"}, removed after this
// migration) for 15 verify + 10 heavy queries of loadtest/data/queries.json.
const TIMETABLE = new URL("../../data/processed/timetable.json", import.meta.url);
const FIXTURE = new URL("./fixtures/render-parity.json.gz", import.meta.url);

test("parity: render(compact) equals the engine's former full output", (t) => {
  if (!existsSync(TIMETABLE)) return t.skip("data/processed/timetable.json not found (run scripts/preprocess.ts)");
  const real = new JourneyRenderer(readFileSync(TIMETABLE));
  const fx = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString());
  if (fx.timetable !== real.hash) return t.skip(`fixture was captured for timetable ${fx.timetable}, local one is ${real.hash}`);
  let routes = 0;
  for (const c of fx.cases) {
    const rendered = c.compact.journeys.map((j: any, i: number) => real.render(j, i + 1, c.compact.search_minute));
    assert.deepStrictEqual(rendered, c.full_routes, `${c.query.source}>${c.query.destination} ${c.query.time}`);
    assert.equal(formatDatetime(c.compact.search_minute), c.search_datetime);
    routes += rendered.length;
  }
  assert.ok(routes > 500);
});
