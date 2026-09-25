#!/usr/bin/env bash
# Run one k6 scenario from the k6 instance (other account) against the deployed gateway, pushing
# samples to the study's Prometheus by remote write, and fetch the end-of-test summary.
#
#   deploy/k6.sh <smoke|load|breakpoint|spike|soak|closed> [extra k6 args]
#   SEED=$RANDOM RATE=100 DURATION=3m deploy/k6.sh load
#
# Knobs are the same env vars as loadtest/local/k6.sh (see loadtest/k6/). The summary lands in
# loadtest/results/aws/<TESTID>/summary.json; TESTID also tags every sample in Prometheus.
# Reruns with the same SEED send the same queries, so they are cache hits unless Redis was flushed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
scenario="${1:?usage: k6.sh <scenario> [k6 args]}"
shift
plan="$here/.out/current/plan.json"
[[ -f "$plan" ]] || { echo "nothing deployed yet (deploy/.out/current is missing)" >&2; exit 1; }
k6_ip="$(jq -r '.k6.public_ip // empty' "$here/inventory.json")"
[[ -n "$k6_ip" ]] || { echo "inventory.json has no k6 host: apply deploy/terraform/k6, rerun deploy/inventory.ts" >&2; exit 1; }

testid="${TESTID:-$scenario-$(date +%Y%m%d-%H%M%S)}"
gateway="$(jq -r .gateway.public_url "$plan")"
prom="http://$(jq -r .monitoring.public_ip "$plan"):9090/api/v1/write"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
          -o "UserKnownHostsFile=$here/.known_hosts")
[[ -n "${SSH_KEY:-}" ]] && ssh_opts+=(-i "$SSH_KEY")

envs=(-e "TESTID=$testid" -e "BASE_URL=$gateway" -e "K6_PROMETHEUS_RW_SERVER_URL=$prom"
      -e "K6_PROMETHEUS_RW_TREND_STATS=p(50),p(90),p(99),max" -e "K6_PROMETHEUS_RW_PUSH_INTERVAL=5s")
for v in WORKLOAD SEED ZIPF_S HEAVY_FRAC DATE PAGE_SIZE THINK_S ITERATIONS RATE DURATION PRE_VUS MAX_VUS \
         START_RATE MAX_RATE BASE_RATE SPIKE_RATE SPIKE_FOR HOLD VUS; do
  if [[ -n "${!v:-}" ]]; then envs+=(-e "$v=${!v}"); fi
done

rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude results --exclude node_modules --exclude local \
  "$root/loadtest/" "ubuntu@$k6_ip:/opt/loadtest/"
ssh "${ssh_opts[@]}" "ubuntu@$k6_ip" "mkdir -p /opt/loadtest/results/aws/$testid"
# k6 exits non-zero when a threshold fails; still fetch the summary
status=0
cmd=(docker run --rm --network host --user 1000:1000 -v /opt/loadtest:/loadtest -w /loadtest "${envs[@]}"
     grafana/k6:latest run --out experimental-prometheus-rw --summary-export "results/aws/$testid/summary.json"
     "k6/scenarios/$scenario.js" "$@")
ssh "${ssh_opts[@]}" "ubuntu@$k6_ip" "$(printf '%q ' "${cmd[@]}")" || status=$?
mkdir -p "$root/loadtest/results/aws/$testid"
rsync -az -e "ssh ${ssh_opts[*]}" "ubuntu@$k6_ip:/opt/loadtest/results/aws/$testid/" "$root/loadtest/results/aws/$testid/"
cp "$plan" "$here/.out/current/variant.env" "$root/loadtest/results/aws/$testid/"
echo "summary: loadtest/results/aws/$testid/summary.json (k6 exit $status)"
exit $status
