# Next sequence of commands (E8 to the end)

Starting point: E1 is done. From here on, E8 runs in full (gw1–gw4 × cluster1/2), and then the rest of
the study runs on **`gw2-cluster2`** (`API_HOSTS=2 NODE_CLUSTER=2`: node08 and node09 run the API with 2
processes each, 14 workers on node01–node07). The reasons, and what to look at during each run, are in
`docs/experiment-runbook.md` (sections 5 and E8).

Run everything from the repo root on the laptop. Rules for every step:
- `deploy/controller.sh run …` starts the experiment on the k6 host and returns immediately. Only one
  experiment runs at a time, so every `run` is followed by `wait_idle` (defined in step 1), which waits
  until `deploy/controller.sh status` says idle. `deploy/controller.sh attach` shows it live from another
  terminal (Ctrl-b d detaches). The laptop may sleep during `wait_idle`; just run it again.
- After each experiment: `deploy/controller.sh pull <EXP>`, then `node loadtest/analyze.ts` and a look at
  `docs/load-test/results.md` (a broken run shows up while the hosts are still there), take the screenshots
  listed in the runbook, and add a line to `loadtest/results/notes.md`.
- If a run stops (deploy failed, k6 host restarted), fix the cause and rerun the **same** command:
  finished repeats are skipped.
- To save money, add `--repeats 1` to every run for a first pass, then run the same commands again
  without it to add r2 and r3.
- Before destroying the stack, always `pull` (section "End of a session"). Results live only on the k6
  host until pulled.

## 0. Once: rebuild the images (the code changed after E1)

Since E1 the engine sends `X-Inflight` and the API has the `least_reported` strategy, so both images must be
rebuilt. The image tag is the git commit: check that the checkout is clean first (`git status`), and commit
if it is not.

```bash
node --test loadtest/test/*.test.ts                 # all pass
AWS_PROFILE=study deploy/images.sh                  # new engine + API images; writes deploy/.out/image-tag
deploy/controller.sh push                           # new code and image tag to the k6 host
deploy/controller.sh exec deploy/deploy.sh smoke
deploy/controller.sh exec env SEED=$RANDOM deploy/k6.sh smoke   # must end with k6 exit 0

cat >> loadtest/results/notes.md <<'EOF'
- Images rebuilt after E1 (new commit): engine adds the X-Inflight header and in_flight in /health, API adds
  LB_STRATEGY=least_reported. The default strategy (least_outstanding) behaves as before.
EOF
```

## 1. Capacity of the default layout (from E1), and a wait helper

Read `C16` = max RPS within the SLO of `E1/w16` from `docs/load-test/results.md` (median of the repeats,
rounded down to a multiple of 10; runbook section 6).

`wait_idle` blocks until the controller has finished the current experiment, so each block below can be
pasted as a whole. Define it again in every new terminal.

```bash
export C16=<number>

wait_idle() { until deploy/controller.sh status | grep -q 'controller: idle'; do sleep 120; done; echo "idle: $(date)"; }
```

## 2. E8 Node tier scaling (all 8 variants, ≈ 3 h)

```bash
deploy/controller.sh run E8
wait_idle
deploy/controller.sh pull E8
```

Read `C14` = max RPS within the SLO of `E8/gw2-cluster2` (median of the repeats). That run is the capacity
of the chosen layout. If its ramp reached 900 RPS without aborting, the ceiling was too low: rerun it
higher and read `C14` from the rerun.

```bash
# only if gw2-cluster2 never crossed the SLO:
deploy/controller.sh run E8 --variants gw2-cluster2 MAX_RATE=1400 --force
wait_idle
deploy/controller.sh pull E8

export C14=<number>
export GW2="API_HOSTS=2 NODE_CLUSTER=2"
export MAXR=$(( C14 * 3 / 2 ))                      # breakpoint ceiling for E9 and E15

cat >> loadtest/results/notes.md <<EOF
- From E8 on the study runs on gw2-cluster2 (API_HOSTS=2 NODE_CLUSTER=2, 14 workers), except E2, E3 and E14
  (default layout). C16 = $C16 (E1 w16), C14 = $C14 (E8 gw2-cluster2).
EOF
```

`GW2` is left unquoted in the commands below on purpose, so it splits into its two `KEY=VALUE` arguments.
If you open a new terminal, run the `export` lines again.

## 3. Default-layout experiments (no CAPACITY needed)

E2 needs 8 worker hosts, and E3 needs one API process. See the runbook's E8 section for why.

```bash
deploy/controller.sh run E2                         # ≈ 1 h
wait_idle
deploy/controller.sh pull E2

deploy/controller.sh run E3                         # ≈ 2 h
wait_idle
deploy/controller.sh pull E3
```

## 4. gw2-cluster2 experiments

