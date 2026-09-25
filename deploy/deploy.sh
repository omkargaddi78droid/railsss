#!/usr/bin/env bash
# Deploy one variant to every host of deploy/inventory.json.
#
#   deploy/deploy.sh <variant> [KEY=VALUE ...]      e.g. deploy/deploy.sh baseline WORKERS=4
#
# Steps: render (deploy/render.ts) -> copy each host's files to /opt/railway -> `docker compose up`
# in phases (engines, Redis, monitoring first; then the API; then nginx), waiting for health ->
# flush Redis so the variant starts cold (KEEP_CACHE=1 skips this) -> optional cache-warmer ->
# check every worker and the gateway from inside the VPC. Hosts in one phase deploy in parallel.
# deploy/.out/current points at the deployed variant's files (plan.json, variant.env).
#
# Env: SSH_KEY (private key, default ssh's own), KEEP_CACHE=1, SKIP_PULL=1.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
variant="${1:?usage: deploy.sh <variant> [KEY=VALUE ...]}"
shift

node "$here/render.ts" "$variant" "$@"
out="$here/.out/$variant"
plan="$out/plan.json"

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
          -o "UserKnownHostsFile=$here/.known_hosts" -o ControlMaster=auto -o ControlPersist=120
          -o "ControlPath=/tmp/railway-ssh-%C")
[[ -n "${SSH_KEY:-}" ]] && ssh_opts+=(-i "$SSH_KEY")
rsh() { local ip="$1"; shift; ssh "${ssh_opts[@]}" "ubuntu@$ip" "$@"; }

# Grafana admin password: generated once, kept out of git.
pwfile="$here/.grafana-password"
[[ -s "$pwfile" ]] || { openssl rand -hex 16 > "$pwfile"; chmod 600 "$pwfile"; }

host_field() { jq -r --arg n "$1" ".hosts[] | select(.name == \$n) | .$2" "$plan"; }
hosts_in_phase() { jq -r --argjson p "$1" '.hosts[] | select(.phase == $p) | .name' "$plan"; }

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

# Copy files and start one host's services. Output goes to a per-host log; failures are reported.
deploy_host() {
  local name="$1" ip
  ip="$(host_field "$name" public_ip)"
  {
    rsh "$ip" 'for i in $(seq 120); do [ -f /var/lib/railway-ready ] && exit 0; sleep 5; done; echo "first boot not finished" >&2; exit 1'
    rsync -az --delete -e "ssh ${ssh_opts[*]}" "$out/$name/" "ubuntu@$ip:/opt/railway/" \
      --exclude .env --exclude loadtest --exclude prometheus.yml
    rsync -az --delete -e "ssh ${ssh_opts[*]}" --relative \
      "$root/./loadtest/grafana" "$root/./loadtest/nginx" "ubuntu@$ip:/opt/railway/"
    rsync -az -e "ssh ${ssh_opts[*]}" "$here/prometheus/prometheus.yml" "ubuntu@$ip:/opt/railway/prometheus.yml"
    rsh "$ip" "umask 077; echo GRAFANA_ADMIN_PASSWORD=$(cat "$pwfile") > /opt/railway/.env"
    if [[ -z "${SKIP_PULL:-}" ]]; then rsh "$ip" 'cd /opt/railway && docker compose pull -q'; fi
    rsh "$ip" 'cd /opt/railway && docker compose up -d --remove-orphans --wait --wait-timeout 180'
  } > "$out/deploy-$name.log" 2>&1
}

for phase in 1 2 3; do
  mapfile -t names < <(hosts_in_phase "$phase")
  [[ ${#names[@]} -gt 0 ]] || continue
  log "phase $phase: ${names[*]}"
  pids=()
  for n in "${names[@]}"; do deploy_host "$n" & pids+=($!); done
  failed=0
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "deploy of ${names[$i]} failed; last lines of $out/deploy-${names[$i]}.log:" >&2
      tail -n 20 "$out/deploy-${names[$i]}.log" >&2
      failed=1
    fi
  done
  [[ $failed -eq 0 ]] || exit 1
  if [[ $phase -eq 1 && -z "${KEEP_CACHE:-}" ]]; then
    redis_host="$(jq -r '.hosts[] | select(.roles | index("redis")) | .name' "$plan")"
    rsh "$(host_field "$redis_host" public_ip)" "docker exec $redis_host-redis redis-cli FLUSHALL" > /dev/null
    log "redis flushed"
  fi
done

gw="$(jq -r .gateway.host "$plan")"
gw_ip="$(host_field "$gw" public_ip)"

if [[ "$(jq -r .prewarm "$plan")" == true ]]; then
  wh="$(jq -r .warmer_host "$plan")"
  log "cache-warmer on $wh"
  rsh "$(host_field "$wh" public_ip)" 'cd /opt/railway && docker compose run --rm cache-warmer' 2>&1 | tail -n 3
fi

# Check from inside the VPC: every worker's admin /health and the gateway's /api/health.
log "checking workers and gateway from $gw"
jq -r '.workers[].admin' "$plan" | rsh "$gw_ip" '
  bad=0
  while read -r u; do curl -fsS -m 3 "$u/health" > /dev/null || { echo "unhealthy: $u"; bad=1; }; done
  curl -fsS -m 5 http://127.0.0.1/api/health | head -c 300; echo
  exit $bad'

ln -sfn "$variant" "$here/.out/current"
log "deployed $variant ($(jq '.workers | length' "$plan") workers); gateway $(jq -r .gateway.public_url "$plan"), Grafana http://$(jq -r .monitoring.public_ip "$plan"):3000 (admin / $(cat "$pwfile"))"
