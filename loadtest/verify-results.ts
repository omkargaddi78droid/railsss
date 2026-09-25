// Correctness check across deployment variants: the 200 fixed `verify` queries from
// loadtest/data/queries.json must return identical ranked route signatures from every variant
// (worker count, LB strategy, cache backend, ... must never change answers).
//
//   node loadtest/verify-results.ts --url http://localhost:8090 [--url http://other:80]
//                                   [--save loadtest/data/verify-baseline.json] [--against loadtest/data/verify-baseline.json]
//
// With several --url values they are compared with each other; --against compares with a saved run.
// Exits 1 on any difference or failed request.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    url: { type: "string", multiple: true, default: ["http://localhost:8090"] },
    save: { type: "string" },
    against: { type: "string" },
    concurrency: { type: "string", default: "4" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(resolve(here, "data/queries.json"), "utf8"));
const queries: { source: string; destination: string; time: string }[] = data.verify;

// Canonical answer per query: completeness flag plus the ranked signatures (the date-free itinerary ids).
type Answer = { complete: boolean; ids: string[] };
type Run = Record<string, Answer>;
const keyOf = (q: { source: string; destination: string; time: string }) => `${q.source}>${q.destination}@${q.time}`;

async function collect(base: string): Promise<Run> {
  const out: Run = {};
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const q = queries[next++];
      const res = await fetch(`${base.replace(/\/$/, "")}/api/routes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...q, date: data.date, limit: 50, page: 1 }),
      });
      if (res.status !== 200) throw new Error(`${base} ${keyOf(q)}: HTTP ${res.status} ${await res.text()}`);
      const body = await res.json();
      out[keyOf(q)] = { complete: body.meta.search_complete, ids: body.routes.map((r: { id: string }) => r.id) };
    }
  };
  await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function diff(nameA: string, a: Run, nameB: string, b: Run): number {
  let bad = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    bad++;
    if (bad <= 10) {
      const firstDiff = x && y ? x.ids.findIndex((id, i) => id !== y.ids[i]) : -1;
      console.log(`  ${k}: ${nameA} ${x ? `${x.ids.length} routes complete=${x.complete}` : "missing"} vs ` +
        `${nameB} ${y ? `${y.ids.length} routes complete=${y.complete}` : "missing"}` +
        (firstDiff >= 0 ? `, first difference at rank ${firstDiff + 1}` : ""));
    }
  }
  return bad;
}

const runs: [string, Run][] = [];
for (const u of args.url) runs.push([u, await collect(u)]);
const [baseName, base] = runs[0];
const withRoutes = Object.values(base).filter((a) => a.ids.length).length;
console.log(`${queries.length} queries via ${baseName}: ${withRoutes} with routes, ` +
  `${Object.values(base).filter((a) => !a.complete).length} incomplete searches`);

let failures = 0;
for (const [name, run] of runs.slice(1)) {
  const n = diff(baseName, base, name, run);
  console.log(`${name}: ${n ? `${n} differing queries` : "identical"}`);
  failures += n;
}
if (args.against) {
  const saved: Run = JSON.parse(readFileSync(args.against, "utf8"));
  const n = diff(baseName, base, args.against, saved);
  console.log(`${args.against}: ${n ? `${n} differing queries` : "identical"}`);
  failures += n;
}
if (args.save) {
  writeFileSync(args.save, JSON.stringify(base, null, 1));
  console.log(`saved ${args.save}`);
}
process.exit(failures ? 1 : 0);