```bash
deploy/controller.sh run E4 CAPACITY=$C14 $GW2      # ≈ 3 h, 6 LB strategies incl. least_reported
wait_idle
deploy/controller.sh pull E4

deploy/controller.sh run E7 CAPACITY=$C14 $GW2      # ≈ 45 min, hedging
wait_idle
deploy/controller.sh pull E7

deploy/controller.sh run E9 MAX_RATE=$MAXR $GW2     # ≈ 1.5 h, page size × gzip
wait_idle
deploy/controller.sh pull E9

deploy/controller.sh run E10 CAPACITY=$C14 $GW2     # ≈ 3 h, cache × zipf
wait_idle
deploy/controller.sh pull E10

deploy/controller.sh run E11 CAPACITY=$C14 $GW2     # ≈ 25 min, stampede
wait_idle
deploy/controller.sh pull E11

deploy/controller.sh run E15 MAX_RATE=$MAXR $GW2    # ≈ 2 h, K × label budget
wait_idle
deploy/controller.sh pull E15

deploy/controller.sh run E12 CAPACITY=$C14 $GW2     # ≈ 1.5 h, overload
wait_idle
deploy/controller.sh pull E12

deploy/controller.sh run E13 CAPACITY=$C14 $GW2     # ≈ 1.5 h, failures (kill8 = 8 of 14 workers)
wait_idle
deploy/controller.sh pull E13
```

E4: if the heavy-mix runs are all failing or all trivially fine, find the heavy capacity with short trials
and rerun with `HEAVY_CAPACITY=<n>` (runbook E4).

## 5. E14 on the default layout (needs 16 workers, uses C16)

```bash
deploy/controller.sh run E14 CAPACITY=$C16          # ≈ 1 h
wait_idle
deploy/controller.sh pull E14
```

## 6. More gw2-cluster2 experiments

```bash
deploy/controller.sh run E16 CAPACITY=$C14 $GW2     # ≈ 30 min, open vs closed loop
wait_idle
deploy/controller.sh pull E16

deploy/controller.sh run E18 CAPACITY=$C14 $GW2     # ≈ 1.5 h, load sweep
wait_idle
deploy/controller.sh pull E18
```

E16: if `closed` reaches a very different RPS from `open`, rerun it with `VUS=<n>` (N = X × R):
`deploy/controller.sh run E16 CAPACITY=$C14 $GW2 VUS=<n> --variants closed --suffix vus --repeats 3`.

## 7. E17 on the best configuration

Choose the winners on top of gw2 and write them in `notes.md`: the strategy from E4, hedging from E7,
gzip from E9, `MAX_QUEUE` from E12. Only add knobs that were clearly better; leave the rest at their
defaults. Example:

```bash
export BEST="LB_STRATEGY=least_reported"            # extra knobs only; the layout comes from GW2

# capacity of the best config: the gw2-cluster2 variant again, with the extra knobs
deploy/controller.sh run E8 --variants gw2-cluster2 --suffix best MAX_RATE=$MAXR $BEST
wait_idle
deploy/controller.sh pull E8
export CBEST=<number>                               # max RPS within the SLO of E8/gw2-cluster2-best

deploy/controller.sh run E17 CAPACITY=$CBEST $GW2 $BEST   # ≈ 1.5 h: spike ×3, 60 min soak ×1
wait_idle
deploy/controller.sh pull E17

cat >> loadtest/results/notes.md <<EOF
- E17 best config: $GW2 $BEST, capacity C' = $CBEST (E8 gw2-cluster2-best).
EOF
```

## 8. Analyse, pack, write the report

```bash
wait_idle
deploy/controller.sh pull
node loadtest/analyze.ts                            # -> docs/load-test/ (results.md, charts, summary-table.csv)
node loadtest/pack.ts                               # -> study-results-<date>.zip in the repo root
```

Give the zip and `docs/analysis-llm-prompt.md` to an LLM for the explanations, write them into
`docs/load-test-report.md`, and commit `docs/` (runbook section 10).

## End of a session (at any point between experiments)

```bash
deploy/controller.sh status                         # must be idle: destroying mid-run loses that repeat
deploy/controller.sh pull                           # FIRST
terraform -chdir=deploy/terraform/main destroy
terraform -chdir=deploy/terraform/k6 destroy
```

## Start of the next session

Follow runbook sections 2 and 3: apply both stacks, and paste the new `k6_cidr` into the main tfvars if
the k6 Elastic IP changed. In short:

```bash
terraform -chdir=deploy/terraform/k6 apply
terraform -chdir=deploy/terraform/k6 output -raw k6_cidr   # must match k6_cidr in deploy/terraform/main/terraform.tfvars
terraform -chdir=deploy/terraform/main apply
node deploy/inventory.ts
AWS_PROFILE=study deploy/images.sh                  # ECR was destroyed with the stack; same commit = same tag
deploy/controller.sh setup                          # copies the laptop's results back, so finished repeats are skipped
deploy/controller.sh exec deploy/deploy.sh smoke
deploy/controller.sh exec env SEED=$RANDOM deploy/k6.sh smoke
export C16=<…> C14=<…> GW2="API_HOSTS=2 NODE_CLUSTER=2" MAXR=<…>   # values from notes.md
```

Then continue with the next experiment above.
