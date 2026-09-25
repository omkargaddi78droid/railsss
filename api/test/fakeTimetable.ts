// A tiny timetable for tests that render compact engine results: trains 0..3 run BD -> B -> NDLS
// daily, departing BD 10:05 and reaching NDLS 08:00 the next day. Train 4 has a placeholder stop.
import type { CompactJourney, EngineResult } from "../src/services/engineClient.ts";
import { JourneyRenderer } from "../src/services/journeyRenderer.ts";

const doc = {
  format: "railway-timetable/v1",
  stations: [
    { code: "BD", name: "BADNERA JN." },
    { code: "NDLS", name: "NEW DELHI" },
    { code: "B", name: "BHOPAL SOMETHING" },
  ],
  trains: [
    ...Array.from({ length: 4 }, (_, i) => ({
      number: String(10000 + i), name: `${10000 + i} EXP`, type: "SUPERFAST", days: 127,
      stops: [[0, -1, 605, 0], [2, 900, 905, 300.5], [1, 1920, -1, 700.25]],
    })),
    { number: "20000", days: 127, stops: [[0, -1, 60, 0], [-1, 120, 121, 50], [1, 200, -1, 90]] },
    { number: "NEVER", days: 0, stops: [[0, -1, 60, 0], [1, 200, -1, 90]] },
  ],
};

export const TIMETABLE_BYTES = new TextEncoder().encode(JSON.stringify(doc));
export const renderer = new JourneyRenderer(TIMETABLE_BYTES);

const DAY = 20721; // 2026-09-25

// A journey of `transfers + 1` legs on trains 0.. (the legs need not connect; only the renderer reads them).
export function journey(rank: number, transfers: number, duration: number): CompactJourney {
  const dep = DAY * 1440 + 605;
  return {
    signature: `sig${rank}`, dep, arr: dep + duration, transfers, train_minutes: duration - 60, waiting_minutes: 60,
    legs: Array.from({ length: transfers + 1 }, (_, i) => [i % 4, 0, 2, DAY] as [number, number, number, number]),
  };
}

export function result(journeys: CompactJourney[], extra: Partial<EngineResult> = {}): EngineResult {
  return {
    status: journeys.length ? "ok" : "no_route", search_complete: true, timetable: renderer.hash,
    search_minute: DAY * 1440 + 600, stats: { total_ms: 4.2 }, journeys, ...extra,
  };
}
