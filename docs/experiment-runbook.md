# Scaling study: experiment runbook

This runbook covers the whole study, from an empty AWS account to one zip of results that you give to
the analysis LLM (`docs/analysis-llm-prompt.md`) and to `loadtest/analyze.ts`. The plan and the questions
behind each experiment are in `docs/scaling-plan.md`. The tooling is described in `deploy/README.md`.

All commands run from the repo root on your own machine unless a step says otherwise.

```
your machine ──ssh──> 10 study hosts (main account)          k6 host (second account)
  deploy/deploy.sh      node01..08 engines (2 per host)         grafana/k6 ──:80──> node09 nginx
  loadtest/run.ts       node09 nginx + Node API                            └─:9090 remote write─> node10
  loadtest/pack.ts      node10 Redis + Prometheus + Grafana
```

## 0. Budget and time

- 10 × m6i.large (or m7i.large) plus one c6i.xlarge for k6, all on demand. That is roughly US$1.2 per hour in
  ap-south-1; check current prices. Terraform destroys everything, including the ECR images.
- The full catalogue with 3 repeats is about 24 hours of machine time (table in section 5), so about
  US$30 in instances. Do it over several sessions and destroy the stack between them. Results stay on
  your machine, and `run.ts` resumes where it stopped.
- To save money, do a first pass of everything with `--repeats 1`. Then repeat only the experiments you
  will report on. `run.ts` skips repeats that are already done, so a later run without `--repeats` only
  adds r2 and r3.

## 1. Prerequisites (once)

1. **Two AWS accounts**: the *main* account runs the 10 study hosts; the *k6* account runs the load
   generator. Create an AWS CLI profile for each (`aws configure --profile study`, `--profile k6-account`).
2. **vCPU quota**: in the main account, Service Quotas → EC2 → "Running On-Demand Standard (A, C, D, H, I,
   M, R, T, Z) instances" must be at least **20** vCPUs in the region. In the k6 account it must be at
   least **4**. New accounts often have less, and an increase can take a day.
3. Tools on your machine: Terraform ≥ 1.6, AWS CLI v2, Docker (with buildx), Node 24, `jq`, `rsync`,
   `ssh`, `zip`, `openssl`.
4. An SSH key pair. The default is `~/.ssh/id_ed25519(.pub)`. For another key, set `ssh_public_key_path`
   in both tfvars and export `SSH_KEY=/path/to/private/key` before running the scripts.
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
```

Keep the checkout clean (commit first). The image tag is `git describe --dirty`, and it is recorded in
every result. The hosts need 2–4 minutes after `apply` for first-boot setup. `deploy.sh` waits for it.

## 3. Sanity check (each session, before any experiment)

```bash
deploy/deploy.sh smoke                  # 2 workers; prints gateway URL, Grafana URL and admin password
SEED=$RANDOM deploy/k6.sh smoke         # 20 requests, must end with k6 exit 0
node loadtest/run.ts E1 --dry-run       # shows exactly what E1 will do
```

Open Grafana (`http://<node10 public IP>:3000`, user `admin`, password in `deploy/.grafana-password`),
dashboard "Railway scaling", and check that the panels show the smoke run: k6 RPS, API rate, and the two
workers. Prometheus is not public. For its UI, run `ssh -L 9090:localhost:9090 ubuntu@<node10 IP>` and
open http://localhost:9090.

If `deploy.sh` fails, read `deploy/.out/<variant>/deploy-<host>.log`. If `k6.sh smoke` fails, fix the
problem before running experiments, because every experiment starts with the same smoke test.

## 4. How `run.ts` runs an experiment

```bash
node loadtest/run.ts --list                                   # ids, questions, params
node loadtest/run.ts <EXP> [PARAM=… | K6_KNOB=… | DEPLOY_KEY=…] [--variants a,b] [--repeats n] [--suffix s] [--force]
```

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
and counts as `ok`. A failed deploy stops `run.ts`. Fix the cause and rerun the same command: finished
repeats are skipped.

**Params.** `CAPACITY` is the maximum RPS within the SLO (p99 < 500 ms, errors < 0.1 %) of the baseline
(16 workers, defaults). Read it from E1 `w16` (section 6). Every fixed-rate experiment scales its load from
it. Other params have defaults (`--list`).

**Overrides.** A deploy key (for example `NODE_CLUSTER=2`) or a k6 knob (for example `DURATION=1m`) on the
command line applies to every variant. Use this for E17 (the chosen config), or for a quick trial. Do not
override the key that an experiment varies. When you rerun variants with a different config, add
`--suffix <s>`: results then go to `<variant>-<s>/`, so they neither overwrite nor get skipped as already done.

