// Experiment catalogue for the AWS scaling study (docs/scaling-plan.md, E1–E18), run by loadtest/run.ts.
//
// An experiment is a list of variants. A variant is one deployment (the `base` variant file of
// deploy/variants/ plus `deploy` overrides) and one k6 run (`scenario` plus `k6` env), optionally with
// fault actions before or during the run. Everything else stays at deploy/variants/defaults.env.
//
// Params are numbers the experiment needs from earlier results, e.g. CAPACITY: the maximum RPS within
// the SLO of the baseline (16 workers), read off the E1 w16 breakpoint. Pass them as KEY=VALUE to run.ts.

export type Scenario = "smoke" | "load" | "breakpoint" | "spike" | "soak" | "closed";

export type Action =
  | { kind: "kill-workers"; count: number } // SIGKILL the last `count` workers of the plan (no drain)
  | { kind: "start-workers" } // start every stopped worker and wait until it is healthy
  | { kind: "kill-redis" }
  | { kind: "start-redis" }
  | { kind: "registry-set"; count: number | "all" }; // Redis set ENGINE_REGISTRY_KEY = the first `count` worker URLs

export type Knobs = Record<string, string | number>;

export interface Variant {
  name: string;
  deploy?: Knobs;
  scenario: Scenario;
  k6?: Knobs;
  setup?: Action[]; // after deploy and smoke, before the measured run
  during?: { at: number; action: Action }[]; // seconds after the measured run starts
  repeats?: number; // overrides the experiment's
}

export interface Experiment {
  id: string;
  title: string;
  question: string;
  base?: string; // deploy/variants/<base>.env, default "baseline"
  repeats?: number; // default 3
  params?: Record<string, number | null>; // default value; null = required
  unsupported?: string; // why run.ts cannot run it yet
  variants?: (p: Record<string, number>) => Variant[];
}

// Keys k6.sh forwards to k6 (keep in step with the list in deploy/k6.sh; the test checks it).
export const K6_KEYS = ["WORKLOAD", "SEED", "ZIPF_S", "HEAVY_FRAC", "DATE", "PAGE_SIZE", "THINK_S", "ITERATIONS", "RATE",
  "DURATION", "PRE_VUS", "MAX_VUS", "START_RATE", "MAX_RATE", "BASE_RATE", "SPIKE_RATE", "SPIKE_FOR", "HOLD", "VUS"];

// Typed literal lists: the variants' knob objects have different keys, which TypeScript would
// otherwise infer as a union that does not fit Knobs.
type Named = { name: string; deploy: Knobs };
type Tagged = { tag: string; deploy: Knobs };
const rows = <T>(xs: T[]): T[] => xs;
const rps = (x: number) => Math.max(1, Math.round(x));
const LB = ["round_robin", "random", "least_outstanding", "p2c", "consistent_hash"];
const REGISTRY = "engines";

