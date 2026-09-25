"use client";

import { useState } from "react";
import {
  activeFilterCount,
  FILTER_DEFAULTS,
  MAX_DURATION_LIMIT,
  TIME_WINDOWS,
  type FilterOptions,
  type FilterState,
  type TimeWindow,
  type ViaMode,
} from "@/lib/filters";
import { duration } from "@/lib/format";

interface Props {
  value: FilterState;
  onChange: (f: FilterState) => void;
  options: FilterOptions;
  total: number;
  shown: number;
}

const TRANSFER_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "≤ 1", value: 1 },
  { label: "≤ 2", value: 2 },
  { label: "≤ 3", value: 3 },
];

const VIA_MODES: { id: ViaMode; label: string; hint: string }[] = [
  { id: "only", label: "Only via", hint: "Every change of train happens at a ticked station (direct trains still count)." },
  { id: "must", label: "Must via", hint: "At least one change of train happens at a ticked station." },
  { id: "avoid", label: "Avoid", hint: "No change of train at any ticked station." },
];

const MIN_CONNECTION: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "45m", value: 45 },
  { label: "1h", value: 60 },
  { label: "1½h", value: 90 },
  { label: "2h", value: 120 },
];

const MAX_LAYOVER: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "2h", value: 120 },
  { label: "4h", value: 240 },
  { label: "8h", value: 480 },
  { label: "12h", value: 720 },
];