### Result layout (written by `run.ts`, never edit by hand)

```
loadtest/results/
  manifest.jsonl                       one line per attempt (failed ones too)
  <EXP>/experiment.json                resolved catalogue entry: question, params, overrides, variants
  <EXP>/<variant>/r<n>/
    meta.json        experiment, variant, repeat, testid, status, deploy overrides, scenario, k6 env,
                     params, actions + their timings (events), started_at/ended_at, git commit,
                     image tag, instance type, region, worker count, k6 exit code
    summary.json     k6 --summary-export of the measured run
    plan.json        hosts, roles, worker URLs, gateway (what was deployed)
    variant.env      every resolved deploy knob
    smoke/summary.json
    prom/<series>.json   Prometheus query_range results (query, start, end, step, response)
    logs/<host>.log  docker compose logs of every host for the window
    deploy.log, k6.log, k6-smoke.log
  screenshots/<EXP>/...   your Grafana screenshots (section 7)
  notes.md                your own observations (optional, packed too)
```

## 5. The experiments, in order

Run E1 first: it gives `CAPACITY` for most of the others. The order after that is a suggestion. Times are
per repeat, including the deploy (about 1–2 min each).

| Order | Exp | Command | Variants | Time (3 repeats) |
|---|---|---|---|---|
| 1 | E1 | `node loadtest/run.ts E1` | w1 w2 w4 w8 w12 w16 | ≈ 2 h |
| 2 | E8 | `node loadtest/run.ts E8` | gw1/gw2 × cluster1/2 | ≈ 1.5 h |
| 3 | E2 | `node loadtest/run.ts E2` | spread-8hosts, pack-4hosts, unpinned-8hosts | ≈ 1 h |
| 4 | E3 | `node loadtest/run.ts E3` | c1/c2 × t1/t2/t4 | ≈ 2 h |
| 5 | E4 | `node loadtest/run.ts E4 CAPACITY=<c>` | 5 LB strategies × uniform/heavy | ≈ 2.5 h |
| 6 | E7 | `node loadtest/run.ts E7 CAPACITY=<c>` | hedge-off/100/250 | ≈ 45 min |
| 7 | E9 | `node loadtest/run.ts E9` | page 10/50 × gzip off/on | ≈ 1.5 h |
| 8 | E10 | `node loadtest/run.ts E10 CAPACITY=<c>` | nocache/redis/prewarm × s 0/0.8/1.1/1.4 | ≈ 3 h |
| 9 | E11 | `node loadtest/run.ts E11 CAPACITY=<c>` | no-coalesce, coalesce, redis-lock | ≈ 25 min |
| 10 | E15 | `node loadtest/run.ts E15` | K 10/20/50 × labels 200k/500k | ≈ 2 h |
| 11 | E12 | `node loadtest/run.ts E12 CAPACITY=<c>` | 4 policies × 1.5×/2× | ≈ 1.5 h |
| 12 | E13 | `node loadtest/run.ts E13 CAPACITY=<c>` | kill1, kill4, kill8, kill-redis | ≈ 1.5 h |
| 13 | E14 | `node loadtest/run.ts E14 CAPACITY=<c>` | join, static8, static16 | ≈ 1 h |
| 14 | E16 | `node loadtest/run.ts E16 CAPACITY=<c>` | open, closed | ≈ 30 min |
| 15 | E18 | `node loadtest/run.ts E18 CAPACITY=<c>` | u20 … u100 | ≈ 1.5 h |
| 16 | E17 | `node loadtest/run.ts E17 CAPACITY=<c'> <best config>` | spike (3×), soak (60 min, 1×) | ≈ 1.5 h |

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
- Look at: node09 CPU and the API container's CPU (`node09-api`) vs workers. `gw2-*` has 14 workers and 2
  API hosts (node08 becomes an API host). Does the max RPS move once Node is no longer the wall?
- Gather: screenshots of "CPU cores by container" for the gateway hosts. **If cluster2 or gw2 is clearly
  better, consider using it for later runs** (e.g. `node loadtest/run.ts E4 CAPACITY=<c> NODE_CLUSTER=2`)
  and write that down in `notes.md`. In that case, measure `CAPACITY` again with
  `node loadtest/run.ts E1 --variants w16 --suffix cluster2 NODE_CLUSTER=2` (saved as `E1/w16-cluster2`).

### E2 Placement and hyperthreading (breakpoint, 8 workers)
- Look at: engine p50/p99 per worker. HT siblings (`pack-4hosts`) should be slower per request than one
  per host.
