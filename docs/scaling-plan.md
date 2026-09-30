# Distributed routing workers on AWS: scaling experiments + report

## Context
The application runs in one compose stack: one C++ engine process and a Node API. For this study the engine
is split into many single-core workers, request handling stays in Node/Express, the whole thing is deployed
on AWS, and many controlled experiments are run: what happens with 4 workers, with 16, which load-balancing
strategy works best, and so on. The goal is **learning, not a production deploy**. The result is a Markdown
report in the repo.

Fixed budget:
- **10 × m7i-flex.large** (2 vCPU = 1 physical core with HT, 8 GB) in the main account.
- k6 runs from one extra instance in another AWS account.

On m7i-flex, the 2 workers on one instance are hyperthread siblings on one physical core: "16 workers" is 8
physical cores. That is one of the experiments (E2).

## Topology (default layout; roles are reassignable)
```
k6 (other account) ──> node09: nginx :80 ─> Node API
                                  │  engine pool (LB strategy, health, retry, hedging)
                                  ├──> node01: 2 engine workers (1 per vCPU, cpuset pinned)
                                  ├──> ...
                                  └──> node08: 2 engine workers
node10: Redis, Prometheus, Grafana
every host: node-exporter + cAdvisor
```
Roles live in one inventory file (`deploy/inventory.json`: host → role list), so experiments like
"7 worker hosts + 2 API hosts" are only an inventory change (or `API_HOSTS=2`) plus a redeploy.

## What was built

- **Engine as worker** (`routing-engine/`): one process per vCPU, `WORKER_ID`, `/metrics`, a separate admin
  port for health and metrics, `X-Inflight` on replies, graceful drain on SIGTERM.
- **Node API as dispatcher** (`api/src/services/enginePool.ts`): `ENGINE_URLS`, per-worker semaphore, six
  `LB_STRATEGY` values, retry, hedging, `MAX_QUEUE` admission control with 429, health checks and ejection,
  a Redis registry for joining and leaving workers, `NODE_CLUSTER`, Prometheus metrics.
- **Cache**: Redis only (no in-process cache, by decision), in-flight coalescing, an optional cross-process
  Redis lock, and a separate one-shot cache-warmer.
- **Compact engine results**: the engine returns about 9 KB of indices and minutes instead of about 260 KB
  of rendered journeys; the API renders only the returned page from its own copy of the timetable.
- **Infra** (`deploy/`, see `deploy/README.md`): Terraform for the 10 hosts and the k6 host, ECR images,
  `inventory.json` (host → roles), `render.ts` (one compose file per host from the inventory and a
  variant), `deploy.sh`, `k6.sh`, and `controller.sh` (experiments run on the k6 host in tmux).
- **Load testing** (`loadtest/`): k6 workloads (`uniform`, `zipf`, `heavy`, `session`) and scenarios
  (`smoke`, `load`, `breakpoint`, `spike`, `soak`, `closed`), a local 4-worker rehearsal stack, the
  experiment catalogue and runner (`experiments.ts`, `run.ts`), `analyze.ts` and `pack.ts`.

These are described in the README ("Scaling architecture", "Load testing", "Scaling study on AWS").

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
- **E4 LB strategy.** Round robin, random, least-outstanding, power-of-two-choices, consistent-hash and
  least-reported (worker-reported load), under uniform and heavy workloads, on the API layout chosen in E8. Query cost varies 7 ms to 200+ ms, so smart balancing should matter.
- **E5 Where to balance.** nginx upstream (least_conn) directly to workers vs the Node pool doing it.
  *Not run*: only the API can render the engine's compact journeys.
- **E6 Heterogeneous pools.** Split into a fast pool and a slow pool based on a predicted query cost,
  vs one shared pool. *Not run*: no cost predictor or pool split exists.
- **E7 Hedged requests** ("Tail at Scale"). Duplicate a request to a second worker after p95 ms. Measure the
  p99 gain against the extra load.

API tier and bottleneck shift:
- **E8 Node tier scaling.** One Node process or a cluster of 2, on 1, 2, 3 or 4 API instances (each extra one
  taken from the worker instances: 16, 14, 12, 10 workers). Find when the bottleneck moves from the workers
  to Node. Amdahl in practice. The study continues on `gw2-cluster2` (2 API hosts × 2 processes, 14
  workers), except E2, E3 and E14, which need the default layout.
- **E9 Payload cost.** The engine returns compact journeys and the API renders only the returned page.
  Compare the page size the client asks for (`limit` 10 vs 50) and gzip at nginx on or off. Measure bytes
  per request and API CPU per request. (The images from before the compact format cannot be deployed with
  this tooling, so there is no "before" variant.)

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

## Report

`docs/load-test-report.md` holds the setup and the explanations; `docs/load-test/results.md`, the charts and
`summary-table.csv` are generated by `node loadtest/analyze.ts`. Sections: goals, environment, architecture,
method, one section per experiment (question, setup, result, explanation), summary of findings, recommended
configuration, threats to validity, cost.

## Status

Everything above is built. E1 has run. The remaining runs follow `docs/next_sequence_commands.md`; the
procedure is `docs/experiment-runbook.md`. Tear down with `terraform destroy` between sessions to save cost.

## Verification

- `routing-engine/build/engine_tests`, `cd api && npm test && npx tsc --noEmit`, `cd scripts && npm test`,
  `node --test loadtest/test/*.test.ts`.
- Correctness across variants: a fixed set of 200 queries returns identical route signatures from every
  configuration (`loadtest/verify-results.ts`).
- On AWS, every variant must pass smoke with 0 errors before measurement. Repeats should agree within about
  10 %; otherwise rerun and report the spread.
