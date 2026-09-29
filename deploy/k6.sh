#!/usr/bin/env bash
# Run one k6 scenario from the k6 instance (other account) against the deployed gateway, pushing
# samples to the study's Prometheus by remote write, and fetch the end-of-test summary.
# From the laptop it syncs loadtest/ to the k6 host and runs k6 there over SSH. With K6_LOCAL=1 (set
# by deploy/controller.sh, which runs everything on the k6 host itself) it runs k6 on this machine.
#
#   deploy/k6.sh <smoke|load|breakpoint|spike|soak|closed> [extra k6 args]
#   SEED=$RANDOM RATE=100 DURATION=3m deploy/k6.sh load
#
# Knobs are the same env vars as loadtest/local/k6.sh (see loadtest/k6/). The summary lands in
# loadtest/results/aws/<TESTID>/summary.json on the machine running this script; TESTID also tags
# every sample in Prometheus.
# RESULT_DIR (absolute) replaces that local destination (loadtest/run.ts uses it).
# Reruns with the same SEED send the same queries, so they are cache hits unless Redis was flushed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
scenario="${1:?usage: k6.sh <scenario> [k6 args]}"
shift
plan="$here/.out/current/plan.json"
[[ -f "$plan" ]] || { echo "nothing deployed yet (deploy/.out/current is missing)" >&2; exit 1; }

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

k6_args=(grafana/k6:latest run --out experimental-prometheus-rw --summary-export /out/summary.json
         "k6/scenarios/$scenario.js" "$@")
dest="${RESULT_DIR:-$root/loadtest/results/aws/$testid}"
mkdir -p "$dest"
# k6 exits non-zero when a threshold fails; still keep the summary
status=0
if [[ -n "${K6_LOCAL:-}" ]]; then
  docker run --rm --network host --user "$(id -u):$(id -g)" -v "$root/loadtest:/loadtest" -v "$dest:/out" \
    -w /loadtest "${envs[@]}" "${k6_args[@]}" || status=$?
else
  k6_ip="$(jq -r '.k6.public_ip // empty' "$here/inventory.json")"
  [[ -n "$k6_ip" ]] || { echo "inventory.json has no k6 host: apply deploy/terraform/k6, rerun deploy/inventory.ts" >&2; exit 1; }
  rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude results --exclude node_modules --exclude local \
    "$root/loadtest/" "ubuntu@$k6_ip:/opt/loadtest/"
  remote_out="/opt/loadtest/results/aws/$testid"
  ssh "${ssh_opts[@]}" "ubuntu@$k6_ip" "mkdir -p $remote_out"
  cmd=(docker run --rm --network host --user 1000:1000 -v /opt/loadtest:/loadtest -v "$remote_out:/out" -w /loadtest
       "${envs[@]}" "${k6_args[@]}")
  ssh "${ssh_opts[@]}" "ubuntu@$k6_ip" "$(printf '%q ' "${cmd[@]}")" || status=$?
  rsync -az -e "ssh ${ssh_opts[*]}" "ubuntu@$k6_ip:$remote_out/" "$dest/"
fi
cp "$plan" "$here/.out/current/variant.env" "$dest/"
echo "summary: $dest/summary.json (k6 exit $status)"
exit $status
