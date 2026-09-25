# Distributed routing workers on AWS: scaling experiments + report

## Context
Today everything runs in one compose stack: one C++ engine process with 8 threads, and a Node API that
talks to one `ENGINE_URL`. The goal is **learning, not a production deploy**. The user will split the C++
engine into many single-core workers, keep request handling in Node/Express, deploy on AWS, and run many
controlled experiments. Examples: what happens with 4 workers, what happens with 16, which load-balancing
strategy works best. The result is a strong Markdown report in the repo.

Fixed budget:
- **10 × m6i/m7i.large** (2 vCPU = 1 physical core with HT, 8 GB) in the main account.
- k6 runs from one extra instance in another AWS account.

Baseline split: 8 instances × 2 workers = 16 C++ workers, and 2 instances for nginx, Node, Redis,
Mongo, Prometheus and Grafana. Provisioning uses Terraform plus deploy scripts.

Note for the report: on m6i/m7i, the 2 workers on one instance are hyperthread siblings on one physical
core. "16 workers" is 8 physical cores. That is one of the experiments (E2).

## Target topology (baseline, roles are reassignable)
```
k6 (other account) ──> [gw] nginx :80 ─> Node API (cluster x2)
                                  │  engine pool client (LB strategy, health, hedging)
                                  ├──> w1a w1b  (instance 1, 1 engine process per vCPU, cpuset pinned)
                                  ├──> ...       (instances 2..7)
                                  └──> w8a w8b  (instance 8)
[data] Redis, Mongo, Prometheus, Grafana
every node: node_exporter + cAdvisor
```
Roles live in one inventory file (`deploy/inventory.yml`: instance → role list), so experiments like
"7 worker instances + 2 API instances" are only an inventory change plus redeploy.

## Build work

### 1. Engine as worker (`routing-engine/`)
- One process per core. Pin with docker `--cpuset-cpus`. `ENGINE_THREADS` stays configurable because
  httplib needs one thread per keep-alive socket. The pool caps sockets per worker. `/metrics` and
  `/health` also live on `ADMIN_PORT` (7071, own two threads) and the pool's health checks close their
  connections, so `ENGINE_THREADS` can equal the pool concurrency (E3).
- Graceful shutdown: SIGTERM → `/health` 503 `draining` for `SHUTDOWN_GRACE_MS`, then drain and exit.
- Add `GET /metrics` (Prometheus text format, no new dependency) in `src/server.cpp`: requests, latency
  histogram, in-flight, labels popped, budget hits, response bytes.
- Add `WORKER_ID` in logs and responses (`meta.worker`).
- Optional lean response mode (`?stops=0`) to study payload size effects.
- Add an arm-neutral Dockerfile target. Keep x86 as the primary.

### 2. Node API as dispatcher (`api/src/services/`)
- New `enginePool.ts` that generalizes `engineClient.ts`:
  - Holds `ENGINE_URLS` (a list), with a per-worker semaphore reusing the existing FIFO `Semaphore`.
  - Active health checks eject and readmit workers.
  - Pluggable `LB_STRATEGY`: `round_robin | random | least_outstanding | p2c | consistent_hash`.
  - Retry on a different worker, controlled by `RETRY_MAX`.
  - Optional hedging via `HEDGE_AFTER_MS`.
  - Admission control via `MAX_QUEUE`: requests beyond the limit get 429.
  - Worker list comes from env or a Redis set (dynamic join and leave).
- `routeCache.ts`: add a backend interface with `CACHE_BACKEND=none|memory|redis|tiered`
  (later changed by the user: Redis only, no in-process tier, plus a prewarm that now runs as the separate
  cache-warmer service). Keep in-flight
  coalescing. Add an optional Redis lock for cross-instance coalescing.
- `/metrics` via `prom-client`:
  - HTTP histogram.
  - Per-worker latency and in-flight.
  - Queue depth.
  - Cache hit and miss, retries, hedges, 429s.
- `NODE_CLUSTER=n` runs n Express processes on the gateway instance.
- Every new behaviour is behind env flags with today's defaults, so existing tests stay valid. Add unit tests
  for each LB strategy, ejection, retry and hedge, using fake workers in `api/test/`.

