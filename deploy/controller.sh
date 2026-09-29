#!/usr/bin/env bash
# Use the k6 instance as the study's controller: it runs loadtest/run.ts (deploys, k6, fault actions,
# Prometheus snapshots, logs) inside tmux and keeps the results, so the laptop's internet connection
# can drop at any time without stopping an experiment. Run from the laptop, in the repo root:
#
#   deploy/controller.sh setup              once per k6 host, and again after the study hosts are recreated
#   deploy/controller.sh push               copy deploy/ and loadtest/ (code, inventory, image tag) to it
#   deploy/controller.sh exec <cmd ...>     push, then run a short command there in the foreground,
#                                           e.g. exec deploy/deploy.sh smoke, exec deploy/k6.sh smoke
#   deploy/controller.sh run <EXP> [...]    push, then start node loadtest/run.ts <EXP> [...] in tmux
#   deploy/controller.sh status             running or not, and the last lines of its log (TAIL=30)
#   deploy/controller.sh attach             watch the run live (detach with Ctrl-b d; it keeps running)
#   deploy/controller.sh pull [EXP]         copy loadtest/results/ (or one experiment) to the laptop
#   deploy/controller.sh shell              interactive shell in the controller's checkout
#
# The checkout on the k6 host is ~/final_rail (no .git: push writes the commit to deploy/.git-commit).
# Results live in ~/final_rail/loadtest/results/ on the k6 host; push never touches them. Pull them
# before destroying the k6 host: the laptop's copy is the archive between sessions, and setup copies it
# back to a new k6 host (so run.ts still skips finished repeats). Env: SSH_KEY as for deploy/deploy.sh.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
dir=final_rail   # relative to the k6 host's home
session=study
cmd="${1:?usage: controller.sh <setup|push|exec|run|status|attach|pull|shell> [args]}"
shift

# Inside tmux on the k6 host (started by `run`): the experiment itself, logged to controller.log.
if [[ "$cmd" == _job ]]; then
  cd "$root"
  mkdir -p loadtest/results
  export K6_LOCAL=1
  {
    echo "=== $(date -u +%FT%TZ) node loadtest/run.ts $*"
    status=0
    node loadtest/run.ts "$@" || status=$?
    echo "=== $(date -u +%FT%TZ) exit $status"
  } 2>&1 | tee -a loadtest/results/controller.log
  exit 0
fi

inv="$here/inventory.json"
[[ -f "$inv" ]] || { echo "deploy/inventory.json is missing: run node deploy/inventory.ts" >&2; exit 1; }
k6_ip="$(jq -r '.k6.public_ip // empty' "$inv")"
[[ -n "$k6_ip" ]] || { echo "inventory.json has no k6 host: apply deploy/terraform/k6, rerun deploy/inventory.ts" >&2; exit 1; }

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new
          -o "UserKnownHostsFile=$here/.known_hosts" -o ServerAliveInterval=30)
[[ -n "${SSH_KEY:-}" ]] && ssh_opts+=(-i "$SSH_KEY")
k6() { ssh "${ssh_opts[@]}" "ubuntu@$k6_ip" "$@"; }
k6_tty() { if [[ -t 0 ]]; then ssh -t "${ssh_opts[@]}" "ubuntu@$k6_ip" "$@"; else k6 "$@"; fi; }
log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }

push() {
  git -C "$root" describe --always --dirty > "$here/.git-commit" 2>/dev/null || echo unknown > "$here/.git-commit"
  k6 "mkdir -p $dir/deploy $dir/loadtest"
  # Excluded paths are also kept on the far side: the controller's deploy state (.out/<variant>,
  # .out/current), its known_hosts and its results survive every push.
  rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude /terraform/ --exclude /.known_hosts \
    --include /.out/ --include /.out/image-tag --exclude '/.out/*' "$here/" "ubuntu@$k6_ip:$dir/deploy/"
  rsync -az --delete -e "ssh ${ssh_opts[*]}" --exclude /results/ --exclude node_modules/ --exclude /local/ \
    "$root/loadtest/" "ubuntu@$k6_ip:$dir/loadtest/"
  log "pushed $(cat "$here/.git-commit") to $k6_ip:~/$dir"
}

