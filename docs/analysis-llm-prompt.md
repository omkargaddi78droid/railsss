# Prompt for the analysis LLM

Give an LLM everything below the line, and attach the zip made by `node loadtest/pack.ts`
(`study-results-<date>.zip`; see `docs/experiment-runbook.md` section 9). If the LLM can run code, let it.
Otherwise it still writes the report from what it can read, and you run the Python it produces.

---

You are analysing the results of a load-testing and scaling study of a railway journey-planning service.
The attached zip holds every measured run. Your job:

1. Analyse the results and write a complete **analysis report** (Markdown).
2. Write **Python code** that recreates every table and chart in the report from the zip, which I will
   run myself.

Be quantitative and careful. Every claim in the report must come from the data in the zip. Say so when the
data does not support a conclusion, when repeats disagree, or when a run failed.

## 1. The system under test

- **Request path**: k6 load generator (separate AWS account, same region) → nginx on host `node09` → Node.js
  API (Express; `NODE_CLUSTER` processes) → a pool of C++ routing-engine workers on hosts `node01`–`node08`.
  Redis (result cache) and Prometheus + Grafana run on `node10`.
- **Hosts**: 10 × AWS m6i.large or m7i.large (see `manifest.json` `environment`). Each has 2 vCPU, which is
  **1 physical core with hyperthreading**, and 8 GB. By default each worker host runs 2 engine processes,
  each pinned to one vCPU, so the two workers of a host are HT siblings. "16 workers" = 8 physical cores.
- **Engine**: each `/route` request is a multi-criteria earliest-arrival search over a timetable (single
  thread per request). The cost varies a lot: on a laptop, p50 ≈ 8.5 ms, p99 ≈ 196 ms and max ≈ 586 ms. A
  label budget (`MAX_LABELS`) truncates the most expensive searches (`search_complete = false`). The engine
  returns compact journeys (~9 KB); the API renders only the requested page (`PAGE_SIZE`, default 10).
- **API dispatcher** (`EnginePool`): per-worker concurrency limit `ENGINE_CONCURRENCY` (default 2),
  load-balancing strategy `LB_STRATEGY` (round_robin | random | least_outstanding (default) | p2c |
  consistent_hash), `RETRY_MAX`, hedging `HEDGE_AFTER_MS`, admission control `MAX_QUEUE` (`auto` = queue up
  to one pool capacity, then answer 429; `-1` = unlimited), active health checks every 2 s, passive
  ejection after 3 failures, engine timeout 5 s.
- **Cache**: Redis only (no in-process cache), key = query + engine config + timetable hash, TTL 1 h,
  in-flight coalescing per process (`CACHE_COALESCE`), optional cross-process Redis lock (`REDIS_LOCK_MS`),
  optional one-shot cache-warmer after deploy (`PREWARM`). Every repeat starts with an empty Redis.
- **Known from the local rehearsal** (a laptop, not AWS; treat it as a hypothesis to check): the single Node
  API process was the first bottleneck (~0.85 CPU at the knee), before the workers were saturated.
- **SLO**: p99 latency < 500 ms and error rate < 0.1 %, measured at the client. "Max RPS within the SLO" is
  the capacity measure throughout.

## 2. The zip

```
study-results/
  manifest.json          {generated_at, git_commit, environment{region, instance_type, hosts, roles{host:[roles]}},
                          slo{p99_ms, error_rate_max}, experiments{E1:{ok, not_ok}, …}, runs:[…]}
                         runs[i] = the repeat's meta.json plus "path" (folder inside the zip)
  attempts.jsonl         every attempt, including failed ones (status != "ok")
  environment/
    inventory.json       hosts, private/public IPs, roles
    git.txt              commit of the code that ran
    defaults.env         every deployment knob and its default (comments explain them)
    experiments.ts       the experiment catalogue as run (variants, params, fault actions)
  experiments/<EXP>/
    experiment.json      {id, title, question, base, params, overrides{deploy, k6}, variants:[{name, deploy, scenario, k6, setup, during}]}
    <variant>/r<n>/      one repeat (usually r1–r3)
      meta.json          see below
      summary.json       k6 end-of-test summary of the measured run
      plan.json          deployed topology: hosts (roles, phase), workers [{id, host, url, cpuset}], api hosts
      variant.env        every resolved deployment knob (KEY=VALUE)
      smoke/summary.json the pre-run smoke test (20 requests; must be error-free)
      prom/<series>.json Prometheus range queries over the run (section 3)
      logs/<host>.log    container logs for the run window (warn level and above)
      deploy.log, k6.log, k6-smoke.log
  screenshots/           optional Grafana images: screenshots/<EXP>/<variant>-r<n>-<panel>.png
  notes.md               optional: the operator's notes (config decisions, incidents). Read it first.
```