### 3. Infra (`deploy/`)
- `terraform/`:
  - VPC, one subnet, a **cluster placement group** (low, stable latency), and security groups.
  - The k6 account's IP is allowed only on nginx :80 and the Prometheus remote-write port.
  - 10 instances; `instance_type` is a variable.
  - An S3 bucket or ECR repo for images.
  - Outputs are private and public IPs, which feed the inventory.
- `roles/*.compose.yml`: `worker`, `gateway` (nginx + api), `data` (redis, mongo), `monitoring`
  (prometheus, grafana), and `exporters` (node_exporter, cAdvisor) on every node.
- Scripts:
  - `deploy/deploy.sh <variant>`: renders env and nginx upstream from the inventory and the variant file,
    then runs `docker compose up` over SSH in parallel.
  - `deploy/variants/*.env`: one file per experiment config.
- Prometheus file-based service discovery is generated from the inventory. Grafana dashboards are provisioned
  as JSON: RED per service, USE per instance, and per-worker heatmap.
- The timetable (about MBs) is baked into the worker image, so there is no shared-file dependency.
- As built (session 7, see `deploy/README.md`): the inventory is `deploy/inventory.json` (JSON, generated by
  `deploy/inventory.ts`); instead of static `roles/*.compose.yml`, `deploy/render.ts` generates one compose
  file per host from the roles and the variant (the worker count and placement vary per variant); all
  containers use host networking; images go through ECR and hosts pull with their instance role; Mongo is
  not deployed (stations come from the API image); the k6 host has its own Terraform (`deploy/terraform/k6`).

### 4. Load testing (`loadtest/`, runs on the k6 instance)
- `k6/lib/queries.js`: deterministic generator (port xorshift32 from `api/bench/load.ts`). Workloads:
  - `uniform`
  - `zipf(s)` over popular pairs
  - `heavy` (pairs known to be expensive, from engine bench output)
  - `session` mix (autocomplete + search + page 2)
- Scenarios: `smoke`, `constant-arrival-rate` steps, `ramping-arrival-rate` breakpoint, `spike`, and `soak`.
  Plus one closed-loop run (`constant-vus`) for the methodology comparison.
- k6 pushes metrics via Prometheus remote write (`K6_PROMETHEUS_RW_SERVER_URL`), so client and server
  metrics share one Grafana timeline. It also saves the `--summary-export` JSON.
- `loadtest/run.sh <experiment>`: deploys the variant, runs smoke then the scenario, repeats 3 times, and
  stores the results in `loadtest/results/<exp>/<variant>/`. It also stores Prometheus range-query snapshots
  (CPU per instance, per-worker RPS) for the report.
- `loadtest/analyze.ts`: medians and spread, max RPS within SLO (p99 < 500 ms and errors < 0.1 %), the knee,
  a USL fit, and charts as SVG/PNG (read the dataviz skill first).

## Experiment catalogue
Each experiment fixes everything except one variable, and every experiment is kept on the 10-instance budget.

Worker-tier scaling:
- **E1 Worker count scaling.** Workers 1, 2, 4, 8, 12, 16. Measure max RPS within SLO and latency curves, fit
  the Universal Scalability Law, and compute efficiency per worker. Where does it stop being linear?
- **E2 Placement and hyperthreading.** Compare 8 workers as 1 per instance on 8 instances with
  2 per instance on 4 instances. This isolates HT sibling contention and shared L3 cache.
- **E3 Threads per worker.** 1, 2 and 4 httplib threads on one pinned vCPU, which shows oversubscription effects.
  Also compare worker concurrency limit 1 vs 2 in the pool.

Load balancing and dispatch:
- **E4 LB strategy.** Round robin, random, least-outstanding, power-of-two-choices and consistent-hash, under
  uniform and heavy workloads. Query cost varies 7 ms to 200+ ms, so smart balancing should matter.
- **E5 Where to balance.** nginx upstream (least_conn) directly to workers vs the Node pool doing it.
- **E6 Heterogeneous pools.** Split into a fast pool and a slow pool based on a predicted query cost,
  vs one shared pool. This reduces head-of-line blocking.
- **E7 Hedged requests** ("Tail at Scale"). Duplicate a request to a second worker after p95 ms. Measure the
  p99 gain against the extra load.

