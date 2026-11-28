#!/usr/bin/env bash
# Engine readiness, run inside the engine container by its Compose healthcheck.
# Usage: engine-ready.sh [settle-seconds] [proven-seconds] [idle-seconds]
#
# Rivet 3.1.1 answers /health within seconds of starting, but the first command that touches the
# active-envoy index after a start (an actor alarm, a node registration) first runs a one-time
# clean-up of that index. A server that registers during it can miss its 30 s registration window.
# Commands that wait on the clean-up are cancelled by their callers or hit the storage command
# deadline, and the engine counts both on its metrics port (6430, loopback is enough).
#
# Ready means /health answers and those counts have stopped moving:
#  - for proven-seconds (default 15) once a list-active-envoys command has completed in this
#    process, which proves the clean-up finished;
#  - for idle-seconds (default 30) while no actor or index command has completed, none was
#    cancelled and none is in flight, as on a new install: nothing has started the clean-up, and on
#    a new install there is nothing to clean up;
#  - otherwise for settle-seconds (default 120). Over 20 minutes of an engine whose clean-up never
#    finishes, these counts never stood still for more than 17 s.
# Steadiness is counted from this container's checks. Once ready, the engine stays ready for the
# life of its process: later checks only ask /health, so an occasional slow command never marks a
# running engine unhealthy. The image has bash but no curl, so this uses /dev/tcp.
set -uo pipefail
settle=${1:-120} proven=${2:-15} idle=${3:-30}
[[ $settle =~ ^[0-9]+$ && $proven =~ ^[0-9]+$ && $idle =~ ^[0-9]+$ ]] || { echo "windows must be whole seconds" >&2; exit 2; }

# HTTP/1.0 GET on loopback; prints the body of a 200 reply and fails otherwise.
get() {
  local status line rc
  exec 3<>"/dev/tcp/127.0.0.1/$1" || return 1
  printf 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' "$2" >&3
  if ! IFS= read -r -t 10 status <&3 || [[ ! $status =~ ^HTTP/1\.[01]\ 200 ]]; then exec 3<&-; return 1; fi
  while IFS= read -r -t 10 line <&3 && [[ $line != $'\r' && -n $line ]]; do :; done
  timeout 10 cat <&3
  rc=$?
  exec 3<&-
  return "$rc"
}

get 6420 /health >/dev/null || { echo "health: no answer"; exit 1; }

# One state file per engine process: a restarted container keeps /tmp, but its new process has a
# new start time (field 22 of /proc/1/stat), and the boot id covers a host restart.
read -r stat </proc/1/stat
read -ra fields <<<"${stat##*) }"
read -r boot </proc/sys/kernel/random/boot_id
state=/tmp/windlass-engine-ready.${boot}.${fields[19]}
if [[ -e $state.ready ]]; then echo "ready"; exit 0; fi

metrics=$(get 6430 /metrics) || { echo "metrics: no answer"; exit 1; }
# Absent series have never counted, so they add nothing.
read -r stalled listed active inflight < <(awk '
  /^rivet_ups_operations_total\{/ && /class="depot_kv_command"/ && /result="(cancelled|timeout)"/ { n += $NF }
  /^rivet_depot_client_command_duration_seconds_count\{/ && /result="deadline"/ { n += $NF }
  /^rivet_depot_client_command_duration_seconds_count\{/ && /command="pegboard\.index\.list-active-envoys"/ && /result="ok"/ { l += $NF }
  /^rivet_depot_client_command_duration_seconds_count\{/ && /command="pegboard\.(actor|index)\./ { a += $NF }
  /^rivet_ups_class_in_use\{/ && /class="depot_kv_command"/ { f += $NF }
  END { printf "%d %d %d %d\n", n, l, a, f }' <<<"$metrics")
if (( listed > 0 )); then window=$proven phase="clean-up done"
elif (( active == 0 && stalled == 0 && inflight == 0 )); then window=$idle phase="idle"
else window=$settle phase="clean-up not seen to finish"
fi
now=$(date +%s)
prev='' since=''
[[ -r $state ]] && read -r prev since <"$state"
if [[ $prev != "$stalled" || ! $since =~ ^[0-9]+$ ]]; then
  echo "$stalled $now" >"$state"
  echo "settling ($phase): $stalled cancelled or timed-out storage commands"
  exit 1
fi
if (( now - since < window )); then
  echo "settling ($phase): $stalled cancelled or timed-out storage commands, steady for $((now - since)) of $window s"
  exit 1
fi
: >"$state.ready"
echo "ready ($phase): $stalled cancelled or timed-out storage commands, steady for $((now - since)) s"