A variant name may have a suffix (`w16-best`), which marks a rerun with a different configuration. The
configuration is in its `meta.json` `deploy_overrides` and `variant.env`.

**meta.json**: `experiment, title, variant, repeat, testid, base, deploy_overrides{}, scenario` (smoke | load
| breakpoint | spike | soak | closed), `k6_env{}` (RATE, DURATION, WORKLOAD, ZIPF_S, HEAVY_FRAC, PAGE_SIZE,
START_RATE, MAX_RATE, BASE_RATE, SPIKE_RATE, SPIKE_FOR, HOLD, VUS, SEED …), `params{}` (e.g. CAPACITY),
`setup[]`, `during[] {at (s after start), action{kind, count}}`, `events[] {at, action, ok, took_s, error}`
(when the fault actions actually ran), `deploy_started_at, started_at, ended_at, finished_at` (ISO UTC),
`duration_s, git_commit, image_tag, instance_type, region, workers` (count), `k6_exit` (0 = thresholds
passed, 99 = a threshold was crossed, which is **expected** in breakpoint and overload runs, anything else =
k6 error), `thresholds_passed, status` (ok | deploy-failed | smoke-failed | setup-failed | k6-failed),
`prom_series` (count saved) or `prom_error`.

**summary.json** (k6 `--summary-export`): `{"metrics": {name: {...}}, "root_group": {...}}`.
- Trends (values in ms): `{avg, min, med, max, "p(90)", "p(95)", "p(99)", "p(99.9)"}`.
- Counters: `{count, rate}`, where the rate is per second over the whole run.
- Rates: `{passes, fails, value}`, where `passes` = the number of *true* samples.
  For `http_req_failed`, true means failed, so the error rate is `value`.
- Gauges: `{value, min, max}`.
- A metric with a threshold has `"thresholds": {expr: bool}`, where **true means the threshold failed**.

Metrics:
- `http_reqs`, `http_req_duration` (client latency: the SLO metric), `http_req_failed`, `iterations`,
  `data_received`, `data_sent`, `vus`, `vus_max`, `checks`, `http_req_waiting` / `sending` / `receiving` /
  `blocked` / `connecting`.
- Custom metrics:
  - `route_latency_ms`: client latency of searches.
  - `route_engine_ms`: engine time reported by the server, uncached searches only.
  - `route_api_ms`: API time reported by the server.
  - `route_cache_hit`: rate of searches answered from Redis.
  - `route_search_complete`: rate of searches not truncated by the label budget.
  - `route_with_routes`: rate of searches that found at least one journey.
  - `route_overloaded`: counter of 429 answers.
  - `route_worker_requests`: counter.
- The summary covers the **whole run**, ramp included. For breakpoint runs it is not the capacity.

**prom/<series>.json**: `{query, start, end, step: 5, response}`, where `response` is the Prometheus HTTP API
answer: `{"status": "success", "data": {"resultType": "matrix", "result": [{"metric": {labels}, "values":
[[unix_ts, "value"], …]}]}}`. Values are strings; `"NaN"` occurs (e.g. a quantile with no traffic). Rates
use a 30 s window, so each point averages the previous 30 s. The series:

