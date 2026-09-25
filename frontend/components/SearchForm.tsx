"use client";

import { useState } from "react";
import type { StationHit } from "@/lib/types";
import { StationPicker } from "./StationPicker";

export interface SearchInput {
  from: StationHit | null;
  to: StationHit | null;
  date: string;
  time: string;
}

interface Props {
  initial: SearchInput;
  loading: boolean;
  onSearch: (v: { from: StationHit; to: StationHit; date: string; time: string }) => void;
}

export function SearchForm({ initial, loading, onSearch }: Props) {
  const [v, setV] = useState<SearchInput>(initial);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!v.from || !v.to) return setError("Choose both stations from the suggestions.");
    if (v.from.code === v.to.code) return setError("Source and destination must be different stations.");
    if (!v.date || !v.time) return setError("Choose a date and time.");
    setError(null);
    onSearch({ from: v.from, to: v.to, date: v.date, time: v.time });
  };

  return (
    <form onSubmit={submit} className="card p-4 sm:p-5" aria-label="Journey search">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-end">
        <StationPicker label="From" value={v.from} onChange={(from) => setV({ ...v, from })} autoFocus={!v.from} />
        <button
          type="button"
          onClick={() => setV({ ...v, from: v.to, to: v.from })}
          className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 text-slate-500 transition hover:border-brand-500 hover:text-brand-600 md:mb-1 dark:border-slate-700"
          aria-label="Swap source and destination"
          title="Swap"
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5 rotate-90 md:rotate-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h13l-4-4M17 17H4l4 4" />
          </svg>
        </button>
        <StationPicker label="To" value={v.to} onChange={(to) => setV({ ...v, to })} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label htmlFor="date" className="field-label">
            Date
          </label>
          <input id="date" type="date" className="input" value={v.date} onChange={(e) => setV({ ...v, date: e.target.value })} required />
        </div>
        <div>
          <label htmlFor="time" className="field-label">
            Earliest departure
          </label>
          <input id="time" type="time" className="input" value={v.time} onChange={(e) => setV({ ...v, time: e.target.value })} required />
        </div>
        <button
          type="submit"
          disabled={loading}
          className="h-12 rounded-xl bg-brand-600 px-8 font-semibold text-white shadow-sm transition hover:bg-brand-700 focus:outline-none focus:ring-4 focus:ring-brand-100 disabled:cursor-wait disabled:opacity-70 dark:focus:ring-brand-700/40"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </form>
  );
}
