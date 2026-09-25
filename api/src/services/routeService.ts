// Orchestrates a route search: normalized query -> cache -> engine -> filters -> pagination -> render.
// The cache holds the engine's compact result; only the returned page is rendered.
import type { EngineResult, EngineRoute, RoutingEngine } from "./engineClient.ts";
import { applyFilters, type RouteFilterParams } from "./filters.ts";
import { formatDatetime, type JourneyRenderer } from "./journeyRenderer.ts";
import { RouteCache } from "./routeCache.ts";
import type { StationService } from "./stationService.ts";

export interface RouteSearch {
  source: string;
  destination: string;
  date: string;
  time: string;
  limit: number;
  page: number;
  filters: RouteFilterParams;
}

// Cache-key identity of the engines: their routing configuration plus the timetable hash, from
// /health. The API and the cache-warmer both use it, so they build identical keys.
export function engineIdentity(health: Record<string, unknown>): string {
  return `${JSON.stringify(health.config ?? {})}|${String(health.timetable ?? "")}`;
}

export const NO_ROUTE_MESSAGE = "No valid journey found for the specified date and time.";

export class RouteService {
  private readonly engine: RoutingEngine;
  private readonly stations: StationService;
  private readonly cache: RouteCache<EngineResult>;
  private readonly renderer: JourneyRenderer;
  private readonly maxResults: number;
  configHash = "default"; // engineIdentity() of the workers, set once they are reachable

  constructor(engine: RoutingEngine, stations: StationService, cache: RouteCache<EngineResult>, renderer: JourneyRenderer, maxResults: number) {
    this.engine = engine;
    this.stations = stations;
    this.cache = cache;
    this.renderer = renderer;
    this.maxResults = maxResults;
  }

  // Computes one search into the cache (prewarm). Resolves true if it was already cached.
  async warm(q: { source: string; destination: string; date: string; time: string }, ttlSeconds?: number): Promise<boolean> {
    const key = RouteCache.key({ ...q, configHash: this.configHash });
    const r = await this.cache.getOrCompute(key, () => this.engine.route({ ...q, limit: this.maxResults }), ttlSeconds);
    return r.cached;
  }

  async search(q: RouteSearch) {
    const t0 = performance.now();
    // The engine always computes the full top-N once; limit/page/filters slice that result, so
    // changing them never triggers another routing run.
    const key = RouteCache.key({ ...q, configHash: this.configHash });
    const { value: result, cached } = await this.cache.getOrCompute(key, () =>
      this.engine.route({ source: q.source, destination: q.destination, date: q.date, time: q.time, limit: this.maxResults }),
    );
    this.renderer.check(result.timetable);
    const ranked = result.journeys.map((j, i) => ({ j, rank: i + 1, duration_minutes: j.arr - j.dep, transfer_count: j.transfers }));
    const { routes: filtered, applied } = applyFilters(ranked, q.filters);
    const start = (q.page - 1) * q.limit;
    const pageRoutes = filtered.slice(start, start + q.limit).map((r) => this.renderer.render(r.j, r.rank, result.search_minute));
    const src = this.stations.get(q.source)!;
    const dst = this.stations.get(q.destination)!;

    return {
      query: {
        source: q.source,
        destination: q.destination,
        source_name: src.name,
        destination_name: dst.name,
        date: q.date,
        time: q.time,
        search_datetime: formatDatetime(result.search_minute),
      },
      routes: pageRoutes.map((r) => shapeRoute(r)),
      ...(filtered.length === 0
        ? { message: result.journeys.length === 0 ? NO_ROUTE_MESSAGE : "No journey matches the selected filters." }
        : {}),
      filters_applied: applied,
      pagination: {
        page: q.page,
        limit: q.limit,
        returned: pageRoutes.length,
        total_available: filtered.length,
        total_unfiltered: result.journeys.length,
        total_pages: Math.max(1, Math.ceil(filtered.length / q.limit)),
        max_results: this.maxResults,
      },
      meta: {
        cached,
        search_complete: result.search_complete,
        engine_ms: typeof result.stats?.total_ms === "number" ? Math.round(result.stats.total_ms * 100) / 100 : null,
        api_ms: Math.round((performance.now() - t0) * 100) / 100,
        // engine process that computed this search (null on a cache hit), for per-worker load analysis
        worker: cached ? null : (result.worker ?? null),
      },
    };
  }
}

// Public route shape (spec section 13). Ranks refer to the unfiltered ranking so they stay stable
// while filters are toggled.
function shapeRoute(r: EngineRoute) {
  return {
    rank: r.rank,
    id: r.signature,
    source: r.segments[0].from_station,
    destination: r.segments[r.segments.length - 1].to_station,
    departure_datetime: r.departure_datetime,
    arrival_datetime: r.arrival_datetime,
    duration_minutes: r.duration_minutes,
    total_elapsed_duration_minutes: r.elapsed_from_search_minutes,
    initial_wait_minutes: r.initial_wait_minutes,
    train_travel_minutes: r.train_travel_minutes,
    waiting_minutes: r.waiting_minutes,
    transfer_count: r.transfer_count,
    segment_count: r.segment_count,
    is_direct: r.is_direct,
    distance_km: r.distance_km,
    train_numbers: r.segments.map((s) => s.train_number),
    segments: r.segments,
    transfers: r.transfers,
  };
}

export type RouteResponse = Awaited<ReturnType<RouteService["search"]>>;
export type { EngineRoute };