- Gather: "Route time p50 / p99 per worker" screenshot per variant.

### E3 Threads per worker and pool concurrency (breakpoint)
- Look at: `c1-t1` should not stall (the admin port serves health checks). `c2-t1` queues inside the
  engine (the second request waits for the only thread). Compare engine in-flight vs API outstanding.
- Gather: "In flight per worker" and "Pool in flight / queued per worker" screenshots.

### E4 LB strategy (fixed load, 70 % of CAPACITY; heavy mix at 70 % of CAPACITY/2 by default)
- Look at: p99 and max per strategy, and outstanding per worker. `round_robin`/`random` pile up behind slow
  queries on the heavy mix; `least_outstanding`/`p2c` should not.
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
  burst, and the recovery after the restart. `kill8` removes half the capacity (expect 429s at 60 % load
  → 120 % of what is left). `kill-redis` should fail open: more engine work, no errors.
- Gather: "Worker health / errors" and "Failed rate / 429s / VUs" screenshots around t = 60 s and t = 180 s. The actual action
  times are in `meta.json` `events`.

### E14 Elastic scaling (fixed load 70 %, 5 min; 8 workers, the other 8 join at 60 s)
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
- Choose the best config from E4/E7/E8/E10/E12, for example `LB_STRATEGY=p2c NODE_CLUSTER=2`. Measure its
  capacity first with `node loadtest/run.ts E1 --variants w16 --suffix best <config>` (saved as
  `E1/w16-best`, next to the baseline). Then run
  `node loadtest/run.ts E17 CAPACITY=<c'> <config>`.
- Look at: spike: time after the spike until p99 and queue return to the pre-spike level. Soak: memory of
  engines, API and Redis over 60 min (flat, or growing?), and latency drift.
- Gather: "Memory by container" screenshot over the full soak; the spike's latency panel.

## 6. Reading CAPACITY from a breakpoint run

After E1 (or any breakpoint), you can compute the max RPS within the SLO in one of two ways.
- Quick: `jq '.metrics.http_reqs.rate' loadtest/results/E1/w16/r*/summary.json` gives the *average* rate
  over the run. This is lower than the rate at the knee. Do not use it as capacity.
- Correct: in Grafana, find the time when the API p99 (panel "API latency") first stays above 500 ms, and
  read the k6 RPS at that moment. Or read it from `prom/api_latency_p99.json` and `prom/k6_rps.json`.
  Take the median of the three repeats, rounded down to a multiple of 10. `loadtest/analyze.ts`
  and the LLM prompt compute this for the report. For the runs, a reasonable reading by eye is enough.

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
terraform -chdir=deploy/terraform/main destroy     # also deletes ECR images
terraform -chdir=deploy/terraform/k6 destroy
```

At the start of the next session, repeat sections 2–3. The new hosts get new IPs; that is fine, because
every result records the plan it ran on. Rebuild the images only if the code changed. If it did, every
later result carries the new git commit, so note that in `notes.md`.

## 9. Packing the results

```bash
node loadtest/pack.ts                     # -> study-results-<date>.zip in the repo root (gitignored)
```

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
  notes.md               your notes (decisions such as "E4 onwards with NODE_CLUSTER=2")
```

Give the zip plus `docs/analysis-llm-prompt.md` to the analysis LLM. Run `loadtest/analyze.ts` on the same
results (Step 7) and compare the two.

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `deploy.sh`: "first boot not finished" | user_data still running or failed: `ssh ubuntu@<ip> sudo tail /var/log/cloud-init-output.log` |
| `deploy.sh`: `compose pull` denied | images not pushed for this tag (`deploy/.out/image-tag`), or the instance role is missing: rerun `images.sh` |
| API container restarting | engine timetable hash differs from the API's (images from different commits): rebuild both with `images.sh` |
| k6 smoke: connection refused / timeout | `k6_cidr` in main tfvars is not the k6 Elastic IP; or nginx not up (`deploy-node09.log`) |
| No k6 panels in Grafana | remote write blocked: SG allows :9090 from the k6 IP only; check `k6.log` for write errors |
| All requests `cached: true`, engines idle | same SEED against a warm Redis; `run.ts` flushes on every deploy, ad-hoc `k6.sh` runs need `SEED=$RANDOM` |
| A repeat marked `k6-failed` | k6 itself crashed (not a threshold); read `k6.log`, rerun the command (only that repeat reruns) |
| E13/E14 left workers stopped | `run.ts` restores after each run; if it was interrupted, `deploy/deploy.sh baseline` starts them again |