case "$cmd" in
  setup)
    log "installing Node 24, tmux, zip on the k6 host"
    k6 'set -e
      for i in $(seq 60); do [ -f /var/lib/railway-ready ] && break; sleep 5; done
      [ -f /var/lib/railway-ready ] || { echo "first boot not finished" >&2; exit 1; }
      if ! node --version 2>/dev/null | grep -q "^v24\."; then
        curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
        sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs >/dev/null
      fi
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends tmux zip jq rsync openssl >/dev/null
      [ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C railway-k6-controller -f ~/.ssh/id_ed25519
      echo "node $(node --version), docker $(docker --version | cut -d" " -f3 | tr -d ,)"'
    pub="$(k6 'cat ~/.ssh/id_ed25519.pub')"
    log "authorizing the controller's key on the study hosts"
    while read -r name ip; do
      ssh "${ssh_opts[@]}" "ubuntu@$ip" "grep -qxF '$pub' ~/.ssh/authorized_keys || echo '$pub' >> ~/.ssh/authorized_keys" \
        < /dev/null || { echo "could not reach $name ($ip) from here" >&2; exit 1; }
    done < <(jq -r '.hosts[] | "\(.name) \(.public_ip)"' "$inv")
    push
    if [[ -d "$root/loadtest/results" ]]; then
      # the laptop's archive of earlier sessions, so finished repeats are skipped; never overwrites
      rsync -az --ignore-existing -e "ssh ${ssh_opts[*]}" "$root/loadtest/results/" "ubuntu@$k6_ip:$dir/loadtest/results/"
      log "copied the laptop's loadtest/results/ to the controller (existing files kept)"
    fi
    log "checking SSH from the controller to every study host"
    jq -r '.hosts[] | "\(.name) \(.public_ip)"' "$inv" | k6 "cd $dir && bad=0
      while read -r name ip; do
        ssh -n -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new \
          -o UserKnownHostsFile=deploy/.known_hosts ubuntu@\$ip true 2>/dev/null \
          || { echo \"cannot SSH to \$name (\$ip): is port 22 open to k6_cidr? (terraform apply in deploy/terraform/main)\"; bad=1; }
      done
      exit \$bad"
    log "controller ready: deploy/controller.sh exec deploy/deploy.sh smoke"
    ;;
  push)
    push
    ;;
  exec)
    [[ $# -gt 0 ]] || { echo "usage: controller.sh exec <cmd ...>" >&2; exit 2; }
    push
    k6_tty "cd $dir && K6_LOCAL=1 $(printf '%q ' "$@")"
    ;;
  run)
    [[ $# -gt 0 ]] || { echo "usage: controller.sh run <EXP> [run.ts args]" >&2; exit 2; }
    if k6 "tmux has-session -t $session 2>/dev/null"; then
      echo "an experiment is already running on the controller: deploy/controller.sh status / attach" >&2
      exit 1
    fi
    push
    k6 "cd $dir && tmux new-session -d -s $session $(printf '%q' "deploy/controller.sh _job $(printf '%q ' "$@")")"
    log "started in tmux on $k6_ip: node loadtest/run.ts $*"
    log "the laptop may disconnect now; follow with deploy/controller.sh status or attach"
    ;;
  status)
    k6 "cd $dir && if tmux has-session -t $session 2>/dev/null; then echo 'controller: experiment running'
      else echo 'controller: idle'; fi
      tail -n ${TAIL:-30} loadtest/results/controller.log 2>/dev/null || echo '(no controller.log yet)'"
    ;;
  attach)
    k6_tty "tmux attach -t $session"
    ;;
  pull)
    sub="${1:+$1/}"
    mkdir -p "$root/loadtest/results/$sub"
    rsync -az -e "ssh ${ssh_opts[*]}" "ubuntu@$k6_ip:$dir/loadtest/results/$sub" "$root/loadtest/results/$sub"
    log "pulled to loadtest/results/$sub"
    ;;
  shell)
    k6_tty "cd $dir && exec bash -l"
    ;;
  *)
    echo "unknown command $cmd (setup|push|exec|run|status|attach|pull|shell)" >&2
    exit 2
    ;;
esac
