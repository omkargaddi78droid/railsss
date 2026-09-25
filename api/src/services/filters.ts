// Presentation-level route filters. Each filter is a named predicate over an already computed route,
// so filtering never re-runs the routing engine. Add a filter by appending to FILTERS and to the
// request schema in routes/routes.ts.
import type { EngineRoute } from "./engineClient.ts";

export interface RouteFilterParams {
  max_duration_minutes?: number;
  max_transfers?: number;
  direct_only?: boolean;
}

interface FilterDef {
  id: keyof RouteFilterParams;
  active: (p: RouteFilterParams) => boolean;
  test: (r: EngineRoute, p: RouteFilterParams) => boolean;
}

export const FILTERS: FilterDef[] = [
  { id: "max_duration_minutes", active: (p) => p.max_duration_minutes !== undefined, test: (r, p) => r.duration_minutes <= p.max_duration_minutes! },
  { id: "max_transfers", active: (p) => p.max_transfers !== undefined, test: (r, p) => r.transfer_count <= p.max_transfers! },
  { id: "direct_only", active: (p) => p.direct_only === true, test: (r) => r.transfer_count === 0 },
];

export function applyFilters(routes: EngineRoute[], p: RouteFilterParams): { routes: EngineRoute[]; applied: RouteFilterParams } {
  const active = FILTERS.filter((f) => f.active(p));
  const applied: RouteFilterParams = {};
  for (const f of active) (applied as any)[f.id] = p[f.id];
  return { routes: routes.filter((r) => active.every((f) => f.test(r, p))), applied };
}
