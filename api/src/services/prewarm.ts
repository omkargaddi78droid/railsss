// Cache prewarm: when the API starts, compute the most likely searches into the Redis route cache so
// early users hit the cache instead of the engine.
//
// What is warmed (per date, today first, in PREWARM_TZ):
//   - the PREWARM_PAIRS busiest origin/destination pairs (pair weight = product of the two stations'
//     train counts, taken among the busiest stations), at every PREWARM_TIMES time. The default
//     "hourly" is 00:00..23:00, which matches the frontend's default search time (the current hour);
//     today's times start at the current hour, so the soonest searches are ready first;
//   - optional extra queries from PREWARM_FILE (JSON array of {source, destination, time}).
// Queries already in Redis are cache hits (a cheap GET), so re-running on every start is harmless.
// Across processes and instances a Redis lock lets only one prewarm run at a time.
import type { Logger } from "pino";

export interface PrewarmStation { code: string; train_count: number }
export interface PrewarmQuery { source: string; destination: string; date: string; time: string }

export interface PrewarmPlanOptions {
  pairs: number;
  times: string[] | "hourly";
  days: number;
  tz: string;
  extra?: { source: string; destination: string; time: string }[];
}

// Date (YYYY-MM-DD) and hour in a time zone, offset by `days`.
function localDate(now: Date, tz: string, days: number): { date: string; hour: number } {
  const d = new Date(now.getTime() + days * 86_400_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

export function busiestPairs(stations: PrewarmStation[], n: number): [string, string][] {
  if (n <= 0) return [];
  // n pairs need at most k stations with k * (k - 1) >= n; take a few more so weights can reorder them
  const k = Math.min(stations.length, Math.ceil(Math.sqrt(n)) + 10);
  const busy = [...stations].sort((a, b) => b.train_count - a.train_count || (a.code < b.code ? -1 : 1)).slice(0, k);
  const pairs: { a: string; b: string; w: number }[] = [];
  for (const a of busy) for (const b of busy) if (a !== b) pairs.push({ a: a.code, b: b.code, w: a.train_count * b.train_count });
  pairs.sort((x, y) => y.w - x.w || (x.a + x.b < y.a + y.b ? -1 : 1));
  return pairs.slice(0, n).map((p) => [p.a, p.b]);
}

export function planPrewarm(stations: PrewarmStation[], o: PrewarmPlanOptions, now = new Date()): PrewarmQuery[] {
  const pairs = busiestPairs(stations, o.pairs);
  const out: PrewarmQuery[] = [];
  const seen = new Set<string>();
  const add = (q: PrewarmQuery) => {
    const k = `${q.source}|${q.destination}|${q.date}|${q.time}`;
    if (!seen.has(k)) { seen.add(k); out.push(q); }
  };
  for (let day = 0; day < o.days; day++) {
    const { date, hour } = localDate(now, o.tz, day);
    let times = o.times === "hourly" ? Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`) : [...o.times];
    if (day === 0) {
      // soonest first: rotate so the current hour leads
      const i = times.findIndex((t) => Number(t.slice(0, 2)) >= hour);
      if (i > 0) times = [...times.slice(i), ...times.slice(0, i)];
    }
    for (const time of times) for (const [source, destination] of pairs) add({ source, destination, date, time });
    for (const e of o.extra ?? []) add({ ...e, date });
  }
  return out;
}

export interface PrewarmStats { total: number; computed: number; already_cached: number; failed: number; ms: number }

// Runs `warm` over the plan with bounded concurrency. warm resolves true when the entry was already cached.
export async function runPrewarm(
  plan: PrewarmQuery[],
  warm: (q: PrewarmQuery) => Promise<boolean>,
  concurrency: number,
  logger?: Logger,
): Promise<PrewarmStats> {
  const t0 = performance.now();
  const stats: PrewarmStats = { total: plan.length, computed: 0, already_cached: 0, failed: 0, ms: 0 };
  let next = 0;
  const lane = async () => {
    while (next < plan.length) {
      const q = plan[next++];
      try {
        if (await warm(q)) stats.already_cached++;
        else stats.computed++;
      } catch (e) {
        stats.failed++;
        if (stats.failed <= 3) logger?.warn({ query: q, err: (e as Error).message }, "prewarm query failed");
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  stats.ms = Math.round(performance.now() - t0);
  return stats;
}
