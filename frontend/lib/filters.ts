// Client-side presentation filters over the fetched top-20. Each filter is a predicate registered
// here; the panel renders from FILTER_DEFAULTS and the list applies every active predicate.
// Adding a filter = add a field to FilterState + an entry to PREDICATES + a control in FilterPanel.
import type { Journey } from "./types";

export const MAX_DURATION_LIMIT = 3000; // minutes (UI maximum per specification)

export interface FilterState {
  directOnly: boolean;
  maxTransfers: number | null;      // null = any
  maxDuration: number;              // minutes, MAX_DURATION_LIMIT = no restriction
}

export const FILTER_DEFAULTS: FilterState = { directOnly: false, maxTransfers: null, maxDuration: MAX_DURATION_LIMIT };

const PREDICATES: { id: keyof FilterState; active: (f: FilterState) => boolean; test: (j: Journey, f: FilterState) => boolean }[] = [
  { id: "directOnly", active: (f) => f.directOnly, test: (j) => j.transfer_count === 0 },
  { id: "maxTransfers", active: (f) => f.maxTransfers !== null, test: (j, f) => j.transfer_count <= f.maxTransfers! },
  { id: "maxDuration", active: (f) => f.maxDuration < MAX_DURATION_LIMIT, test: (j, f) => j.duration_minutes <= f.maxDuration },
];

export function applyFilters(journeys: Journey[], f: FilterState): Journey[] {
  const active = PREDICATES.filter((p) => p.active(f));
  return journeys.filter((j) => active.every((p) => p.test(j, f)));
}

export function activeFilterCount(f: FilterState): number {
  return PREDICATES.filter((p) => p.active(f)).length;
}