| file | query meaning | labels |
|---|---|---|
| `k6_rps` | client requests/s | `name` (search, search_page, stations), `status` |
| `k6_failed_rate` | client error rate | – |
| `k6_overloaded_rps` | 429s/s seen by k6 | – |
| `k6_vus` | active virtual users | – |
| `k6_latency_p50/p90/p99/max` | client latency (ms) from k6 remote write | – |
| `api_rps` | API requests/s | `route`, `status` |
| `api_latency_p50`, `api_latency_p99` | API latency of /api/routes (**seconds**), windowed histogram quantile | – |
| `api_pool_in_flight` | engine calls in flight (whole pool) | – |
| `api_worker_outstanding` | in flight + queued per worker | `worker` (URL) |
| `api_worker_healthy` | 1/0 per worker | `worker` |
| `api_worker_errors_rps` | failed engine calls/s | `worker` |
| `api_cache_events` | **cumulative** counters | `outcome` (remote_hit, miss, coalesced, lock_wait, remote_error) |
| `api_pool_events` | **cumulative** counters | `event` (retry, hedge, hedge_win, rejected = 429) |
| `engine_requests` | **cumulative** counters | `worker` (e.g. node01a), `outcome` |
| `engine_rps` | engine requests/s | `worker` |
| `engine_in_flight` | searches running | `worker` |
| `engine_route_p50`, `engine_route_p99` | engine search time (seconds), all workers | – |
| `engine_route_p99_by_worker` | engine p99 per worker (seconds) | `worker` |
| `engine_labels_popped_rps` | search work done (labels/s) | `worker` |
| `engine_budget_hits_rps` | truncated searches/s | – |
| `engine_response_bytes_rps` | engine → API bytes/s | – |
| `container_cpu` | CPU cores used | `name` (`<host>-<service>`, e.g. node09-api, node03-engine-a) |
| `container_memory` | working set bytes | `name` |
| `host_cpu_busy` | fraction of the host's 2 vCPU busy | `host` |
| `host_net_rx_bytes`, `host_net_tx_bytes` | bytes/s | `host` |
| `nginx_connections_active`, `nginx_rps` | gateway | – |

Cumulative counters include everything since the containers started. The deploy restarts only the
containers whose config changed, and each run includes a smoke test. So use differences within the run
window, not the absolute values. The API counters reset when the API restarts. A drop in a counter means a
restart, so treat it as a reset.

**Caveat on k6 latency series.** k6's remote-write trend gauges (`k6_latency_*`, `k6_failed_rate`) may be
computed over the run so far, not per window. Check this: a cumulative series changes slowly and never
falls back sharply after a spike. For **windowed** latency, prefer `api_latency_p99` (server-side). It
excludes nginx and the network (a few ms in one region), so it runs slightly below the client value. State
which one you used.

## 3. The experiments

The exact variants are in each `experiment.json` and in `environment/experiments.ts`. `CAPACITY` (a param)
is the operator's reading of the maximum RPS within the SLO of the 16-worker baseline. The fixed-rate
experiments scale their load from it. The catalogue:

- **E1 Worker count scaling**: 1, 2, 4, 8, 12, 16 workers ("spread": one per host before a second per host;
  from 9 workers on, HT siblings are used). Breakpoint (open model, ramp over 5 min). Max RPS within SLO per
  worker count, efficiency per worker, **USL fit**, and where scaling stops being linear.
- **E2 Placement/HT**: 8 workers as 1 per host on 8 hosts (sibling idle) vs 2 per host on 4 hosts (HT
  siblings) vs 1 unpinned per host. Breakpoint.
- **E3 Threads per worker × pool concurrency**: `ENGINE_CONCURRENCY` 1/2 × `ENGINE_THREADS` 1/2/4. Breakpoint.
- **E4 LB strategy**: 5 strategies × {uniform queries, heavy-tailed mix (`HEAVY_FRAC` of the slowest
  queries)}, fixed load. Compare the tail (p99, p99.9, max) and the balance of outstanding work per worker.
- **E5, E6**: not run (not implemented). Say so in the report.
- **E7 Hedged requests**: `HEDGE_AFTER_MS` 0/100/250 on the heavy mix at fixed load. p99 gain vs extra engine
  load (pool events `hedge`, `hedge_win`; engine RPS vs client RPS).
