// Generates loadtest/data/queries.json, the fixed query material for the k6 workloads and verify-results.ts.
//
//   node loadtest/gen-queries.ts [--seed 1] [--date 2026-09-25] [--popular 2000] [--heavy-pct 2]
//
// Inputs: data/processed/stations.json (station codes, names, train counts) and
// loadtest/data/bench-queries.csv, written by the engine bench:
//   BENCH_DUMP=loadtest/data/bench-queries.csv routing-engine/build/bench data/processed/timetable.json 4000 2026-09-25
//
// Output fields:
//   codes    every station code; k6 draws uniform queries from it on the fly (cold cache)
//   names    code -> name, for the session workload's autocomplete prefixes
//   popular  queries between busy stations, most popular first; the zipf workload samples rank i with p ~ 1/i^s
//   heavy    the slowest heavy-pct % of the bench queries (engine ms included)
//   verify   200 fixed queries for verify-results.ts
// The output is committed so the k6 instance needs neither the engine nor the processed data.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    seed: { type: "string", default: "1" },
    date: { type: "string", default: "2026-09-25" },
    popular: { type: "string", default: "2000" },
    "heavy-pct": { type: "string", default: "2" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const stations: { code: string; name: string; train_count: number }[] = JSON.parse(
  readFileSync(resolve(root, "data/processed/stations.json"), "utf8"),
);

// Same xorshift32 as api/bench/load.ts and loadtest/k6/lib/queries.js.
let state = Number(args.seed) >>> 0 || 1;
function rand(n: number): number {
  state ^= state << 13; state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5; state >>>= 0;
  return state % n;
}
const time = () => `${String(rand(24)).padStart(2, "0")}:${String(rand(4) * 15).padStart(2, "0")}`;

interface Q { source: string; destination: string; time: string; ms?: number }

const codes = stations.map((s) => s.code);
const names = Object.fromEntries(stations.map((s) => [s.code, s.name]));

// Popular: pairs among the 150 busiest stations. Pair weight = product of train counts, so the
// busiest pairs get the lowest ranks; each pair appears with a few departure times.
const busy = [...stations].sort((a, b) => b.train_count - a.train_count).slice(0, 150);
const pairs: { a: string; b: string; w: number }[] = [];
for (const a of busy) for (const b of busy) if (a !== b) pairs.push({ a: a.code, b: b.code, w: a.train_count * b.train_count });
pairs.sort((x, y) => y.w - x.w || (x.a + x.b < y.a + y.b ? -1 : 1));
const popularN = Number(args.popular);
const popular: Q[] = [];
const seen = new Set<string>();
for (let i = 0; popular.length < popularN && i < pairs.length * 4; i++) {
  const p = pairs[Math.floor(i / 4)];
  const q = { source: p.a, destination: p.b, time: time() };
  const k = `${q.source}|${q.destination}|${q.time}`;
  if (!seen.has(k)) { seen.add(k); popular.push(q); }
}

// Heavy: slowest bench queries.
let heavy: Q[] = [];
const benchCsv = resolve(here, "data/bench-queries.csv");
if (existsSync(benchCsv)) {
  const rows = readFileSync(benchCsv, "utf8").trim().split("\n").slice(1).map((l) => {
    const [source, destination, t, ms] = l.split(",");
    return { source, destination, time: t, ms: Number(ms) };
  });
  rows.sort((x, y) => y.ms - x.ms);
  heavy = rows.slice(0, Math.max(1, Math.round((rows.length * Number(args["heavy-pct"])) / 100)));
} else {
  console.warn(`${benchCsv} missing: heavy workload will be empty`);
}

const verify: Q[] = [];
for (let i = 0; i < 150; i++) {
  let a = rand(codes.length), b = rand(codes.length);
  while (b === a) b = rand(codes.length);
  verify.push({ source: codes[a], destination: codes[b], time: time() });
}
verify.push(...popular.slice(0, 30), ...heavy.slice(0, 20).map(({ ms: _ms, ...q }) => q));

const out = { date: args.date, seed: Number(args.seed), codes, names, popular, heavy, verify };
writeFileSync(resolve(here, "data/queries.json"), JSON.stringify(out));
const hms = heavy.map((h) => h.ms!);
console.log(
  `codes ${codes.length}, popular ${popular.length}, heavy ${heavy.length}` +
    (hms.length ? ` (engine ms ${hms[hms.length - 1].toFixed(1)}..${hms[0].toFixed(1)})` : "") +
    `, verify ${verify.length}`,
);
