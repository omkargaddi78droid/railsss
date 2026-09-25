"use client";

import { Fragment, useState } from "react";
import { dayDiff, duration, hhmm, shortDate, stationLabel } from "@/lib/format";
import type { Journey, Segment, Transfer } from "@/lib/types";

function DayBadge({ base, dt }: { base: string; dt: string }) {
  const d = dayDiff(base, dt);
  if (d <= 0) return null;
  return (
    <sup className="ml-0.5 rounded bg-amber-100 px-1 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300" title={shortDate(dt)}>
      +{d}
    </sup>
  );
}

function Node({ time, base, station, strong }: { time: string; base: string; station: { code: string | null; name: string }; strong?: boolean }) {
  return (
    <li className="relative flex items-start gap-3 pl-0">
      <div className="tabular w-14 shrink-0 pt-0.5 text-right text-sm font-semibold">
        {hhmm(time)}
        <DayBadge base={base} dt={time} />
      </div>
      <span
        className={`relative z-10 mt-1.5 h-3 w-3 shrink-0 rounded-full border-2 ${
          strong ? "border-brand-600 bg-brand-600" : "border-brand-600 bg-white dark:bg-slate-900"
        }`}
      />
      <div className="min-w-0 pb-1 text-sm">
        <span className="font-medium">{station.name}</span> {station.code && <span className="font-mono text-xs text-slate-500">({station.code})</span>}
      </div>
    </li>
  );
}

function SegmentBody({ seg, base }: { seg: Segment; base: string }) {
  const [open, setOpen] = useState(false);
  const intermediate = seg.stops.slice(1, -1);
  return (
    <li className="relative flex gap-3">
      <div className="w-14 shrink-0" />
      <div className="flex w-3 shrink-0 justify-center">
        <span className="w-0.5 bg-brand-600" />
      </div>
      <div className="min-w-0 flex-1 py-2">
        <div className="rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="chip bg-brand-600 font-mono text-white">{seg.train_number}</span>
            <span className="font-medium">{seg.train_name}</span>
            <span className="chip bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200">{seg.train_type}</span>
          </div>
          <div className="tabular mt-1 flex flex-wrap gap-x-4 text-xs text-slate-500 dark:text-slate-400">
            <span>{duration(seg.duration_minutes)}</span>
            <span>{Math.round(seg.distance_km)} km</span>
            <span>
              {seg.stop_count - 1} intermediate stop{seg.stop_count - 1 === 1 ? "" : "s"}
            </span>
            <span>train started {shortDate(seg.train_start_date)}</span>
          </div>
          {intermediate.length > 0 && (
            <>
              <button
                className="mt-2 text-xs font-medium text-brand-600 hover:underline"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
              >
                {open ? "Hide stops" : "Show stops"}
              </button>
              {open && (
                <ol className="mt-2 space-y-1 border-l border-dashed border-slate-300 pl-3 text-xs dark:border-slate-600">
                  {intermediate.map((s, i) => (
                    <li key={i} className="tabular flex gap-3">
                      <span className="w-24 shrink-0 text-slate-500">
                        {s.arrival_datetime ? hhmm(s.arrival_datetime) : "--:--"} – {s.departure_datetime ? hhmm(s.departure_datetime) : "--:--"}
                        {s.arrival_datetime && <DayBadge base={base} dt={s.arrival_datetime} />}
                      </span>
                      <span className={s.boardable ? "" : "italic text-slate-400"}>{stationLabel(s)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function TransferRow({ t }: { t: Transfer }) {
  return (
    <li className="relative flex gap-3">
      <div className="w-14 shrink-0" />
      <div className="flex w-3 shrink-0 justify-center">
        <span className="w-0 border-l-2 border-dashed border-slate-300 dark:border-slate-600" />
      </div>
      <div className="py-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="chip bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">Transfer · {duration(t.wait_minutes)}</span>{" "}
        at {stationLabel(t.station)}
      </div>
    </li>
  );
}

export function JourneyCard({ j, fastest }: { j: Journey; fastest: boolean }) {
  const [open, setOpen] = useState(j.rank === 1);
  const base = j.departure_datetime;
  return (
    <article className="card overflow-hidden" aria-label={`Journey ${j.rank}`}>
      <button className="w-full p-4 text-left transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular text-xs font-semibold text-slate-400">#{j.rank}</span>
          {j.is_direct ? (
            <span className="chip bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">Direct</span>
          ) : (
            <span className="chip bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {j.transfer_count} transfer{j.transfer_count === 1 ? "" : "s"}
            </span>
          )}
          {fastest && <span className="chip bg-brand-50 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100">Earliest arrival</span>}
          <span className="ml-auto font-mono text-xs text-slate-400">{j.train_numbers.join(" → ")}</span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <div>
            <div className="tabular text-2xl font-bold">{hhmm(j.departure_datetime)}</div>
            <div className="text-xs text-slate-500">{shortDate(j.departure_datetime)}</div>
          </div>
          <div className="flex flex-1 flex-col items-center">
            <span className="tabular text-xs font-medium text-slate-500">{duration(j.duration_minutes)}</span>
            <div className="relative my-1 h-0.5 w-full bg-slate-200 dark:bg-slate-700">
              {j.transfers.map((_, i) => (
                <span
                  key={i}
                  className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-amber-400"
                  style={{ left: `${((i + 1) / (j.segment_count)) * 100}%` }}
                />
              ))}
            </div>
            <span className="text-[11px] text-slate-400">{Math.round(j.distance_km)} km</span>
          </div>
          <div className="text-right">
            <div className="tabular text-2xl font-bold">
              {hhmm(j.arrival_datetime)}
              <DayBadge base={base} dt={j.arrival_datetime} />
            </div>
            <div className="text-xs text-slate-500">{shortDate(j.arrival_datetime)}</div>
          </div>
        </div>
        <dl className="tabular mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <dt className="text-slate-400">On train</dt>
            <dd className="font-medium">{duration(j.train_travel_minutes)}</dd>
          </div>
          <div>
            <dt className="text-slate-400">Waiting at transfers</dt>
            <dd className="font-medium">{duration(j.waiting_minutes)}</dd>
          </div>
          <div>
            <dt className="text-slate-400">From your start time</dt>
            <dd className="font-medium">{duration(j.total_elapsed_duration_minutes)}</dd>
          </div>
        </dl>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-4 pb-4 pt-3 dark:border-slate-800">
          <ol className="relative">
            {j.segments.map((seg, i) => (
              <Fragment key={i}>
                <Node time={seg.departure_datetime} base={base} station={seg.from_station} strong={i === 0} />
                <SegmentBody seg={seg} base={base} />
                <Node time={seg.arrival_datetime} base={base} station={seg.to_station} strong={i === j.segments.length - 1} />
                {j.transfers[i] && <TransferRow t={j.transfers[i]} />}
              </Fragment>
            ))}
          </ol>
        </div>
      )}
    </article>
  );
}
