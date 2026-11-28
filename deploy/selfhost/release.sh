#!/usr/bin/env bash
# Releases the checked-out commit to a running self-host stack: builds the server image, takes a backup when the
# newest one is too old, then replaces only the server. The engine is replaced only when its image or its Compose
# definition changed, and then with the server stopped: the engine runs its start-up clean-up alone, and the server
# starts once the engine reports ready (engine-ready.sh). On failure the previous release is put back.
#
#   deploy/selfhost/release.sh <stack env file>
#
# Settings (environment):
#   SELFHOST_RELEASE_HISTORY_DIR      where the previous env file is kept (default: <env dir>/history)
#   SELFHOST_RELEASE_LOG_DIR          build, up and outgoing-server logs (default: <env dir>/release-logs)
#   SELFHOST_RELEASE_MIN_FREE_GB      refuse below this much free disk (default 40)
#   SELFHOST_RELEASE_BACKUP_CMD       the backup to run before a release (default: deploy/selfhost/backup.sh <env>)
#   SELFHOST_RELEASE_BACKUP_DIR       where backups land, to judge the newest one's age (default: SELFHOST_BACKUP_DIR)
#   SELFHOST_RELEASE_BACKUP_MAX_AGE_HOURS  skip the backup when one this recent exists (default 6; 0 always backs up)
#   SELFHOST_RELEASE_ENGINE_WAIT      seconds to wait for a replaced engine to report ready (default 1500)
#   SELFHOST_RELEASE_SERVER_WAIT      seconds to wait for the server to be healthy (default 300)
#   SELFHOST_RELEASE_DRY_RUN=1        print the plan and change nothing
set -euo pipefail

env_file=$(realpath "${1:?usage: release.sh <stack env file>}")
kit=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$kit/../.." && pwd)
cd "$root"
env_dir=$(dirname "$env_file")
history=${SELFHOST_RELEASE_HISTORY_DIR:-$env_dir/history}
logs=${SELFHOST_RELEASE_LOG_DIR:-$env_dir/release-logs}
min_free=${SELFHOST_RELEASE_MIN_FREE_GB:-40}
max_age=${SELFHOST_RELEASE_BACKUP_MAX_AGE_HOURS:-6}
engine_wait=${SELFHOST_RELEASE_ENGINE_WAIT:-1500}
server_wait=${SELFHOST_RELEASE_SERVER_WAIT:-300}
dry=${SELFHOST_RELEASE_DRY_RUN:-0}
mkdir -p "$history" "$logs"

say() { echo "release: $*"; }
die() { echo "release FAILED: $*" >&2; exit 1; }
setting() { grep -E "^$1=" "$env_file" | tail -1 | cut -d= -f2-; }
dc() { docker compose --env-file "$1" -f "$kit/compose.yaml" "${@:2}"; }

rel=$(git rev-parse --short=7 HEAD)
project=$(setting COMPOSE_PROJECT_NAME)
cur=$(setting SELFHOST_RELEASE)
node=$(setting RIVET_NODE_VERSION)
etag=$(setting SELFHOST_ENGINE_TAG)
[[ -n $project ]] || die "COMPOSE_PROJECT_NAME is not set in $env_file"
[[ -n $etag ]] || die "SELFHOST_ENGINE_TAG is not set in $env_file; tag the engine image once and set it (README: Engine readiness)"
[[ $node =~ ^[0-9]+$ ]] || die "RIVET_NODE_VERSION is not a number in $env_file"
docker image inspect "$project-engine:$etag" >/dev/null 2>&1 || die "no engine image $project-engine:$etag"

free=$(df --output=avail -BG "$root" | tail -1 | tr -dc 0-9)
if (( free < min_free )) && [[ $dry != 1 ]]; then
  docker builder prune -f --filter until=6h >/dev/null
  free=$(df --output=avail -BG "$root" | tail -1 | tr -dc 0-9)
fi
(( free >= min_free )) || die "only $free GB free (need $min_free)"
[[ $cur != "$rel" ]] || { say "already on $rel"; exit 0; }

