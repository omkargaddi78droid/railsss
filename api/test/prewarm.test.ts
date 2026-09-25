import { test } from "node:test";
import assert from "node:assert/strict";
import { busiestPairs, planPrewarm, runPrewarm } from "../src/services/prewarm.ts";
import type { EngineQuery, EngineResult, RoutingEngine } from "../src/services/engineClient.ts";
import { RouteCache } from "../src/services/routeCache.ts";
import { RouteService } from "../src/services/routeService.ts";
import { StationService } from "../src/services/stationService.ts";
import { FakeRemote } from "./fakeRemote.ts";

const STATIONS = [
  { code: "A", name: "A", all_known_names: [], train_count: 100 },
  { code: "B", name: "B", all_known_names: [], train_count: 50 },
  { code: "C", name: "C", all_known_names: [], train_count: 10 },
  { code: "D", name: "D", all_known_names: [], train_count: 1 },
];

test("busiest pairs are ranked by the product of train counts", () => {
  assert.deepEqual(busiestPairs(STATIONS, 4), [["A", "B"], ["B", "A"], ["A", "C"], ["C", "A"]]);
  assert.deepEqual(busiestPairs(STATIONS, 0), []);
});

test("plan: today starts at the current hour in the time zone, then following days; extras deduplicated", () => {
  // 2026-09-25 20:10 UTC = 2026-09-26 01:40 in Asia/Kolkata
  const now = new Date("2026-09-25T20:10:00Z");
  const plan = planPrewarm(STATIONS, {
    pairs: 1, times: "hourly", days: 2, tz: "Asia/Kolkata",
    extra: [{ source: "A", destination: "B", time: "03:00" }, { source: "C", destination: "D", time: "07:15" }],
  }, now);
  assert.deepEqual(plan[0], { source: "A", destination: "B", date: "2026-09-26", time: "01:00" });
  assert.equal(plan[23].time, "00:00"); // wrapped around
  assert.equal(plan[24].time, "07:15"); // extra; the A>B 03:00 extra was already in the plan
  assert.deepEqual(plan[25], { source: "A", destination: "B", date: "2026-09-27", time: "00:00" });
  assert.equal(plan.length, 2 * 25);
});

test("plan: explicit times keep their order after the rotation", () => {
  const plan = planPrewarm(STATIONS, { pairs: 2, times: ["08:00", "18:00"], days: 1, tz: "UTC" }, new Date("2026-09-25T12:00:00Z"));
  assert.deepEqual(plan.map((q) => `${q.time} ${q.source}>${q.destination}`), ["18:00 A>B", "18:00 B>A", "08:00 A>B", "08:00 B>A"]);
});

class CountingEngine implements RoutingEngine {
  calls: EngineQuery[] = [];
  failOn = "";
  async route(q: EngineQuery): Promise<EngineResult> {
    this.calls.push(q);
    if (q.source === this.failOn) throw new Error("engine down");
    return { status: "ok", query: { source: q.source, destination: q.destination, search_datetime: `${q.date}T${q.time}:00` }, routes: [], stats: {}, search_complete: true };
  }
  async health() { return { status: "ok" }; }
}

test("prewarm fills the shared cache; a restart finds everything cached; a live search is then a hit", async () => {
  const remote = new FakeRemote();
  const engine = new CountingEngine();
  const stations = new StationService(STATIONS, "test");
  const routes = new RouteService(engine, stations, new RouteCache<EngineResult>(remote, 60), 20);
  const plan = planPrewarm(STATIONS, { pairs: 3, times: ["09:00", "10:00"], days: 1, tz: "UTC" }, new Date("2026-09-25T08:00:00Z"));

  const first = await runPrewarm(plan, (q) => routes.warm(q), 2);
  assert.deepEqual([first.total, first.computed, first.already_cached, first.failed], [6, 6, 0, 0]);
  assert.equal(engine.calls.length, 6);
  assert.equal(engine.calls[0].limit, 20); // same full top-N as a live search, so the key is shared

  // new API process (restart): same store, nothing recomputed
  const restarted = new RouteService(engine, stations, new RouteCache<EngineResult>(remote, 60), 20);
  const second = await runPrewarm(plan, (q) => restarted.warm(q), 2);
  assert.deepEqual([second.computed, second.already_cached], [0, 6]);

  const live = await restarted.search({ source: "A", destination: "B", date: "2026-09-25", time: "09:00", limit: 10, page: 1, filters: {} });
  assert.equal(live.meta.cached, true);
  assert.equal(engine.calls.length, 6);
});

test("prewarm counts failures and carries on", async () => {
  const engine = new CountingEngine();
  engine.failOn = "B";
  const routes = new RouteService(engine, new StationService(STATIONS, "test"), new RouteCache<EngineResult>(new FakeRemote(), 60), 20);
  const plan = planPrewarm(STATIONS, { pairs: 4, times: ["09:00"], days: 1, tz: "UTC" }, new Date("2026-09-25T08:00:00Z"));
  const s = await runPrewarm(plan, (q) => routes.warm(q), 1);
  assert.deepEqual([s.computed, s.failed], [3, 1]);
});