API tier and bottleneck shift:
- **E8 Node tier scaling.** One Node process, cluster of 2, and 2 gateway instances (taking one worker
  instance away). Find when the bottleneck moves from the workers to Node. Amdahl in practice.
- **E9 Payload cost (compact engine + render page only).** Since the compute-only change
  (`docs/compute-only-plan.md`) the engine returns compact journeys (~9 KB instead of ~260 KB) and the API
  renders only the returned page. Compare the page size the client asks for (`limit` 10 vs 50, so 10 vs 50
  rendered journeys), gzip at nginx on or off, and, as the "before" point, the pre-change images (git commit
  `771e17a`: full engine output, parse + reshape in Node). Measure network bytes per request between
  instances (`engine_response_bytes`) and API CPU per request.

Caching:
- **E10 Cache.** No cache, Redis, and Redis + cache-warmer (the separate one-shot service; the in-process
  tiers were removed by user decision), under zipf with s set to 0, 0.8, 1.1 and 1.4. Report hit ratio vs
  RPS and latency, and the warmer's run time and its load on the workers.
- **E11 Cache stampede.** A spike of identical cold queries with no coalescing, local coalescing, and a
  Redis lock.

Reliability and overload:
- **E12 Overload behaviour.** At 1.5× and 2× capacity, compare no admission control, a queue cap with 429,
  and timeouts. Measure goodput and latency collapse, and add a retry-storm demo.
- **E13 Failure injection.**
  - Kill 1, 4 and 8 workers mid-test: measure detection time, error burst and recovery.
  - Kill Redis: the cache should fail open.
  - Restart Mongo.
- **E14 Elastic scaling simulation.** Add workers during a ramp through the Redis registry. Measure
  time-to-benefit, including the worker cold start (timetable load about 360 ms).

Algorithm vs capacity:
- **E15 K and budget.** K at 10, 20 and 50, and `MAX_LABELS` at 200k and 500k. Measure capacity against
  result completeness (`search_complete` rate).

Methodology:
- **E16 Closed vs open loop.** Same target load with k6 `constant-vus` and `constant-arrival-rate`. This
  shows coordinated omission in the tail numbers.
- **E17 Test types on the best config.** Spike recovery time, and soak (60 min) drift in memory, cache
  size and latency.
- **E18 Little's law and queueing check.** Measured concurrency vs RPS × latency, and utilization vs
  latency against an M/M/c prediction.

## Report (`docs/load-test-report.md` + `docs/load-test/*.svg`)
Sections:
1. Goals.
2. Environment: instance type, HT note, placement group, versions.
3. Architecture diagram.
4. Methodology: SLO, workloads, open-loop, 3 repeats, warm-up, CPU pinning.
5. One section per experiment: question, setup, chart, result, explanation using the Grafana/Prometheus
   evidence.
6. Summary table of findings.
7. Recommended configuration.
8. Threats to validity: cloud noise, HT, a single k6 generator, and cross-account latency.
9. Cost of the study.

Link it from README.

## Build order
1. Engine `/metrics` + `WORKER_ID`.
2. Node `enginePool` + LB strategies + tests.
3. Cache backends + `/metrics`.
4. Local rehearsal: compose with 4 workers on this laptop, running k6 in docker at small scale.
   This debugs scripts cheaply before spending AWS money.
5. Terraform + deploy scripts + monitoring.
6. AWS runs: E1 first as the baseline, then the others.
7. `analyze.ts`, then the report.

Tear down with `terraform destroy` between sessions to save cost.

## Verification
- After each code change:
  - `routing-engine/build/engine_tests` (oracle)
  - `cd api && npm test && npx tsc --noEmit`
  - `cd scripts && npm test`
- A new pool test suite runs fake workers with injected latency and failures to check each strategy,
  ejection, retry, hedge and 429.
- Local rehearsal: 4-worker compose passes the smoke test, and Grafana shows per-worker RPS spread.
- Correctness across variants: a fixed set of 200 queries returns identical route signatures from every
  variant. The canonical JSON diff is run by `loadtest/verify-results.ts`.
- On AWS, every variant must pass smoke with 0 errors before measurement. Repeats must agree within about 10 %.
  Otherwise, rerun and report the spread.