# The engine is replaced only when the running container's image or Compose definition differs from what this
# release's Compose would create.
engine_changed() { # env file
  local id
  id=$(dc "$1" ps -aq engine)
  [[ -n $id ]] || return 0
  [[ $(docker inspect -f '{{.Image}}' "$id") != "$(docker image inspect -f '{{.Id}}' "$project-engine:$etag")" ]] ||
    [[ $(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$id") != "$(dc "$1" config --hash engine | awk '{print $2}')" ]]
}

# The newest backup's age in hours, or a large number when there is none.
backup_age_hours() {
  local dir=${SELFHOST_RELEASE_BACKUP_DIR:-${SELFHOST_BACKUP_DIR:-}} newest
  [[ -n $dir && -d $dir ]] || { echo 999999; return; }
  newest=$(find "$dir" -maxdepth 2 -type f -name 'engine-*.tar.gz*' ! -name '*.sha256' ! -name '*.offsite' -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
  [[ -n $newest ]] || { echo 999999; return; }
  echo $(( ($(date +%s) - ${newest%.*}) / 3600 ))
}

next=$(mktemp "$env_dir/.release-env.XXXXXX")
trap 'rm -f "$next"' EXIT
cp -p "$env_file" "$next"
sed -i "s/^SELFHOST_RELEASE=.*/SELFHOST_RELEASE=$rel/; s/^RIVET_NODE_VERSION=.*/RIVET_NODE_VERSION=$((node + 1))/" "$next"

age=$(backup_age_hours)
backup=1
if (( max_age > 0 && age < max_age )); then backup=0; fi
if engine_changed "$next"; then plan_engine=replace; else plan_engine=keep; fi
say "$cur -> $rel (node version $((node + 1))), $free GB free, engine $etag: $plan_engine, newest backup ${age} h old: $( ((backup)) && echo 'back up first' || echo 'no new backup')"
if [[ $dry == 1 ]]; then say "dry run: nothing changed"; exit 0; fi

dc "$next" build server > "$logs/build-$rel.log" 2>&1 || die "build failed, see $logs/build-$rel.log"
docker image inspect "$project-server:$rel" >/dev/null || die "the build left no $project-server:$rel"

if (( backup )); then
  if [[ -n ${SELFHOST_RELEASE_BACKUP_CMD:-} ]]; then
    bash -c "$SELFHOST_RELEASE_BACKUP_CMD" > "$logs/backup-$rel.log" 2>&1 || die "backup failed, see $logs/backup-$rel.log"
  else
    "$kit/backup.sh" "$env_file" > "$logs/backup-$rel.log" 2>&1 || die "backup failed, see $logs/backup-$rel.log"
  fi
fi

# Keep the outgoing server's log: `docker logs` holds only the current container's.
server_id=$(dc "$env_file" ps -aq server)
if [[ -n $server_id ]]; then
  ( umask 077; docker logs "$server_id" > "$logs/server-$cur-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true )
fi

swap() { # env file
  if engine_changed "$1"; then
    say "engine changed: the server stays stopped while the engine starts"
    dc "$1" stop server &&
      dc "$1" up -d --no-build --no-deps --wait --wait-timeout "$engine_wait" engine &&
      dc "$1" up -d --no-build --no-deps --wait --wait-timeout "$server_wait" server
  else
    dc "$1" up -d --no-build --no-deps --wait --wait-timeout "$server_wait" server
  fi
}

cp -p "$env_file" "$history/$(basename "$env_file").bak-$cur"
cp -p "$next" "$env_file"
chmod 600 "$env_file"
if ! swap "$env_file" > "$logs/up-$rel.log" 2>&1; then
  echo "release: up failed, putting $cur back" >&2
  cp -p "$history/$(basename "$env_file").bak-$cur" "$env_file"
  swap "$env_file" >> "$logs/up-$rel.log" 2>&1 || true
  die "see $logs/up-$rel.log"
fi
say "on $rel"