- **E8 Node tier**: 1 API process, a cluster of 2, 2 API hosts (14 workers), 2 API hosts × cluster 2.
  Breakpoint. Where is the bottleneck (API container CPU vs worker CPU)? Amdahl.
- **E9 Payload**: page size 10 vs 50 × nginx gzip off/on. Breakpoint. Bytes per request (`data_received` /
  `http_reqs`), API CPU per request, capacity.
- **E10 Cache**: no cache / Redis / Redis + warmer × zipf s = 0, 0.8, 1.1, 1.4, at fixed load. Hit ratio (from
  `api_cache_events` deltas and `route_cache_hit`), latency cached vs not, engine load saved. The warmer's
  run time and search count are in `deploy.log`.
- **E11 Stampede**: 30 s cold burst of mostly identical queries (zipf s = 3), 2 API processes. No coalescing
  vs per-process coalescing vs Redis lock. Engine calls per distinct query (`engine_requests` delta vs
  `api_cache_events` `miss`/`coalesced`/`lock_wait`).
- **E12 Overload**: 1.5× and 2× CAPACITY × {unlimited queue, `MAX_QUEUE=auto` (429), 1 s engine timeout,
  timeout + 3 retries}. Goodput (successful RPS), 429 share, latency, collapse.
- **E13 Failure injection**: at t = 60 s kill 1, 4 or 8 workers (SIGKILL), or Redis; restart at t = 180 s.
  Detection time (`api_worker_healthy` → 0), error burst size and length, recovery time. Redis should fail
  open. Use `events` for the exact action times.
- **E14 Elastic scaling**: start with 8 workers, above their capacity. At t = 60 s the other 8 start and join
  through the Redis registry (`join`). The bounds are `static8` and `static16`. Time to benefit, including
  the engine's cold start.
- **E15 K and label budget**: `TOP_K` 10/20/50 × `MAX_LABELS` 200k/500k. Capacity vs completeness
  (`route_search_complete`) and budget hits.
- **E16 Closed vs open loop**: the same load as constant-arrival-rate (`open`) and constant-VUs (`closed`).
  Show coordinated omission: how much the closed model understates the tail.
- **E17 Spike and soak** on the chosen configuration (see `notes.md` / `deploy_overrides`). Spike: 0.3× →
  1.5× CAPACITY for 30 s and back; recovery time. Soak: 60 min at 0.6×; drift in memory (`container_memory`),
  latency, errors.
- **E18 Little's law and queueing**: load sweep at 20–100 % of CAPACITY. Check L = λW. For the engine tier,
  compare mean `engine_in_flight` summed with `engine_rps` × mean engine time; for the pool,
  `api_pool_in_flight`. Also compare latency vs utilisation with an **M/M/c** (Erlang C) prediction. For
  c, use workers × `ENGINE_CONCURRENCY` or the number of physical cores. Discuss which fits and why, since
  the service times are far from exponential.

## 4. Methods to use

- **Validity first.** List every repeat whose `status` is not `ok`, whose smoke failed, or whose summary is
  missing. Exclude them and say so. Check that `meta.json` configs match the intended variant. Check the
  cache: uniform workloads should have `route_cache_hit` ≈ 0; otherwise the run was warm.
- **Repeats.** Report the median over repeats and the spread (min–max, and the coefficient of variation).
  Flag any variant whose repeats differ by more than 10 %.
- **Max RPS within SLO (breakpoint runs).**
  1. Align the series on time.
  2. For each 5 s step, compute the achieved RPS (`k6_rps` summed over statuses), the windowed p99
     (`api_latency_p99` × 1000), and the error rate (non-2xx `k6_rps` / all). k6 status labels are strings;
     429 counts as an error.
  3. Capacity is the highest achieved RPS at a step after which the SLO still holds, i.e. the last step
     before the SLO is broken for 2 or more consecutive steps.
  4. Skip the first 30 s (warm-up).
  5. If a run never broke the SLO, report the capacity as "≥ max achieved" and flag it.
- **Knee.** For E1 and E18, find where the marginal gain (d capacity / d workers) or the latency growth
  (d p99 / d load) changes most. Show it on the chart.
