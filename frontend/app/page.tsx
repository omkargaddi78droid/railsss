"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FilterPanel } from "@/components/FilterPanel";
import { JourneyCard } from "@/components/JourneyCard";
import { SearchForm, type SearchInput } from "@/components/SearchForm";
import { RequestError, searchRoutes } from "@/lib/api";
import { applyFilters, FILTER_DEFAULTS, type FilterState } from "@/lib/filters";
import { hhmm, shortDate, todayIso } from "@/lib/format";
import type { RouteResponse, StationHit } from "@/lib/types";

const PAGE_SIZE = 5;

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; data: RouteResponse };

export default function Home() {
  const [initial, setInitial] = useState<SearchInput | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [filters, setFilters] = useState<FilterState>(FILTER_DEFAULTS);
  const [page, setPage] = useState(1);

  const run = useCallback(async (v: { from: StationHit; to: StationHit; date: string; time: string }) => {
    setState({ kind: "loading" });
    setPage(1);
    const params = new URLSearchParams({ from: v.from.code, to: v.to.code, date: v.date, time: v.time });
    window.history.replaceState(null, "", `?${params}`);
    try {
      const data = await searchRoutes({ source: v.from.code, destination: v.to.code, date: v.date, time: v.time });
      setState({ kind: "done", data });
    } catch (e) {
      const err = e as RequestError;
      setState({ kind: "error", message: err.details?.length ? err.details.map((d) => d.message).join("; ") : err.message });
    }
  }, []);

  // Restore a shared search from the URL (?from=BD&to=NDLS&date=...&time=...).
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const now = new Date();
    const base: SearchInput = {
      from: null,
      to: null,
      date: p.get("date") || todayIso(),
      time: p.get("time") || `${String(now.getHours()).padStart(2, "0")}:00`,
    };
    const codes = [p.get("from"), p.get("to")];
    if (!codes[0] || !codes[1]) return setInitial(base);
    Promise.all(codes.map((c) => fetch(`/api/stations/${encodeURIComponent(c!)}`).then((r) => (r.ok ? (r.json() as Promise<StationHit>) : null))))
      .then(([from, to]) => {
        const v = { ...base, from, to };
        setInitial(v);
        if (from && to) void run({ from, to, date: v.date, time: v.time });
      })
      .catch(() => setInitial(base));
  }, [run]);

  const all = state.kind === "done" ? state.data.routes : [];
  const filtered = useMemo(() => applyFilters(all, filters), [all, filters]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => setPage(1), [filters]);

  return (
    <main className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex items-center gap-3 py-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-white">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="3" width="14" height="13" rx="3" />
            <path d="M5 11h14M9 20l-2 2M15 20l2 2M9 16v4M15 16v4" />
          </svg>
        </div>
        <div>
          <h1 className="text-lg font-bold leading-tight">RailRoute</h1>
          <p className="text-xs text-slate-500">The 20 earliest-arriving journeys, transfers included</p>
        </div>
      </header>

      {initial ? (
        <SearchForm initial={initial} loading={state.kind === "loading"} onSearch={run} />
      ) : (
        <div className="card h-[172px] animate-pulse" />
      )}

      <section className="mt-6" aria-live="polite">
        {state.kind === "idle" && (
          <div className="card p-8 text-center text-sm text-slate-500">
            Pick a source and destination. Direct trains and multi-transfer connections are ranked together by arrival time.
          </div>
        )}
        {state.kind === "loading" && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card h-36 animate-pulse" />
            ))}
          </div>
        )}
        {state.kind === "error" && (
          <div role="alert" className="card border-rose-200 p-5 text-sm text-rose-700 dark:border-rose-900 dark:text-rose-300">
            {state.message}
          </div>
        )}
        {state.kind === "done" && (
          <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
            <div className="lg:sticky lg:top-4 lg:self-start">
              <FilterPanel value={filters} onChange={setFilters} total={all.length} shown={filtered.length} />
            </div>
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
                <h2 className="text-sm">
                  <span className="font-semibold">{state.data.query.source_name}</span> <span className="text-slate-400">({state.data.query.source})</span>
                  <span className="mx-2 text-slate-400">→</span>
                  <span className="font-semibold">{state.data.query.destination_name}</span> <span className="text-slate-400">({state.data.query.destination})</span>
                </h2>
                <p className="text-xs text-slate-500">
                  from {shortDate(state.data.query.search_datetime)} {hhmm(state.data.query.search_datetime)}
                  {state.data.meta.engine_ms !== null && <> · routed in {state.data.meta.engine_ms.toFixed(0)} ms</>}
                </p>
              </div>
              {!state.data.meta.search_complete && all.length > 0 && (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  The search reached its work limit; the journeys shown are the fastest found, in exact order, but there may be fewer than 20.
                </p>
              )}
              {all.length === 0 && (
                <div className="card p-8 text-center text-sm text-slate-500">{state.data.message ?? "No valid journey found for the specified date and time."}</div>
              )}
              {all.length > 0 && filtered.length === 0 && (
                <div className="card p-8 text-center text-sm text-slate-500">
                  No journey matches the selected filters.{" "}
                  <button className="font-medium text-brand-600 hover:underline" onClick={() => setFilters(FILTER_DEFAULTS)}>
                    Reset filters
                  </button>
                </div>
              )}
              {shown.map((j) => (
                <JourneyCard key={j.id} j={j} fastest={j.rank === 1} />
              ))}
              {pages > 1 && (
                <nav className="flex items-center justify-center gap-1 pt-2" aria-label="Pagination">
                  <button className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-40" disabled={page === 1} onClick={() => setPage(page - 1)}>
                    ‹ Prev
                  </button>
                  {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
                    <button
                      key={p}
                      aria-current={p === page ? "page" : undefined}
                      onClick={() => setPage(p)}
                      className={`tabular h-8 w-8 rounded-lg text-sm ${p === page ? "bg-brand-600 font-semibold text-white" : "hover:bg-slate-100 dark:hover:bg-slate-800"}`}
                    >
                      {p}
                    </button>
                  ))}
                  <button className="rounded-lg px-3 py-1.5 text-sm disabled:opacity-40" disabled={page === pages} onClick={() => setPage(page + 1)}>
                    Next ›
                  </button>
                </nav>
              )}
            </div>
          </div>
        )}
      </section>
      <footer className="mt-12 text-center text-xs text-slate-400">
        Times are timetable times (IST). Minimum transfer time 30 minutes. Routing: exact K-best earliest-arrival search in C++.
      </footer>
    </main>
  );
}
