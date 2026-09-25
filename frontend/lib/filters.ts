// Client-side presentation filters over the fetched top 50. Each filter is a predicate registered
// here; the panel renders from FILTER_DEFAULTS and the list applies every active predicate.
// Adding a filter = add a field to FilterState + an entry to PREDICATES + a control in FilterPanel
// (+ a URL key in toParams/fromParams if it should be shareable).
import type { Journey } from "./types";

export const MAX_DURATION_LIMIT = 3000; // minutes (UI maximum per specification)

export type ViaMode = "only" | "must" | "avoid";
export type TimeWindow = "night" | "morning" | "afternoon" | "evening";

export const TIME_WINDOWS: { id: TimeWindow; label: string; range: string; from: number; to: number }[] = [
  { id: "night", label: "Night", range: "00–06", from: 0, to: 6 },
  { id: "morning", label: "Morning", range: "06–12", from: 6, to: 12 },
  { id: "afternoon", label: "Afternoon", range: "12–18", from: 12, to: 18 },
  { id: "evening", label: "Evening", range: "18–24", from: 18, to: 24 },
];

export interface FilterState {
  directOnly: boolean;
  maxTransfers: number | null; //     null = any
  maxDuration: number; //             minutes, MAX_DURATION_LIMIT = no restriction
  viaStations: string[]; //           transfer station codes; empty = inactive
  viaMode: ViaMode; //                only: every transfer is in the set; must: at least one is; avoid: none is
  trainTypes: string[]; //            allowed types on every leg; empty = any
  departWindows: TimeWindow[]; //     empty = any
  arriveWindows: TimeWindow[];
  minConnection: number | null; //   minutes; every transfer wait must be at least this
  maxLayover: number | null; //      minutes; no single transfer wait longer than this
  excludedTrains: string[]; //        train numbers that must not appear
}

export const FILTER_DEFAULTS: FilterState = {
  directOnly: false,
  maxTransfers: null,
  maxDuration: MAX_DURATION_LIMIT,
  viaStations: [],
  viaMode: "only",
  trainTypes: [],
  departWindows: [],
  arriveWindows: [],
  minConnection: null,
  maxLayover: null,
  excludedTrains: [],
};

const hourOf = (dt: string) => Number(dt.slice(11, 13));
const inWindows = (dt: string, ws: TimeWindow[]) => {
  const h = hourOf(dt);
  return TIME_WINDOWS.some((w) => ws.includes(w.id) && h >= w.from && h < w.to);
};

type Predicate = { id: keyof FilterState; active: (f: FilterState) => boolean; test: (j: Journey, f: FilterState) => boolean };

const PREDICATES: Predicate[] = [
  { id: "directOnly", active: (f) => f.directOnly, test: (j) => j.transfer_count === 0 },
  { id: "maxTransfers", active: (f) => f.maxTransfers !== null, test: (j, f) => j.transfer_count <= f.maxTransfers! },
  { id: "maxDuration", active: (f) => f.maxDuration < MAX_DURATION_LIMIT, test: (j, f) => j.duration_minutes <= f.maxDuration },
  {
    id: "viaStations",
    active: (f) => f.viaStations.length > 0,
    test: (j, f) => {
      const at = j.transfers.map((t) => t.station.code ?? "");
      if (f.viaMode === "only") return at.every((c) => f.viaStations.includes(c));
      if (f.viaMode === "must") return at.some((c) => f.viaStations.includes(c));
      return !at.some((c) => f.viaStations.includes(c));
    },
  },
  { id: "trainTypes", active: (f) => f.trainTypes.length > 0, test: (j, f) => j.segments.every((s) => f.trainTypes.includes(s.train_type)) },
  { id: "departWindows", active: (f) => f.departWindows.length > 0, test: (j, f) => inWindows(j.departure_datetime, f.departWindows) },
  { id: "arriveWindows", active: (f) => f.arriveWindows.length > 0, test: (j, f) => inWindows(j.arrival_datetime, f.arriveWindows) },
  { id: "minConnection", active: (f) => f.minConnection !== null, test: (j, f) => j.transfers.every((t) => t.wait_minutes >= f.minConnection!) },
  { id: "maxLayover", active: (f) => f.maxLayover !== null, test: (j, f) => j.transfers.every((t) => t.wait_minutes <= f.maxLayover!) },
  { id: "excludedTrains", active: (f) => f.excludedTrains.length > 0, test: (j, f) => !j.train_numbers.some((n) => f.excludedTrains.includes(n)) },
];

