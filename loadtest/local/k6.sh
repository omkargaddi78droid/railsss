#!/usr/bin/env bash
# Run one k6 scenario against the local rehearsal stack (compose.yml), pushing samples to its
# Prometheus and saving the end-of-test summary.
#
#   loadtest/local/k6.sh <smoke|load|breakpoint|spike|soak|closed> [extra k6 args]
#   WORKLOAD=zipf ZIPF_S=1.1 RATE=40 DURATION=1m loadtest/local/k6.sh load
#
# Scenario and workload knobs are read from the environment (see loadtest/k6/). The summary lands in
# loadtest/results/local/<TESTID>/summary.json; TESTID also tags every sample in Prometheus.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
scenario="${1:?usage: k6.sh <scenario> [k6 args]}"
shift
testid="${TESTID:-$scenario-$(date +%Y%m%d-%H%M%S)}"
out="results/local/$testid"
mkdir -p "$here/../$out"

envs=(-e "TESTID=$testid")
for v in WORKLOAD SEED ZIPF_S HEAVY_FRAC DATE PAGE_SIZE THINK_S ITERATIONS RATE DURATION PRE_VUS MAX_VUS \
         START_RATE MAX_RATE BASE_RATE SPIKE_RATE SPIKE_FOR HOLD VUS BASE_URL; do
  if [[ -n "${!v:-}" ]]; then envs+=(-e "$v=${!v}"); fi
done

docker compose -f "$here/compose.yml" run --rm --no-deps --user "$(id -u):$(id -g)" "${envs[@]}" k6 \
  run --out experimental-prometheus-rw --summary-export "$out/summary.json" "k6/scenarios/$scenario.js" "$@"
echo "summary: loadtest/$out/summary.json"
