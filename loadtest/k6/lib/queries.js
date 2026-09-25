// Deterministic query workloads for the k6 scenarios. Material comes from loadtest/data/queries.json
// (see loadtest/gen-queries.ts), loaded once into SharedArrays.
//
// WORKLOAD
//   uniform  random station pairs and times, generated from the global iteration number, so every
//            request is a distinct query (cold cache) and reruns send the same sequence.
//            HEAVY_FRAC (0..1) swaps that fraction of requests for a heavy query (bimodal cost).
//   zipf     popular queries, rank i drawn with p ~ 1/i^ZIPF_S (0 = uniform over the list). Cache tests.
//   heavy    only the slowest bench queries. Run with the cache off, or every repeat is a hit.
//   session  a user: autocomplete source and destination, search, then page 2 (see run.js).
// SEED changes the sequences; the default reproduces earlier runs.
import { SharedArray } from "k6/data";
import exec from "k6/execution";

const FILE = __ENV.QUERIES || "/loadtest/data/queries.json";
const load = (field) => new SharedArray(field, () => JSON.parse(open(FILE))[field]);

export const DATE = __ENV.DATE || new SharedArray("date", () => [JSON.parse(open(FILE)).date])[0];
export const WORKLOAD = __ENV.WORKLOAD || "uniform";
const SEED = Number(__ENV.SEED || 1) >>> 0;
const ZIPF_S = Number(__ENV.ZIPF_S || 1.1);
const HEAVY_FRAC = Number(__ENV.HEAVY_FRAC || 0);

const codes = load("codes");
const popular = load("popular");
const heavy = load("heavy");
const nameArr = new SharedArray("names", () => Object.entries(JSON.parse(open(FILE)).names));
let names = null; // code -> name, built lazily per VU

// xorshift32, same as api/bench/load.ts and loadtest/gen-queries.ts.
function xorshift(seed) {
  let s = seed >>> 0 || 1;
  return (n) => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s % n;
  };
}

// Integer hash (lowbias32) so consecutive iteration numbers give unrelated generator seeds.
function mix(x) {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// Per-VU generator for the sampled workloads (zipf, heavy, HEAVY_FRAC coin).
let vuRand = null;
function rv(n) {
  if (!vuRand) vuRand = xorshift(mix(SEED * 7919 + exec.vu.idInTest));
  return vuRand(n);
}

function uniformQuery(i) {
  const r = xorshift(mix(SEED ^ mix(i + 1)));
  const a = r(codes.length);
  let b = r(codes.length);
  while (b === a) b = r(codes.length);
  const hh = String(r(24)).padStart(2, "0");
  const mm = String(r(4) * 15).padStart(2, "0");
  return { source: codes[a], destination: codes[b], time: `${hh}:${mm}` };
}

let zipfCdf = null;
function zipfQuery() {
  if (!zipfCdf) {
    zipfCdf = new Float64Array(popular.length);
    let sum = 0;
    for (let i = 0; i < popular.length; i++) zipfCdf[i] = sum += 1 / Math.pow(i + 1, ZIPF_S);
    for (let i = 0; i < popular.length; i++) zipfCdf[i] /= sum;
  }
  const u = rv(1 << 30) / (1 << 30);
  let lo = 0, hi = zipfCdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (zipfCdf[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return popular[lo];
}

function heavyQuery() {
  if (!heavy.length) throw new Error("queries.json has no heavy queries (run the engine bench with BENCH_DUMP, then gen-queries.ts)");
  return heavy[rv(heavy.length)];
}

// Next search for this iteration, as {source, destination, time}.
export function nextQuery(workload = WORKLOAD) {
  switch (workload) {
    case "uniform":
      if (HEAVY_FRAC > 0 && rv(1_000_000) < HEAVY_FRAC * 1_000_000) return heavyQuery();
      return uniformQuery(exec.scenario.iterationInTest);
    case "zipf":
    case "session":
      return zipfQuery();
    case "heavy":
      return heavyQuery();
    default:
      throw new Error(`unknown WORKLOAD ${workload}`);
  }
}

// What a user types into the station picker before choosing: the first 3 letters of the name.
export function prefixFor(code) {
  if (!names) names = new Map(nameArr.map(([c, n]) => [c, n]));
  return (names.get(code) || code).slice(0, 3);
}
