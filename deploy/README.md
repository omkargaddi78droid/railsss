# AWS deployment for the scaling study

Everything needed to run the load-test study on 10 × m6i/m7i.large (see `docs/scaling-plan.md`).
The full step-by-step experiment runbook comes later (`docs/experiment-runbook.md`); this file covers
provisioning and deploying one variant.

```
k6 (second account) ──:80──> node09 nginx ──> node09 Node API ──> node01..node08 engines (2 per host, pinned)
        └──── remote write :9090 ──> node10 Prometheus + Grafana (:3000), Redis
every host: node-exporter :9100, cAdvisor :8080 (VPC only)
```

## Pieces

| Path | What |
|---|---|
| `terraform/main/` | VPC, one public subnet, cluster placement group, 10 hosts, security group, ECR repos, instance role for ECR pulls |
| `terraform/k6/` | The k6 load generator in the second account (Elastic IP, SSH from the admin only) |
| `inventory.ts` | Terraform outputs → `inventory.json` (host → roles; gitignored, edit roles by hand) |
| `images.sh` | Builds the engine and API images and pushes them to ECR, tagged with the git commit |
| `render.ts` | Inventory + variant → one compose file per host, Prometheus `file_sd` targets, `plan.json` |
| `deploy.sh` | Renders, copies to `/opt/railway` on each host over SSH, starts services in phases, checks health |
| `k6.sh` | Runs a k6 scenario on the k6 host against the gateway; the summary lands in `loadtest/results/aws/` |
| `variants/*.env` | One file per configuration; `defaults.env` lists and explains every knob |
| `prometheus/prometheus.yml` | Scrape config (targets come from the rendered `file_sd` files) |

Roles: `worker`, `api`, `nginx`, `redis`, `monitoring`. Defaults for 10 hosts: node01–node08 worker,
node09 api + nginx, node10 redis + monitoring. Every host also runs node-exporter and cAdvisor. All
containers use host networking, so no Docker NAT sits in the measured path. Mongo is not deployed: the
API reads stations from the file baked into its image, as in the local rehearsal.

## Prerequisites

- Terraform ≥ 1.6, the AWS CLI (profiles for both accounts), Docker, Node 24, `jq`, `rsync`, `ssh`.
- An SSH key pair (`~/.ssh/id_ed25519.pub` by default; `SSH_KEY=/path/to/private` for the scripts).

## First run

```bash
# 1. k6 host, second account (its Elastic IP is what the main stack allows)
cd deploy/terraform/k6 && cp terraform.tfvars.example terraform.tfvars   # set admin_cidr, aws_profile
terraform init && terraform apply

# 2. study hosts, main account
cd ../main && cp terraform.tfvars.example terraform.tfvars              # admin_cidr, k6_cidr, aws_profile
terraform init && terraform apply

# 3. inventory, images, deploy (from the repo root)
node deploy/inventory.ts
AWS_PROFILE=study deploy/images.sh
deploy/deploy.sh smoke              # 2 workers: cheap sanity check
SEED=$RANDOM deploy/k6.sh smoke
deploy/deploy.sh baseline           # 16 workers
```

`deploy.sh` prints the gateway URL and the Grafana URL and password (user `admin`; the password is
kept in `deploy/.grafana-password`). Prometheus is not public: use
`ssh -L 9090:localhost:9090 ubuntu@<node10 public IP>` and open http://localhost:9090.

## Variants

```bash
deploy/deploy.sh baseline WORKERS=4                    # E1 point; spread = one per host first
deploy/deploy.sh baseline WORKERS=8 WORKER_PLACEMENT=pack
deploy/deploy.sh baseline LB_STRATEGY=p2c NODE_CLUSTER=2
deploy/deploy.sh baseline PREWARM=true                  # runs the cache-warmer after deploy
```

Command-line `KEY=VALUE` pairs override the variant file, which overrides `defaults.env`; unknown keys
are rejected. Each deploy flushes Redis so the variant starts cold (`KEEP_CACHE=1` keeps it).
Containers whose config changes are recreated; engines drain on SIGTERM (`SHUTDOWN_GRACE_MS`), so a
redeploy does not show up as errors. `deploy/.out/current/` holds the deployed `plan.json` and
`variant.env`; `k6.sh` copies both next to each summary.

To move roles, edit `deploy/inventory.json` and deploy again (`API_HOSTS=2` does the common case: the
last worker host becomes a second API host). Exactly one
host may hold `nginx`, `redis` and `monitoring`; `api` may be on several (nginx balances over them).

## Experiments

`loadtest/run.ts` runs one experiment of the catalogue (`loadtest/experiments.ts`, E1–E18 of
`docs/scaling-plan.md`) on top of `deploy.sh` and `k6.sh`. For every variant and repeat (3 by default) it
deploys (which flushes Redis, so each repeat starts cold), runs a smoke test that must pass, applies setup
actions, runs the measured scenario with any timed fault actions (kill workers or Redis, registry join),
restores the stack, then saves Prometheus range queries and container logs for the run's window.

```bash
node loadtest/run.ts --list                         # experiments, questions, params
node loadtest/run.ts E1 --dry-run                   # print every command without running anything
node loadtest/run.ts E1                             # 6 variants x 3 repeats
node loadtest/run.ts E4 CAPACITY=420                # CAPACITY = max RPS within SLO of E1 w16
node loadtest/run.ts E10 CAPACITY=420 --variants redis-s1.1,prewarm-s1.1 --repeats 1
node loadtest/run.ts E17 CAPACITY=420 LB_STRATEGY=p2c NODE_CLUSTER=2   # chosen config for every variant
```

`KEY=VALUE` is an experiment param, a k6 knob (`DURATION=1m` for a quick pass) or a deploy key; k6 and
deploy keys override every variant. Results go to `loadtest/results/<EXP>/<variant>/r<n>/` (`summary.json`,
`meta.json`, `plan.json`, `variant.env`, `smoke/`, `prom/*.json`, `logs/<host>.log`, `deploy.log`, `k6.log`),
plus `loadtest/results/manifest.jsonl` with one line per repeat. A repeat whose `meta.json` has status `ok`
is skipped on a rerun, so an interrupted experiment resumes where it stopped (`--force` redoes it).
E5 (nginx straight to workers) and E6 (cost-split pools) are not runnable yet; `--list` says why.
`node --test loadtest/test/*.test.ts` checks offline that every variant renders on the default inventory.

## Teardown

```bash
terraform -chdir=deploy/terraform/main destroy     # also deletes the ECR images
terraform -chdir=deploy/terraform/k6 destroy
```

Destroy between study sessions: the hosts cost money while idle.