export const EXPERIMENTS: Experiment[] = [
  {
    id: "E1",
    title: "Worker count scaling",
    question: "How does the maximum RPS within the SLO grow with 1–16 workers, and where does it stop being linear (USL fit)?",
    params: { PER_WORKER_RPS: 50 },
    variants: (p) => [1, 2, 4, 8, 12, 16].map((w) => ({
      name: `w${w}`,
      deploy: { WORKERS: w },
      scenario: "breakpoint",
      k6: { WORKLOAD: "uniform", START_RATE: 5, MAX_RATE: rps(p.PER_WORKER_RPS * w + 50), DURATION: "5m" },
    })),
  },
  {
    id: "E2",
    title: "Placement and hyperthreading",
    question: "8 workers: one per host (sibling vCPU idle) vs two HT siblings per host on 4 hosts vs one unpinned per host.",
    params: { MAX_RATE: 500 },
    variants: (p) => rows<Named>([
      { name: "spread-8hosts", deploy: { WORKERS: 8, WORKER_PLACEMENT: "spread" } },
      { name: "pack-4hosts", deploy: { WORKERS: 8, WORKER_PLACEMENT: "pack" } },
      { name: "unpinned-8hosts", deploy: { WORKERS: 8, WORKERS_PER_HOST: 1 } },
    ]).map((v) => ({ ...v, scenario: "breakpoint" as const, k6: { START_RATE: 5, MAX_RATE: p.MAX_RATE, DURATION: "5m" } })),
  },
  {
    id: "E3",
    title: "Threads per worker and pool concurrency",
    question: "1, 2 or 4 httplib threads on one pinned vCPU, with the pool sending 1 or 2 requests at a time to each worker.",
    params: { MAX_RATE: 900 },
    variants: (p) => [[1, 1], [1, 2], [1, 4], [2, 1], [2, 2], [2, 4]].map(([c, t]) => ({
      name: `c${c}-t${t}`,
      deploy: { ENGINE_CONCURRENCY: c, ENGINE_THREADS: t },
      scenario: "breakpoint",
      k6: { START_RATE: 5, MAX_RATE: p.MAX_RATE, DURATION: "5m" },
    })),
  },
  {
    id: "E4",
    title: "Load-balancing strategy",
    question: "Tail latency of each LB strategy at 70 % load, for uniform queries and a heavy-tailed mix.",
    params: { CAPACITY: null, HEAVY_CAPACITY: 0, LOAD: 0.7, HEAVY_FRAC: 0.1 },
    variants: (p) => {
      const heavyCap = p.HEAVY_CAPACITY || p.CAPACITY / 2;
      return LB.flatMap((lb): Variant[] => [
        { name: `${lb}-uniform`, deploy: { LB_STRATEGY: lb }, scenario: "load" as const,
          k6: { WORKLOAD: "uniform", RATE: rps(p.LOAD * p.CAPACITY), DURATION: "3m" } },
        { name: `${lb}-heavy`, deploy: { LB_STRATEGY: lb }, scenario: "load" as const,
          k6: { WORKLOAD: "uniform", HEAVY_FRAC: p.HEAVY_FRAC, RATE: rps(p.LOAD * heavyCap), DURATION: "3m" } },
      ]);
    },
  },
  {
    id: "E5",
    title: "Where to balance (nginx vs Node pool)",
    question: "nginx least_conn straight to the workers vs the Node pool.",
    unsupported: "the engine answers compact journeys that only the API can render, so nginx cannot route /api/routes to workers; needs a design decision",
  },
  {
    id: "E6",
    title: "Heterogeneous pools",
    question: "Fast and slow pools by predicted query cost vs one shared pool.",
    unsupported: "no cost predictor or pool split exists in the API yet",
  },
  {
    id: "E7",
    title: "Hedged requests",
    question: "p99 gain of hedging after 100 or 250 ms against the extra engine load, on the heavy-tailed mix.",
    params: { CAPACITY: null, HEAVY_CAPACITY: 0, LOAD: 0.6, HEAVY_FRAC: 0.1 },
    variants: (p) => [0, 100, 250].map((h) => ({
      name: h ? `hedge-${h}` : "hedge-off",
      deploy: { HEDGE_AFTER_MS: h },
      scenario: "load",
      k6: { WORKLOAD: "uniform", HEAVY_FRAC: p.HEAVY_FRAC, RATE: rps(p.LOAD * (p.HEAVY_CAPACITY || p.CAPACITY / 2)), DURATION: "3m" },
    })),
  },
  {
    id: "E8",
    title: "Node tier scaling",
    question: "One API process, a cluster of 2, and 2 API hosts (one worker host fewer): when does Node stop being the wall?",
    params: { MAX_RATE: 900 },
    variants: (p) => rows<Named>([
      { name: "gw1-cluster1", deploy: { NODE_CLUSTER: 1 } },
      { name: "gw1-cluster2", deploy: { NODE_CLUSTER: 2 } },
      { name: "gw2-cluster1", deploy: { API_HOSTS: 2, NODE_CLUSTER: 1 } },
      { name: "gw2-cluster2", deploy: { API_HOSTS: 2, NODE_CLUSTER: 2 } },
    ]).map((v) => ({ ...v, scenario: "breakpoint" as const, k6: { START_RATE: 5, MAX_RATE: p.MAX_RATE, DURATION: "5m" } })),
  },
  {
    id: "E9",
    title: "Payload cost",
    question: "Rendered page size (10 vs 50 journeys) and gzip at nginx: bytes on the wire, API CPU per request, capacity.",
    params: { MAX_RATE: 900 },
    variants: (p) => [10, 50].flatMap((page) => ["off", "on"].map((gzip) => ({
      name: `page${page}-gzip-${gzip}`,
      deploy: { GZIP: gzip },
      scenario: "breakpoint" as const,
      k6: { PAGE_SIZE: page, START_RATE: 5, MAX_RATE: p.MAX_RATE, DURATION: "5m" },
    }))),
  },
  {
    id: "E10",
    title: "Cache",
    question: "No cache vs Redis vs Redis + cache-warmer, under zipf popularity s = 0, 0.8, 1.1, 1.4.",
    params: { CAPACITY: null, LOAD: 0.7 },
    variants: (p) => rows<Tagged>([
      { tag: "nocache", deploy: { CACHE_BACKEND: "none" } },
      { tag: "redis", deploy: { CACHE_BACKEND: "redis" } },
      { tag: "prewarm", deploy: { CACHE_BACKEND: "redis", PREWARM: "true" } },
    ]).flatMap((c) => [0, 0.8, 1.1, 1.4].map((s) => ({
      name: `${c.tag}-s${s}`,
      deploy: c.deploy,
      scenario: "load" as const,
      k6: { WORKLOAD: "zipf", ZIPF_S: s, RATE: rps(p.LOAD * p.CAPACITY), DURATION: "3m" },
    }))),
  },
  {
    id: "E11",
    title: "Cache stampede",
    question: "A cold burst of mostly identical queries (zipf s=3) on 2 API processes: engine calls per distinct query with no " +
      "coalescing, in-process coalescing, and the cross-process Redis lock.",
    params: { CAPACITY: null, LOAD: 0.5 },
    variants: (p) => rows<Named>([
      { name: "no-coalesce", deploy: { CACHE_COALESCE: "false", REDIS_LOCK_MS: 0 } },
      { name: "coalesce", deploy: { CACHE_COALESCE: "true", REDIS_LOCK_MS: 0 } },
      { name: "redis-lock", deploy: { CACHE_COALESCE: "true", REDIS_LOCK_MS: 2000 } },
    ]).map((v) => ({
      ...v,
      deploy: { ...v.deploy, NODE_CLUSTER: 2 },
      scenario: "load" as const,
      k6: { WORKLOAD: "zipf", ZIPF_S: 3, RATE: rps(p.LOAD * p.CAPACITY), DURATION: "30s" },
    })),
  },
  {
    id: "E12",
    title: "Overload behaviour",
    question: "Goodput and latency at 1.5× and 2× capacity: unlimited queue, queue cap with 429, short timeout, and a retry storm.",
    params: { CAPACITY: null },
    variants: (p) => [1.5, 2].flatMap((x) => rows<Tagged>([
      { tag: "queue-unlimited", deploy: { MAX_QUEUE: -1 } },
      { tag: "queue-auto", deploy: { MAX_QUEUE: "auto" } },
      { tag: "timeout-1s", deploy: { MAX_QUEUE: -1, ENGINE_TIMEOUT_MS: 1000 } },
      { tag: "retry-storm", deploy: { MAX_QUEUE: -1, ENGINE_TIMEOUT_MS: 1000, RETRY_MAX: 3 } },
    ]).map((v) => ({
      name: `${v.tag}-x${x}`,
      deploy: v.deploy,
      scenario: "load" as const,
      k6: { RATE: rps(x * p.CAPACITY), DURATION: "2m" },
    }))),
  },
  {
    id: "E13",
    title: "Failure injection",
    question: "Kill 1, 4 or 8 workers (SIGKILL) or Redis mid-run: detection time, error burst, recovery after restart.",
    params: { CAPACITY: null, LOAD: 0.6 },
    variants: (p) => {
      const k6 = { RATE: rps(p.LOAD * p.CAPACITY), DURATION: "5m" };
      return [
        ...[1, 4, 8].map((n) => ({
          name: `kill${n}`,
          scenario: "load" as const,
          k6,
          during: [{ at: 60, action: { kind: "kill-workers", count: n } as Action }, { at: 180, action: { kind: "start-workers" } as Action }],
        })),
        {
          name: "kill-redis",
          scenario: "load" as const,
          k6,
          during: [{ at: 60, action: { kind: "kill-redis" } as Action }, { at: 180, action: { kind: "start-redis" } as Action }],
        },
      ];
    },
  },
  {
    id: "E14",
    title: "Elastic scaling",
    question: "Start with 8 workers above their capacity, add 8 through the Redis registry at 60 s: time to benefit, including cold start.",
    params: { CAPACITY: null, LOAD: 0.7 },
    variants: (p) => {
      const base = { deploy: { ENGINE_REGISTRY_KEY: REGISTRY }, scenario: "load" as const, k6: { RATE: rps(p.LOAD * p.CAPACITY), DURATION: "5m" } };
      const start8: Action[] = [{ kind: "kill-workers", count: 8 }, { kind: "registry-set", count: 8 }];
      return [
        { ...base, name: "join", setup: start8,
          during: [{ at: 60, action: { kind: "start-workers" } }, { at: 60, action: { kind: "registry-set", count: "all" } }] },
        { ...base, name: "static8", setup: start8 },
        { ...base, name: "static16" },
      ];
    },
  },
  {
    id: "E15",
    title: "K and label budget",
    question: "Capacity against completeness (search_complete rate) for TOP_K 10/20/50 and MAX_LABELS 200k/500k.",
    params: { MAX_RATE: 900 },
    variants: (p) => [10, 20, 50].flatMap((k) => [200000, 500000].map((labels) => ({
      name: `k${k}-labels${labels / 1000}k`,
      deploy: { TOP_K: k, MAX_LABELS: labels },
      scenario: "breakpoint" as const,
      k6: { START_RATE: 5, MAX_RATE: p.MAX_RATE, DURATION: "5m" },
    }))),
  },
  {
    id: "E16",
    title: "Closed vs open loop",
    question: "Same load with constant-arrival-rate and constant-vus: how much of the tail does the closed model hide?",
    params: { CAPACITY: null, LOAD: 0.8, VUS: 0, MEAN_LATENCY_MS: 100 },
    variants: (p): Variant[] => {
      const rate = rps(p.LOAD * p.CAPACITY);
      const vus = p.VUS || Math.ceil((rate * p.MEAN_LATENCY_MS) / 1000); // Little's law: N = X × R
      return [
        { name: "open", scenario: "load", k6: { RATE: rate, DURATION: "3m" } },
        { name: "closed", scenario: "closed", k6: { VUS: vus, DURATION: "3m" } },
      ];
    },
  },
  {
    id: "E17",
    title: "Spike and soak on the chosen config",
    question: "Recovery time after a spike to 1.5× capacity, and drift over a 60 min soak. Pass the chosen config as KEY=VALUE.",
    params: { CAPACITY: null },
    variants: (p): Variant[] => [
      { name: "spike", scenario: "spike",
        k6: { BASE_RATE: rps(0.3 * p.CAPACITY), SPIKE_RATE: rps(1.5 * p.CAPACITY), SPIKE_FOR: "30s", HOLD: "2m" } },
      { name: "soak", scenario: "soak", k6: { RATE: rps(0.6 * p.CAPACITY), DURATION: "60m" }, repeats: 1 },
    ],
  },
  {
    id: "E18",
    title: "Little's law and queueing",
    question: "Concurrency vs RPS × latency, and latency vs utilisation against M/M/c, over a load sweep of 20–100 % capacity.",
    params: { CAPACITY: null },
    variants: (p) => [0.2, 0.4, 0.6, 0.8, 0.9, 1.0].map((u) => ({
      name: `u${Math.round(u * 100)}`,
      scenario: "load" as const,
      k6: { RATE: rps(u * p.CAPACITY), DURATION: "3m" },
    })),
  },
];

export function findExperiment(id: string): Experiment {
  const e = EXPERIMENTS.find((x) => x.id.toLowerCase() === id.toLowerCase());
  if (!e) throw new Error(`unknown experiment ${id}; known: ${EXPERIMENTS.map((x) => x.id).join(" ")}`);
  return e;
}

// Params: the experiment's defaults, overridden by the command line. Missing required ones are an error.
export function resolveParams(e: Experiment, given: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, def] of Object.entries(e.params ?? {})) {
    const raw = given[k];
    if (raw === undefined && def === null) throw new Error(`${e.id} needs ${k}=<number> (see the experiment's params)`);
    const n = raw === undefined ? def! : Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${k} must be a number, got "${raw}"`);
    out[k] = n;
  }
  return out;
}