export function applyFilters(journeys: Journey[], f: FilterState): Journey[] {
  const active = PREDICATES.filter((p) => p.active(f));
  return journeys.filter((j) => active.every((p) => p.test(j, f)));
}

export function activeFilterCount(f: FilterState): number {
  return PREDICATES.filter((p) => p.active(f)).length;
}

// ---- options offered by the panel, derived from the current results ------------------------------

export interface FilterOptions {
  transferStations: { code: string; name: string; count: number }[];
  trainTypes: { type: string; count: number }[];
}

/** Every transfer station and train type present in the results, with the number of journeys using it. */
export function deriveOptions(journeys: Journey[]): FilterOptions {
  const stations = new Map<string, { code: string; name: string; count: number }>();
  const types = new Map<string, number>();
  for (const j of journeys) {
    for (const code of new Set(j.transfers.map((t) => t.station.code ?? ""))) {
      if (!code) continue;
      const name = j.transfers.find((t) => t.station.code === code)!.station.name;
      const e = stations.get(code) ?? stations.set(code, { code, name, count: 0 }).get(code)!;
      e.count++;
    }
    for (const t of new Set(j.segments.map((s) => s.train_type))) types.set(t, (types.get(t) ?? 0) + 1);
  }
  return {
    transferStations: [...stations.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    trainTypes: [...types.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

// ---- sorting (reorders the fetched journeys; never changes which journeys were found) ---------------------

export type SortKey = "arrival" | "duration" | "transfers" | "waiting" | "distance";

export const SORTS: { id: SortKey; label: string; key: (j: Journey) => number }[] = [
  { id: "arrival", label: "Earliest arrival", key: (j) => j.rank },
  { id: "duration", label: "Shortest trip", key: (j) => j.duration_minutes },
  { id: "transfers", label: "Fewest transfers", key: (j) => j.transfer_count },
  { id: "waiting", label: "Least waiting", key: (j) => j.waiting_minutes },
  { id: "distance", label: "Shortest distance", key: (j) => j.distance_km },
];

export function sortJourneys(journeys: Journey[], by: SortKey): Journey[] {
  const key = SORTS.find((s) => s.id === by)!.key;
  return [...journeys].sort((a, b) => key(a) - key(b) || a.rank - b.rank);
}

// ---- URL state -----------------------------------------------------------------------------------

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);
const num = (v: string | null) => (v && Number.isFinite(Number(v)) ? Number(v) : null);

export function filtersToParams(f: FilterState, sort: SortKey, p: URLSearchParams): void {
  const set = (k: string, v: string | null) => (v ? p.set(k, v) : p.delete(k));
  set("direct", f.directOnly ? "1" : null);
  set("maxtr", f.maxTransfers === null ? null : String(f.maxTransfers));
  set("maxdur", f.maxDuration < MAX_DURATION_LIMIT ? String(f.maxDuration) : null);
  set("via", f.viaStations.join(",") || null);
  set("vmode", f.viaStations.length && f.viaMode !== "only" ? f.viaMode : null);
  set("types", f.trainTypes.join(",") || null);
  set("dep", f.departWindows.join(",") || null);
  set("arr", f.arriveWindows.join(",") || null);
  set("minconn", f.minConnection === null ? null : String(f.minConnection));
  set("maxwait", f.maxLayover === null ? null : String(f.maxLayover));
  set("xtrain", f.excludedTrains.join(",") || null);
  set("sort", sort === "arrival" ? null : sort);
}

export function filtersFromParams(p: URLSearchParams): { filters: FilterState; sort: SortKey } {
  const windows = (v: string | null) => list(v).filter((w): w is TimeWindow => TIME_WINDOWS.some((t) => t.id === w));
  const vmode = p.get("vmode");
  const sort = p.get("sort");
  return {
    filters: {
      directOnly: p.get("direct") === "1",
      maxTransfers: num(p.get("maxtr")),
      maxDuration: num(p.get("maxdur")) ?? MAX_DURATION_LIMIT,
      viaStations: list(p.get("via")),
      viaMode: vmode === "must" || vmode === "avoid" ? vmode : "only",
      trainTypes: list(p.get("types")),
      departWindows: windows(p.get("dep")),
      arriveWindows: windows(p.get("arr")),
      minConnection: num(p.get("minconn")),
      maxLayover: num(p.get("maxwait")),
      excludedTrains: list(p.get("xtrain")),
    },
    sort: SORTS.some((s) => s.id === sort) ? (sort as SortKey) : "arrival",
  };
}
