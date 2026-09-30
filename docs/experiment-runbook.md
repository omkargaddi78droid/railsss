# Scaling study: experiment runbook

This runbook covers the whole study, from an empty AWS account to one zip of results that you give to
`loadtest/analyze.ts` and the analysis LLM (`docs/analysis-llm-prompt.md`), and then to the report
(`docs/load-test-report.md`). The plan and the questions
behind each experiment are in `docs/scaling-plan.md`. The tooling is described in `deploy/README.md`.

All commands run from the repo root on your own machine (the laptop) unless a step says otherwise.
The experiments themselves do **not** run on the laptop: the k6 host is the *controller*. It runs
`loadtest/run.ts` inside `tmux` and keeps the results, so a dropped laptop connection does not stop an
experiment. The laptop provisions, builds images, starts runs with `deploy/controller.sh` and pulls the
results back.

```
laptop                         k6 host = controller (second account)        10 study hosts (main account)
  terraform, images.sh  ──ssh──> ~/final_rail (pushed code)                   node01..08 engines (2 per host)
  deploy/controller.sh           tmux: loadtest/run.ts ──ssh──> deploy.sh,    node09 nginx + Node API
  loadtest/pack.ts                 fault actions, snapshots, logs             node10 Redis + Prometheus + Grafana
  Grafana in the browser         grafana/k6 ──:80──> node09, ──:9090 remote write──> node10
                                 ~/final_rail/loadtest/results/ (the results)
```

## 0. Budget and time

- 11 × m7i-flex.large total (10 study hosts + 1 for k6), all on demand. That is roughly US$1.2 per hour;
  check current prices for your region. Terraform destroys everything, including the ECR images.
- The full catalogue with 3 repeats is about 24 hours of machine time (table in section 5), so about
  US$30 in instances. Do it over several sessions and destroy the stack between them. Results are written
  on the k6 host; `deploy/controller.sh pull` copies them to the laptop, which keeps them between sessions
  (section 8), and `run.ts` resumes where it stopped.
- To save money, do a first pass of everything with `--repeats 1`. Then repeat only the experiments you
  will report on. `run.ts` skips repeats that are already done, so a later run without `--repeats` only
  adds r2 and r3.

## 1. Prerequisites (once)

1. **Two AWS accounts**: the *main* account runs the 10 study hosts; the *k6* account runs the load
   generator. Create an AWS CLI profile for each (`aws configure --profile study`, `--profile k6-account`).
2. **vCPU quota**: in the main account, Service Quotas → EC2 → "Running On-Demand Standard (A, C, D, H, I,
   M, R, T, Z) instances" must be at least **20** vCPUs in the region. In the k6 account it must be at
   least **4**. New accounts often have less, and an increase can take a day.
3. Tools on the laptop: Terraform ≥ 1.6, AWS CLI v2, Docker (with buildx), Node 24, `jq`, `rsync`,
   `ssh`, `zip`, `git`. The k6 host gets its own tools (Node 24, tmux, jq, rsync) from
   `deploy/controller.sh setup` (section 2).
4. An SSH key pair. The default is `~/.ssh/id_ed25519(.pub)`. For another key, set `ssh_public_key_path`
   in both tfvars and export `SSH_KEY=/path/to/private/key` before running the scripts. The laptop's
   private key never leaves the laptop: `controller.sh setup` gives the k6 host its own key and authorizes
   it on the study hosts.
5. Your public IP: `curl -s https://checkip.amazonaws.com`. If it changes (new network), update
   `admin_cidr` in both tfvars and run `terraform apply` again.
6. Offline check that the catalogue is consistent: `node --test loadtest/test/*.test.ts` (all pass).

## 2. Provision (each session)

