"use client";

import { activeFilterCount, FILTER_DEFAULTS, MAX_DURATION_LIMIT, type FilterState } from "@/lib/filters";
import { duration } from "@/lib/format";

interface Props {
  value: FilterState;
  onChange: (f: FilterState) => void;
  total: number;
  shown: number;
}

const TRANSFER_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Any", value: null },
  { label: "≤ 1", value: 1 },
  { label: "≤ 2", value: 2 },
  { label: "≤ 3", value: 3 },
];

export function FilterPanel({ value, onChange, total, shown }: Props) {
  const n = activeFilterCount(value);
  return (
    <aside className="card space-y-5 p-4" aria-label="Filters">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Filters</h2>
        {n > 0 && (
          <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => onChange(FILTER_DEFAULTS)}>
            Reset ({n})
          </button>
        )}
      </div>

      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-sm">Direct trains only</span>
        <input
          type="checkbox"
          className="peer sr-only"
          checked={value.directOnly}
          onChange={(e) => onChange({ ...value, directOnly: e.target.checked })}
        />
        <span className="relative h-6 w-11 shrink-0 rounded-full bg-slate-300 transition peer-checked:bg-brand-600 peer-focus-visible:ring-4 peer-focus-visible:ring-brand-100 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5 dark:bg-slate-700" />
      </label>

      <fieldset disabled={value.directOnly} className="disabled:opacity-50">
        <legend className="mb-2 text-sm">Transfers</legend>
        <div className="grid grid-cols-4 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
          {TRANSFER_OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={value.maxTransfers === o.value}
              onClick={() => onChange({ ...value, maxTransfers: o.value })}
              className={`rounded-lg py-1.5 text-xs font-medium transition ${
                value.maxTransfers === o.value ? "bg-white shadow-sm dark:bg-slate-950" : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div>
        <div className="mb-2 flex items-baseline justify-between text-sm">
          <label htmlFor="maxdur">Max journey duration</label>
          <span className="tabular text-xs text-slate-500">
            {value.maxDuration >= MAX_DURATION_LIMIT ? `Any (≤ ${MAX_DURATION_LIMIT} min)` : duration(value.maxDuration)}
          </span>
        </div>
        <input
          id="maxdur"
          type="range"
          min={60}
          max={MAX_DURATION_LIMIT}
          step={30}
          value={value.maxDuration}
          onChange={(e) => onChange({ ...value, maxDuration: Number(e.target.value) })}
          className="w-full accent-brand-600"
        />
      </div>

      <p className="border-t border-slate-100 pt-3 text-xs text-slate-500 dark:border-slate-800">
        Showing {shown} of {total} fastest journeys. Filters never change the ranking.
      </p>
    </aside>
  );
}
