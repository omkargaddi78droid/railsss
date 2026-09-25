// Presentation-level route filters. Each filter is a named predicate over an already computed route,
// so filtering never re-runs the routing engine. Add a filter by appending to FILTERS and to the
// request schema in routes/routes.ts.

// The fields filters may look at. Filters run on the compact engine journeys before rendering, so a
// new filter that needs more than this must add the field in routeService.ts.
export interface FilterableRoute {
  duration_minutes: number;
  transfer_count: number;
}

export interface RouteFilterParams {
  max_duration_minutes?: number;
  max_transfers?: number;
  direct_only?: boolean;
}

interface FilterDef {
  id: keyof RouteFilterParams;
  active: (p: RouteFilterParams) => boolean;
  test: (r: FilterableRoute, p: RouteFilterParams) => boolean;
}

export const FILTERS: FilterDef[] = [
  { id: "max_duration_minutes", active: (p) => p.max_duration_minutes !== undefined, test: (r, p) => r.duration_minutes <= p.max_duration_minutes! },
  { id: "max_transfers", active: (p) => p.max_transfers !== undefined, test: (r, p) => r.transfer_count <= p.max_transfers! },
  { id: "direct_only", active: (p) => p.direct_only === true, test: (r) => r.transfer_count === 0 },
];

export function applyFilters<R extends FilterableRoute>(routes: R[], p: RouteFilterParams): { routes: R[]; applied: RouteFilterParams } {
  const active = FILTERS.filter((f) => f.active(p));
  const applied: RouteFilterParams = {};
  for (const f of active) (applied as any)[f.id] = p[f.id];
  return { routes: routes.filter((r) => active.every((f) => f.test(r, p))), applied };
}