```bash
# k6 host, second account (its Elastic IP is the only client the study hosts accept on :80)
cd deploy/terraform/k6
cp -n terraform.tfvars.example terraform.tfvars     # set admin_cidr = "<your IP>/32", aws_profile = "k6-account"
terraform init && terraform apply

# study hosts, main account
cd ../main
cp -n terraform.tfvars.example terraform.tfvars     # admin_cidr, k6_cidr (below), aws_profile = "study"
terraform -chdir=../k6 output -raw k6_cidr          # paste into k6_cidr
terraform init && terraform apply
cd ../../..

node deploy/inventory.ts                            # -> deploy/inventory.json (hosts, roles, k6 IP)
AWS_PROFILE=study deploy/images.sh                  # build + push engine and API images (tag = git commit)
deploy/controller.sh setup                          # k6 host: Node 24 + tmux, its SSH key on the study hosts,
                                                    # code pushed, laptop results copied back, SSH checked
```

Keep the checkout clean (commit first). The image tag is `git describe --dirty`, and it is recorded in
every result (the k6 host has no `.git`; `controller.sh push` writes the laptop's commit to
`deploy/.git-commit` there). The hosts need 2–4 minutes after `apply` for first-boot setup; `setup` and
`deploy.sh` wait for it. The main stack's security group lets the k6 Elastic IP (`k6_cidr`) in on SSH, since
the controller deploys and injects faults; if `setup` says it cannot SSH to a study host, run
`terraform apply` in `deploy/terraform/main` again. Run `setup` again whenever the study hosts are
recreated (their new `authorized_keys` does not have the controller's key yet).

## 3. Sanity check (each session, before any experiment)

```bash
deploy/controller.sh exec deploy/deploy.sh smoke            # 2 workers; prints gateway URL, Grafana URL, password
deploy/controller.sh exec env SEED=$RANDOM deploy/k6.sh smoke   # 20 requests, must end with k6 exit 0
deploy/controller.sh exec node loadtest/run.ts E1 --dry-run  # shows exactly what E1 will do
```

`exec` pushes the code, then runs the command on the k6 host in the foreground (it stops if the laptop
disconnects, which is fine for these short checks). The deployed state (`deploy/.out/current`) now lives
on the k6 host, so run `deploy.sh` and `k6.sh` through `controller.sh exec`, not on the laptop.

Open Grafana (`http://<node10 public IP>:3000`, user `admin`, password in `deploy/.grafana-password`),
dashboard "Railway scaling", and check that the panels show the smoke run: k6 RPS, API rate, and the two
workers. Prometheus is not public. For its UI, run `ssh -L 9090:localhost:9090 ubuntu@<node10 IP>` and
open http://localhost:9090.

If `deploy.sh` fails, read `deploy/.out/<variant>/deploy-<host>.log` on the k6 host
(`deploy/controller.sh shell`). If `k6.sh smoke` fails, fix the problem before running experiments, because
every experiment starts with the same smoke test.

## 4. How `run.ts` runs an experiment

```bash
deploy/controller.sh exec node loadtest/run.ts --list         # ids, questions, params
deploy/controller.sh run <EXP> [PARAM=… | K6_KNOB=… | DEPLOY_KEY=…] [--variants a,b] [--repeats n] [--suffix s] [--force]
deploy/controller.sh status                                   # running or idle + the last 30 log lines (TAIL=100)
deploy/controller.sh attach                                   # live output; Ctrl-b d detaches, the run goes on
deploy/controller.sh pull [EXP]                               # copy results to the laptop's loadtest/results/
```

`controller.sh run` pushes the current code and starts `node loadtest/run.ts <args>` on the k6 host in a
tmux session called `study`, with its output appended to `loadtest/results/controller.log` there. From then
on the laptop may sleep or lose its connection; check back with `status`. Only one experiment runs at a
time (`run` refuses while `study` is running). Results are written on the k6 host; `pull` whenever you
want a copy on the laptop (it never deletes anything). In the rest of this runbook, "run `E4 …`" means
`deploy/controller.sh run E4 …`.

For each variant and repeat, `run.ts` does the following:
1. **Deploy.** It runs `deploy.sh`, which flushes Redis so that every repeat starts cold, runs the
   cache-warmer if `PREWARM=true`, and checks health.
2. **Smoke.** It runs the smoke test with a random seed. A failed smoke skips the rest of that variant.
3. **Setup.** It runs the variant's setup actions, if any.
4. **Measure.** It runs the measured k6 scenario. Its TESTID is `<exp>-<variant>-r<n>` (lower case),
   which is also the value of `testid` in Grafana. The SEED is fixed, so repeats send identical queries.
   Timed fault actions run beside the scenario.
5. **Restore.** It restarts killed workers or Redis and re-registers all workers.
6. **Save evidence.** It saves 33 Prometheus series (5 s step, the run's window ± 15 s) and the container
   logs of every host.

Exit code 99 from k6 means "thresholds crossed". That is the normal ending of a breakpoint or overload run
and counts as `ok`. A failed deploy stops `run.ts`. Fix the cause and rerun the same `controller.sh run`
command: finished repeats are skipped. The same applies if the k6 host itself was restarted.

**Params.** `CAPACITY` is the maximum RPS within the SLO (p99 < 500 ms, errors < 0.1 %) of the layout the
experiment runs on (section 6). Every fixed-rate experiment scales its load from it. Other params have
defaults (`--list`). Since the study continues on `gw2-cluster2` after E8 (section 5), there are two:
`C16` from E1 `w16` (default layout: 16 workers, 1 API process) and `C14` from E8 `gw2-cluster2`
(14 workers, 2 API hosts × 2 processes).

**Overrides.** A deploy key (for example `NODE_CLUSTER=2`) or a k6 knob (for example `DURATION=1m`) on the
command line applies to every variant. Use this for E17 (the chosen config), or for a quick trial. Do not
override the key that an experiment varies. When you rerun variants with a different config, add
`--suffix <s>`: results then go to `<variant>-<s>/`, so they neither overwrite nor get skipped as already done.

### Result layout (written by `run.ts` on the k6 host, never edit by hand)

```
loadtest/results/
  controller.log                       output of every controller.sh run (start line, run.ts log, exit)
  manifest.jsonl                       one line per attempt (failed ones too)
  <EXP>/experiment.json                resolved catalogue entry: question, params, overrides, variants
  <EXP>/<variant>/r<n>/
    meta.json        experiment, variant, repeat, testid, status, deploy overrides, scenario, k6 env,
                     params, actions + their timings (events), started_at/ended_at, git commit,
                     image tag, instance type, region, worker count, k6 exit code, controller host
    summary.json     k6 --summary-export of the measured run
    plan.json        hosts, roles, worker URLs, gateway (what was deployed)
    variant.env      every resolved deploy knob
    smoke/summary.json
    prom/<series>.json   Prometheus query_range results (query, start, end, step, response)
    logs/<host>.log  docker compose logs of every host for the window
    deploy.log, k6.log, k6-smoke.log
  screenshots/<EXP>/...   your Grafana screenshots (section 7; on the laptop)
  notes.md                your own observations (optional, packed too; on the laptop)
```

## 5. The experiments, in order

Run E1 first: it gives `C16`. Then E8, which gives `C14`. The order after that is a suggestion. Times are
per repeat, including the deploy (about 1–2 min each).

**Study decision: after E8 the study runs on `gw2-cluster2`** (`API_HOSTS=2 NODE_CLUSTER=2`: node08 and
node09 run the API with 2 processes each, 14 workers on node01–node07). Every run below marked "gw2" gets
`API_HOSTS=2 NODE_CLUSTER=2` on the command line and `CAPACITY=<C14>`. E2, E3 and E14 stay on the default
layout (reasons in the E8 section). The exact commands, in order, are in `docs/next_sequence_commands.md`.

Every command in the table is started with `deploy/controller.sh run` (for example
`deploy/controller.sh run E4 CAPACITY=420 API_HOSTS=2 NODE_CLUSTER=2`); the table shows only the arguments,
with `<gw2>` standing for `API_HOSTS=2 NODE_CLUSTER=2`.

| Order | Exp | Layout | Arguments | Variants | Time (3 repeats) |
|---|---|---|---|---|---|
| 1 | E1 (done) | default | `E1` | w1 w2 w4 w8 w12 w16 | ≈ 2 h |
| 2 | E8 | varies | `E8` | gw1/gw2/gw3/gw4 × cluster1/2 | ≈ 3 h |
| 3 | E2 | default | `E2` | spread-8hosts, pack-4hosts, unpinned-8hosts | ≈ 1 h |
| 4 | E3 | default | `E3` | c1/c2 × t1/t2/t4 | ≈ 2 h |
| 5 | E4 | gw2 | `E4 CAPACITY=<C14> <gw2>` | 6 LB strategies × uniform/heavy | ≈ 3 h |
| 6 | E7 | gw2 | `E7 CAPACITY=<C14> <gw2>` | hedge-off/100/250 | ≈ 45 min |
| 7 | E9 | gw2 | `E9 MAX_RATE=<1.5 × C14> <gw2>` | page 10/50 × gzip off/on | ≈ 1.5 h |
| 8 | E10 | gw2 | `E10 CAPACITY=<C14> <gw2>` | nocache/redis/prewarm × s 0/0.8/1.1/1.4 | ≈ 3 h |
| 9 | E11 | gw2 | `E11 CAPACITY=<C14> <gw2>` | no-coalesce, coalesce, redis-lock | ≈ 25 min |
| 10 | E15 | gw2 | `E15 MAX_RATE=<1.5 × C14> <gw2>` | K 10/20/50 × labels 200k/500k | ≈ 2 h |
| 11 | E12 | gw2 | `E12 CAPACITY=<C14> <gw2>` | 4 policies × 1.5×/2× | ≈ 1.5 h |
| 12 | E13 | gw2 | `E13 CAPACITY=<C14> <gw2>` | kill1, kill4, kill8, kill-redis | ≈ 1.5 h |
| 13 | E14 | default | `E14 CAPACITY=<C16>` | join, static8, static16 | ≈ 1 h |
| 14 | E16 | gw2 | `E16 CAPACITY=<C14> <gw2>` | open, closed | ≈ 30 min |
| 15 | E18 | gw2 | `E18 CAPACITY=<C14> <gw2>` | u20 … u100 | ≈ 1.5 h |
| 16 | E17 | gw2 + best | `E17 CAPACITY=<C'> <gw2> <best config>` | spike (3×), soak (60 min, 1×) | ≈ 1.5 h |

E5 (nginx balancing straight to workers) and E6 (cost-split pools) are not runnable. The code they need
does not exist; `--list` says why. Report them as not done.

For each experiment below: **look at** means what to watch live in Grafana (set `testid` to the run),
and **gather** means what to add beyond what `run.ts` saves automatically.

### E1 Worker count scaling (breakpoint, uniform, 5 min ramp to 50 × workers + 50 RPS)
- Look at: the k6 RPS at the moment p99 crosses 500 ms (the run aborts about 15 s later); per-worker
  engine RPS (should be even); host CPU of worker hosts vs node09. If node09 (API) is near 100 % while
  workers idle, the Node tier is the wall, not the workers. That is expected above about 8 workers with
  one API process.
- Gather: one screenshot per variant of "Host CPU busy / nginx connections" + "Latency (k6 client)" at the abort point.
- **Then** set `CAPACITY` to the max RPS within the SLO of `w16` (median of the repeats, section 6). If the
  ramp ended at `MAX_RATE` without aborting, rerun that variant with `PER_WORKER_RPS=80 --force`.

### E8 Node tier scaling (breakpoint)
- Look at: node09 CPU and the API container's CPU (`node09-api`) vs workers. Each extra API host is taken
  from the end of the worker hosts:

  | Variant | API hosts | Workers |
  |---|---|---|
  | `gw1-*` | node09 | 16 |
  | `gw2-*` | node08, node09 | 14 |
  | `gw3-*` | node07–node09 | 12 |
  | `gw4-*` | node06–node09 | 10 |

  Does the max RPS move once Node is no longer the wall, and where does losing workers start to cost more
  than adding API hosts gains?
- Gather: screenshots of "CPU cores by container" for the API hosts.
- **The study continues on `gw2-cluster2`** (decided up front; write it in `notes.md`). After E8:
  - `C14` = max RPS within the SLO of `E8/gw2-cluster2` (median of the repeats, section 6). That run *is*
    the capacity measurement of the new layout: same deployment and workload (uniform) as E1 `w16` plus the
    layout knobs, so no separate E1 rerun is needed. If its ramp reached `MAX_RATE` (900) without aborting,
    rerun it with a higher ceiling: `E8 --variants gw2-cluster2 MAX_RATE=1400 --force`.
  - Pass `API_HOSTS=2 NODE_CLUSTER=2` and `CAPACITY=<C14>` to every later run except E2, E3 and E14.
  - Breakpoint experiments with a fixed `MAX_RATE` (E9, E15) get `MAX_RATE` ≈ 1.5 × `C14`, so the ramp
    passes the knee.
  - Stay on the default layout (no `API_HOSTS`/`NODE_CLUSTER`) for:
    - E2: `unpinned-8hosts` needs 8 worker hosts (only 7 are left), and `spread-8hosts` would put HT
      siblings on one host. E2 is about placement, not the API tier.
    - E3: it varies `ENGINE_THREADS` down to 1. `ENGINE_CONCURRENCY` is per API process, so 4 processes
      open up to 4 × c sockets per worker; with fewer engine threads than sockets, requests stall for the
      keep-alive timeout. E3 is about one pool and one engine, so keep one API process.
    - E14: it starts with 8 workers and adds the other 8, which needs 16 (with 14, `static8`'s registry
      would name stopped workers). Use `C16`.
  - E13 on gw2: `kill8` kills 8 of 14 workers (57 %), not half. Note it; expect 429s after the kill
    (60 % load on 6 of 14 workers ≈ 140 % of what is left).
- Points to keep in mind on gw2-cluster2 (for `notes.md` and the report):
  - 4 API processes each have their own pool. `ENGINE_CONCURRENCY=2` is per process, so a worker can get up
    to 8 concurrent requests (= `ENGINE_THREADS=8`) on one vCPU, where the default layout gave 2. Do not
    raise `ENGINE_CONCURRENCY` without raising `ENGINE_THREADS` to at least 4 × it.
  - `MAX_QUEUE=auto` is also per process (each allows 14 × 2 in flight + the same again queued), so 429s
    start later than on the default layout (E12).
  - `least_outstanding` (the default strategy) only sees each process's own requests. E4 compares it with
    `least_reported`. Keep the default for the other experiments so they stay comparable; the E4 winner goes
    into E17's best config.
  - Capacities from different layouts are not directly comparable: 16 vs 14 workers.

### E2 Placement and hyperthreading (breakpoint, 8 workers; default layout)
- Look at: engine p50/p99 per worker. HT siblings (`pack-4hosts`) should be slower per request than one
  per host.
- Gather: "Route time p50 / p99 per worker" screenshot per variant.

### E3 Threads per worker and pool concurrency (breakpoint; default layout)
- Look at: `c1-t1` should not stall (the admin port serves health checks). `c2-t1` queues inside the
  engine (the second request waits for the only thread). Compare engine in-flight vs API outstanding.
- Gather: "In flight per worker" and "Pool in flight / queued per worker" screenshots.

### E4 LB strategy (fixed load, 70 % of CAPACITY; heavy mix at 70 % of CAPACITY/2 by default)
- Run it with the E8 layout (`API_HOSTS`/`NODE_CLUSTER`). Each API process balances with only its own
  counts, so with several processes `least_outstanding` and `p2c` see part of the load. `least_reported`
  adds the load the workers report on every reply (`X-Inflight` header, `in_flight` in `/health`), fading
  with `LB_REPORT_DECAY_MS` (default 500). With one API process (`gw1-cluster1`) it should match `least_outstanding`.
- Look at: p99 and max per strategy, and outstanding per worker. `round_robin`/`random` pile up behind slow
  queries on the heavy mix; `least_outstanding`/`p2c` should not. Compare the spread of engine in-flight
  across workers ("In flight per worker") for `least_outstanding`, `p2c` and `least_reported`: the more even,
  the more precise the balancing.
- Gather: "Pool in flight / queued per worker" screenshot for the heavy mix of each strategy. If the heavy-mix
  runs are far from the SLO (all failing or all trivially fine), measure the heavy capacity with
  `DURATION=…` trials and pass `HEAVY_CAPACITY=<n>`.

### E7 Hedged requests (fixed load, heavy mix)
- Look at: pool events `hedge` / `hedge_win` (panel "Pool events/s (retry, hedge, 429)"), p99 vs `hedge-off`, and the extra
  engine RPS that hedging adds.
- Gather: the "Pool events/s" screenshot.

### E9 Payload cost (breakpoint)
- Look at: network bytes per request (`data_received` in the summary), API CPU per request, and the max RPS.
  gzip trades API-side bytes for nginx CPU.
- Gather: nothing extra.

### E10 Cache (fixed load, zipf)
- Look at: the cache hit ratio over time (panel "Cache lookups/s by outcome": `remote_hit` vs `miss`), and latency for cached vs
  uncached. For the prewarm variants, check `deploy.log`: the warmer's line shows how long it took and how
  many searches it made. That run time is part of the answer.
- Gather: the "Cache lookups/s by outcome" screenshot for s = 1.1 of each tag.

### E11 Cache stampede (30 s, zipf s = 3, cold start, 2 API processes)
- Look at: engine requests vs k6 requests during the first seconds, and cache events `coalesced` /
  `lock_wait`. Without coalescing, the engine receives many duplicates of the same query.
- Gather: nothing extra (the `api_cache_events` and `engine_requests` counters are saved).

### E15 K and label budget (breakpoint)
- Look at: max RPS vs `route_search_complete` (summary) and budget hits per second.
- Gather: nothing extra.

### E12 Overload (fixed load at 1.5× and 2× CAPACITY, 2 min)
- Look at: goodput (200/s) vs offered load, 429 rate (pool event `rejected`), latency. `queue-auto` should answer fast 429s;
  `queue-unlimited` should collapse into 5 s timeouts; `retry-storm` should make it worse.
- Gather: the "API requests/s by status" screenshot per variant.

### E13 Failure injection (fixed load 60 %, 5 min; kill at 60 s, restart at 180 s)
- Look at: the time from the kill to the workers being marked unhealthy (`api_worker_healthy`), the error
  burst, and the recovery after the restart. On gw2 (14 workers) `kill8` removes 57 % of the capacity
  (expect 429s at 60 % load → about 140 % of what is left). `kill-redis` should fail open: more engine work, no errors.
- Gather: "Worker health / errors" and "Failed rate / 429s / VUs" screenshots around t = 60 s and t = 180 s. The actual action
  times are in `meta.json` `events`.

### E14 Elastic scaling (fixed load 70 %, 5 min; 8 workers, the other 8 join at 60 s; default layout, `C16`)
- Look at: the worker set grows from 8 to 16 (panel "Route requests/s per worker"; the API's "engine worker
  set changed" log line is at info level, which the study's `LOG_LEVEL=warn` hides). Measure the time until p99
  is back under the SLO. `static8` and `static16` are the two bounds.
- Gather: the "Route requests/s per worker" screenshot of `join`.

### E16 Closed vs open loop (3 min at 80 % load)
- Look at: the same throughput, but the closed-model p99 looks better, because the load waits while the
  server is slow (coordinated omission). If the achieved RPS of `closed` differs a lot from `open`, rerun
  `closed` with `VUS=<n>` (N = X × R).
- Gather: nothing extra.

### E18 Little's law (load sweep 20–100 % of CAPACITY)
- Look at: API in-flight vs RPS × mean latency, and latency growth near 100 %.
- Gather: nothing extra (in-flight, RPS and latency series are saved).

### E17 Spike and soak on the chosen configuration
- Choose the best config from E4/E7/E9/E10/E12 on top of gw2, for example
  `API_HOSTS=2 NODE_CLUSTER=2 LB_STRATEGY=least_reported`. Measure its capacity `C'` first by rerunning the
  E8 layout variant with the extra knobs: `deploy/controller.sh run E8 --variants gw2-cluster2 --suffix best
  MAX_RATE=<1.5 × C14> <extra knobs>` (saved as `E8/gw2-cluster2-best`, next to `gw2-cluster2`, which gave
  `C14`; the variant already sets the layout). Then run `deploy/controller.sh run E17 CAPACITY=<C'> <config>`.
- Look at: spike: time after the spike until p99 and queue return to the pre-spike level. Soak: memory of
  engines, API and Redis over 60 min (flat, or growing?), and latency drift.
- Gather: "Memory by container" screenshot over the full soak; the spike's latency panel.

## 6. Reading CAPACITY from a breakpoint run

```bash
deploy/controller.sh pull E8
node loadtest/analyze.ts                  # -> docs/load-test/results.md, summary-table.csv, charts
```

Read "Max RPS within SLO, median" for the variant in `docs/load-test/results.md` (E1 `w16` gives `C16`, E8
`gw2-cluster2` gives `C14`) and round it down to a multiple of 10. The rule: the highest achieved RPS before
the SLO is broken for two consecutive 5 s steps (API p99 ≥ 500 ms, or more than 0.1 % non-2xx answers).
- A value shown as "≥ n" means the ramp ended at `MAX_RATE` before the SLO broke: rerun that variant with a
  higher ceiling.
- The `http_reqs.rate` of `summary.json` is the *average* over the whole ramp. Do not use it as capacity.
- To check by eye: in Grafana, read the k6 RPS at the moment the run starts failing.

## 7. Grafana screenshots

- Dashboard "Railway scaling": pick the `testid` of the run, set the time range to the run
  (`started_at`/`ended_at` in `meta.json`, or use the k6 panel to zoom), then use Share → Export → Save as
  image, or a normal screenshot.
- Save them as `loadtest/results/screenshots/<EXP>/<variant>-r<n>-<panel>.png`, for example
  `screenshots/E13/kill4-r1-worker-healthy.png`.
- The evidence that counts is in `prom/*.json`. Screenshots are for the report and for sanity. The ones
  listed under "gather" are enough.

## 8. Ending a session

```bash
deploy/controller.sh status                        # must say idle: destroying mid-run loses that repeat
deploy/controller.sh pull                          # FIRST: results exist only on the k6 host until pulled
terraform -chdir=deploy/terraform/main destroy     # also deletes ECR images
terraform -chdir=deploy/terraform/k6 destroy       # deletes the k6 host's disk, results included
```

The laptop's `loadtest/results/` is the archive between sessions. At the next session `controller.sh
setup` copies it to the new k6 host (never overwriting), so `run.ts` still skips the finished repeats.

At the start of the next session, repeat sections 2–3 (including `controller.sh setup`). The new hosts get
new IPs; that is fine, because every result records the plan it ran on. Rebuild the images only if the code changed. If it did, every
later result carries the new git commit, so note that in `notes.md`.

## 9. Packing the results

```bash
deploy/controller.sh pull                 # the latest results from the k6 host
node loadtest/pack.ts                     # on the laptop -> study-results-<date>.zip in the repo root (gitignored)
```

Pack on the laptop: the screenshots and `notes.md` are there, next to the pulled results.

Zip layout:

```
study-results/
  manifest.json          generated_at, git_commit, environment {region, instance_type, hosts, roles},
                         slo {p99_ms: 500, error_rate_max: 0.001}, experiments {E1: {ok, not_ok}, …},
                         runs [ {path, …meta.json fields} ]   (one per repeat folder)
  attempts.jsonl         every attempt, including failed ones
  environment/           inventory.json, git.txt, defaults.env, experiments.ts (the catalogue as run)
  experiments/<EXP>/     experiment.json and <variant>/r<n>/ exactly as in section 4
  screenshots/           your Grafana images
  notes.md               your notes (decisions such as "after E8: gw2-cluster2, C14 = …")
```

## 10. Writing the report

1. `node loadtest/analyze.ts` regenerates `docs/load-test/` (tables, charts, `summary-table.csv`). Run it
   after every `pull`: a broken run shows up while the hosts are still there.
2. Give the zip plus `docs/analysis-llm-prompt.md` to an LLM. It writes explanations and its own figures;
   compare its numbers with `docs/load-test/results.md`.
3. Fill in the "Explanation" parts, the summary table, the recommended configuration and the cost in
   `docs/load-test-report.md`, then commit `docs/`.

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `controller.sh`: SSH to the k6 host times out | your IP changed: set `admin_cidr` in `deploy/terraform/k6/terraform.tfvars` (and main), `terraform apply`. A running experiment is not affected |
| `controller.sh setup`: "cannot SSH to nodeNN" | the main security group does not allow the k6 IP on port 22 yet (`terraform apply` in `deploy/terraform/main`), or `k6_cidr` is not the k6 Elastic IP |
| `run.ts` on the controller: `ssh …: Permission denied (publickey)` | study hosts were recreated after `setup`: run `deploy/controller.sh setup` again |
| `controller.sh run`: "already running" | an experiment is in progress (`status`, `attach`). To stop it: `attach`, then Ctrl-c; if a fault run (E13/E14) was cut, `exec deploy/deploy.sh baseline` restarts the stopped containers |
| `controller.sh status` says idle, log ends without `exit` | the k6 host rebooted: rerun the same `controller.sh run` command (finished repeats are skipped) |
| `deploy.sh`: "first boot not finished" | user_data still running or failed: `ssh ubuntu@<ip> sudo tail /var/log/cloud-init-output.log` |
| `deploy.sh`: `compose pull` denied | images not pushed for this tag (`deploy/.out/image-tag`), or the instance role is missing: rerun `images.sh` |
| API container restarting | engine timetable hash differs from the API's (images from different commits): rebuild both with `images.sh` |
| k6 smoke: connection refused / timeout | `k6_cidr` in main tfvars is not the k6 Elastic IP; or nginx not up (`deploy-node09.log`) |
| No k6 panels in Grafana | remote write blocked: SG allows :9090 from the k6 IP only; check `k6.log` for write errors |
| All requests `cached: true`, engines idle | same SEED against a warm Redis; `run.ts` flushes on every deploy, ad-hoc `k6.sh` runs need `SEED=$RANDOM` |
| A repeat marked `k6-failed` | k6 itself crashed (not a threshold); read `k6.log` (pull, or `controller.sh shell`), rerun the command (only that repeat reruns) |
| E13/E14 left workers stopped | `run.ts` restores after each run; if it was interrupted, `deploy/controller.sh exec deploy/deploy.sh baseline` starts them again |