const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x]);
const title = (s: string) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function Section({ label, active, onClear, children }: { label: string; active?: boolean; onClear?: () => void; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 pt-4 first:border-0 first:pt-0 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          {label}
          {active && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-brand-500 align-middle" />}
        </h3>
        {active && onClear && (
          <button className="text-[11px] font-medium text-slate-400 hover:text-brand-600" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Segmented<T>({ items, value, onPick, cols }: { items: { label: string; value: T }[]; value: T; onPick: (v: T) => void; cols: number }) {
  return (
    <div className="segmented" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {items.map((o) => (
        <button key={o.label} type="button" aria-pressed={value === o.value} onClick={() => onPick(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Windows({ value, onChange }: { value: TimeWindow[]; onChange: (w: TimeWindow[]) => void }) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {TIME_WINDOWS.map((w) => (
        <button key={w.id} type="button" className="toggle flex-col gap-0! px-1!" aria-pressed={value.includes(w.id)} onClick={() => onChange(toggle(value, w.id))}>
          <span>{w.label}</span>
          <span className="tabular text-[10px] opacity-70">{w.range}</span>
        </button>
      ))}
    </div>
  );
}

export function FilterPanel({ value, onChange, options, total, shown }: Props) {
  const n = activeFilterCount(value);
  const set = (patch: Partial<FilterState>) => onChange({ ...value, ...patch });
  const [q, setQ] = useState("");
  const stations = options.transferStations.filter(
    (s) => !q || s.code.toLowerCase().startsWith(q.toLowerCase()) || s.name.toLowerCase().includes(q.toLowerCase()) || value.viaStations.includes(s.code),
  );
  // keep ticked stations visible even when they no longer appear in the results
  const missing = value.viaStations.filter((c) => !options.transferStations.some((s) => s.code === c));

  return (
    <aside className="card space-y-4 p-4" aria-label="Filters">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Filters</h2>
        {n > 0 && (
          <button className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400" onClick={() => onChange(FILTER_DEFAULTS)}>
            Reset all ({n})
          </button>
        )}
      </div>

      <Section label="Changes" active={value.directOnly || value.maxTransfers !== null} onClear={() => set({ directOnly: false, maxTransfers: null })}>
        <label className="mb-3 flex cursor-pointer items-center justify-between gap-3">
          <span className="text-sm">Direct trains only</span>
          <input type="checkbox" className="peer sr-only" checked={value.directOnly} onChange={(e) => set({ directOnly: e.target.checked })} />
          <span className="relative h-6 w-11 shrink-0 rounded-full bg-slate-300 transition peer-checked:bg-brand-600 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-100 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5 dark:bg-slate-700" />
        </label>
        <fieldset disabled={value.directOnly} className="disabled:opacity-50">
          <legend className="sr-only">Maximum transfers</legend>
          <Segmented items={TRANSFER_OPTIONS} value={value.maxTransfers} onPick={(v) => set({ maxTransfers: v })} cols={4} />
        </fieldset>
      </Section>

      <Section label="Transfer stations" active={value.viaStations.length > 0} onClear={() => set({ viaStations: [] })}>
        {options.transferStations.length === 0 && missing.length === 0 ? (
          <p className="text-xs text-slate-500">No journey in these results changes trains.</p>
        ) : (
          <>
            <Segmented items={VIA_MODES.map((m) => ({ label: m.label, value: m.id }))} value={value.viaMode} onPick={(v) => set({ viaMode: v })} cols={3} />
            <p className="mt-1.5 text-[11px] leading-snug text-slate-500">{VIA_MODES.find((m) => m.id === value.viaMode)!.hint}</p>
            {options.transferStations.length > 6 && (
              <input className="input mt-2 h-9! text-sm!" placeholder="Search stations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search transfer stations" />
            )}
            <ul className="scroll-thin mt-2 max-h-56 space-y-0.5 overflow-y-auto pr-1">
              {[...missing.map((code) => ({ code, name: code, count: 0 })), ...stations].map((s) => (
                <li key={s.code}>
                  <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 rounded accent-brand-600"
                      checked={value.viaStations.includes(s.code)}
                      onChange={() => set({ viaStations: toggle(value.viaStations, s.code) })}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {title(s.name)} <span className="font-mono text-xs text-slate-400">{s.code}</span>
                    </span>
                    <span className="tabular shrink-0 text-xs text-slate-400">{s.count}</span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section label="Train type" active={value.trainTypes.length > 0} onClear={() => set({ trainTypes: [] })}>
        <p className="mb-1.5 text-[11px] text-slate-500">Every leg must be one of the ticked types.</p>
        <ul className="space-y-0.5">
          {options.trainTypes.map((t) => (
            <li key={t.type}>
              <label className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 rounded accent-brand-600"
                  checked={value.trainTypes.includes(t.type)}
                  onChange={() => set({ trainTypes: toggle(value.trainTypes, t.type) })}
                />
                <span className="flex-1">{title(t.type)}</span>
                <span className="tabular text-xs text-slate-400">{t.count}</span>
              </label>
            </li>
          ))}
        </ul>
      </Section>

      <Section label="Departure time" active={value.departWindows.length > 0} onClear={() => set({ departWindows: [] })}>
        <Windows value={value.departWindows} onChange={(w) => set({ departWindows: w })} />
      </Section>

      <Section label="Arrival time" active={value.arriveWindows.length > 0} onClear={() => set({ arriveWindows: [] })}>
        <Windows value={value.arriveWindows} onChange={(w) => set({ arriveWindows: w })} />
      </Section>

      <Section label="Connections" active={value.minConnection !== null || value.maxLayover !== null} onClear={() => set({ minConnection: null, maxLayover: null })}>
        <p className="mb-1.5 text-xs">Minimum time to change trains</p>
        <Segmented items={MIN_CONNECTION} value={value.minConnection} onPick={(v) => set({ minConnection: v })} cols={5} />
        <p className="mb-1.5 mt-3 text-xs">Longest single wait</p>
        <Segmented items={MAX_LAYOVER} value={value.maxLayover} onPick={(v) => set({ maxLayover: v })} cols={5} />
      </Section>

      <Section label="Journey duration" active={value.maxDuration < MAX_DURATION_LIMIT} onClear={() => set({ maxDuration: MAX_DURATION_LIMIT })}>
        <div className="mb-1 flex items-baseline justify-between text-xs">
          <label htmlFor="maxdur">At most</label>
          <span className="tabular font-medium">{value.maxDuration >= MAX_DURATION_LIMIT ? "Any" : duration(value.maxDuration)}</span>
        </div>
        <input
          id="maxdur"
          type="range"
          min={60}
          max={MAX_DURATION_LIMIT}
          step={30}
          value={value.maxDuration}
          onChange={(e) => set({ maxDuration: Number(e.target.value) })}
          className="w-full accent-brand-600"
        />
      </Section>

      {value.excludedTrains.length > 0 && (
        <Section label="Excluded trains" active onClear={() => set({ excludedTrains: [] })}>
          <div className="flex flex-wrap gap-1.5">
            {value.excludedTrains.map((t) => (
              <button
                key={t}
                className="chip bg-rose-50 font-mono text-rose-700 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300"
                onClick={() => set({ excludedTrains: value.excludedTrains.filter((x) => x !== t) })}
                aria-label={`Include train ${t} again`}
              >
                {t} ✕
              </button>
            ))}
          </div>
        </Section>
      )}

      <p className="border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
        Showing <span className="font-semibold text-slate-700 dark:text-slate-200">{shown}</span> of {total} fastest journeys. Filters narrow this list; they never
        change the ranking.
      </p>
    </aside>
  );
}