- **USL** (E1): fit X(N) = λN / (1 + σ(N − 1) + κN(N − 1)) to the median capacity per worker count N. Use
  non-linear least squares; with numpy only, a grid over σ, κ ≥ 0 with a closed-form λ is fine. Report λ, σ
  and κ, the R², the predicted peak N* = sqrt((1 − σ) / κ), and the efficiency X(N) / (N·X(1)). Note that
  N > 8 means HT siblings, so the per-worker capacity changes there. Fit both all points and N ≤ 8, and
  compare.
- **Fault timelines** (E13, E14, E17 spike): plot per-worker RPS, health and errors around the action
  times. Measure detection time, error count (from `k6_rps` non-2xx, integrated over the window) and time to
  recover (p99 back under 500 ms for 30 s).
- **Bottleneck attribution**: for each capacity result, show the CPU of the API container(s), the workers
  and nginx at the knee. Name the resource that saturated first.

## 5. What to deliver

Deliver these files, each in its own code block with the path as its heading. If you can write files,
put them in a folder `analysis-output/`.

1. **`report/analysis-report.md`**: the report, with these sections:
   1. Summary: a 5–10 line answer to "how does it scale, what limits it, what config to use".
   2. Environment and method: hosts, HT note, SLO, workloads, open-loop model, repeats, what was excluded
      and why.
   3. One section per experiment (E1–E18, with E5 and E6 marked not run). Each has: **question**, **setup**
      (variants, load, repeats), **result** (a table plus a reference to the figure file), and
      **explanation** that cites the evidence (CPU, queueing, cache events, logs). The explanation should
      say *why*, not only *what*.
   4. Summary table of findings: experiment, key number(s), conclusion, confidence (high / medium / low,
      based on the repeat spread).
   5. Max RPS within SLO for every breakpoint variant; the knee; the USL fit and what σ and κ mean here.
   6. Recommendations: a configuration for this workload, and what to change first to scale further.
   7. Threats to validity: cloud noise, HT siblings, one k6 generator, cross-account network, warm-up, the
      SLO measured server-side vs client-side, the cumulative-gauge caveat, and anything you found in the
      data.
2. **`report/summary-table.csv`**: one row per experiment × variant, with median and spread of the key
   metrics: capacity or achieved RPS, p50/p99/p99.9 (ms), error rate, cache hit rate, API CPU, engine CPU.
3. **`analysis/analyze_results.py`**, a single script:
   - `python analyze_results.py study-results-<date>.zip --out out/` reads the zip directly (`zipfile`,
     no extraction needed) or an extracted folder.
   - It uses **only** the Python standard library, **pandas**, **numpy** and **matplotlib**. No network
     access, no scipy, no seaborn.
   - It writes every figure as both **SVG and PNG** to `out/figures/`, the tables as CSV to `out/tables/`,
     and `out/summary-table.csv`. At minimum, the figures are:
     - E1 capacity vs workers with the USL curve and linear ideal, plus efficiency;
     - latency vs load for every breakpoint experiment (one line per variant);
     - E4 p99 and max by strategy × workload;
     - E7 p99 vs extra load;
     - E8 capacity and CPU by tier;
     - E10 hit ratio and p99 vs zipf s;
     - E11 engine calls per distinct query;
     - E12 goodput vs offered load;
     - E13 and E14 timelines with the action times marked;
     - E15 capacity vs completeness;
     - E16 open vs closed latency distribution;
     - E17 spike recovery and soak memory;
     - E18 L vs λW, and latency vs utilisation with the M/M/c curve.
   - It skips missing experiments and variants with a printed note. It never crashes on a missing series,
     `NaN`, or a failed repeat.
   - The figures follow simple, consistent rules: a title that states the finding; labelled axes with
     units; the SLO line at 500 ms on latency charts; median lines with a min–max band over repeats; one
     colour per variant, the same across charts; readable in greyscale.
   - The code is commented and has functions per experiment. `python analyze_results.py --help` explains
     the usage.
4. **`analysis/README.md`**: how to install (`pip install pandas numpy matplotlib`) and run it, and which
   figure answers which question.

If some data needed for a section is missing, write the section anyway: state what is missing, and say
what the next run should collect.
