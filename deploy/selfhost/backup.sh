#!/usr/bin/env bash
recipient=${SELFHOST_BACKUP_AGE_RECIPIENT:-}
if [[ -z $recipient && ( -z ${SELFHOST_BACKUP_DIR:-} || ${SELFHOST_BACKUP_PLAINTEXT:-} != 1 ) ]]; then
  echo "Set SELFHOST_BACKUP_AGE_RECIPIENT (or SELFHOST_BACKUP_PLAINTEXT=1 for a local copy)" >&2
  exit 2
fi
source "$(dirname -- "$0")/archive-common.sh"
keep=${SELFHOST_BACKUP_KEEP:-7}
[[ $keep =~ ^[1-9][0-9]*$ ]] || { echo "SELFHOST_BACKUP_KEEP must be positive" >&2; exit 2; }
if [[ -n $recipient ]]; then
  prepare_age
  "$age" -r "$recipient" </dev/null >/dev/null
fi
engine=$("${compose[@]}" ps -q --status running engine)
server=$("${compose[@]}" ps -q --status running server)
[[ -n $engine && -n $server ]] || { echo "Both services must be running for this backup" >&2; exit 1; }
mounted=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/rivet"}}{{.Name}}{{end}}{{end}}' "$engine")
[[ $mounted == "$volume" ]] || { echo "Selected volume differs from the running engine mount" >&2; exit 1; }
image=$(docker inspect --format '{{.Image}}' "$engine")
name="engine-$(date -u +%Y%m%dT%H%M%S.%NZ)-$(cat /proc/sys/kernel/random/uuid).tar.gz"
# The engine's start-up clean-up must finish before the server registers (engine-ready.sh), so the
# server starts only once the engine reports ready, and stays stopped if it never does. The same
# containers restart directly: Compose would refuse the server's dependency on an engine container
# created before the engine had a healthcheck.
start_stack() {
  local deadline=$((SECONDS + ${SELFHOST_ENGINE_READY_TIMEOUT:-1500})) health
  docker start "$engine" >/dev/null || return 1
  while :; do
    # A container created before the engine had a healthcheck gets the same probe directly.
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$engine") || return 1
    if [[ -z $health ]]; then
      docker exec -i "$engine" bash -s -- "${SELFHOST_ENGINE_SETTLE_SECONDS:-120}" <"$kit/engine-ready.sh" >/dev/null && health=healthy
    fi
    [[ $health == healthy ]] && break
    if [[ $health == unhealthy ]] || (( SECONDS >= deadline )); then
      echo "The engine is not ready (${health:-no answer}); the server stays stopped" >&2
      return 1
    fi
    sleep 5
  done
  docker start "$server" >/dev/null
}
restart=1
cleanup() {
  local status=$?
  if (( restart )); then start_stack >&2 || status=1; fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stopped_at=$SECONDS
"${compose[@]}" stop server
"${compose[@]}" stop engine
for id in "$server" "$engine"; do
  state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}' "$id")
  [[ $state == 'exited 0 false' || $state == 'exited 143 false' ]] || { echo "Unclean stop ($state), skipping backup" >&2; exit 1; }
done
docker run --rm --label com.docker.compose.project= --label com.docker.compose.service= --network none --user 0 --entrypoint tar \
  --mount "type=volume,src=$volume,dst=/source,readonly" "$image" \
  -C /source --sparse --numeric-owner -cf - . > "$work/data.tar"
copied_at=$SECONDS
restart=0
# The copy is complete either way: publish it, then report a stack that did not come back.
ready=1
start_stack || ready=0
echo "Stop and volume copy took $((copied_at - stopped_at)) s, engine readiness and server start $((SECONDS - copied_at)) s" >&2
gzip -1 "$work/data.tar"
gzip -t "$work/data.tar.gz"
archive="$work/data.tar.gz"
if [[ -n $recipient ]]; then
  "$age" -r "$recipient" -o "$archive.age" "$archive"
  archive="$archive.age"
  name="$name.age"
fi
if [[ -n ${store:-} ]]; then
  # Atomic publication even when the destination is on a different filesystem.
  partial=$(mktemp "$store/.incoming.XXXXXXXX")
  if ! cp "$archive" "$partial" || ! mv "$partial" "$store/$name"; then rm -f -- "$partial"; exit 1; fi
  find "$store" -maxdepth 1 -type f -printf '%f\0' > "$work/list"
else
  "${s3[@]}" s3 cp "$archive" "s3://$bucket/$project/$name" --only-show-errors
  "${s3[@]}" s3api list-objects-v2 --bucket "$bucket" --prefix "$project/engine-" --output json > "$work/objects"
  python3 -c 'import json,sys; sys.stdout.buffer.writelines(x["Key"].split("/",1)[1].encode()+b"\0" for x in json.load(open(sys.argv[1])).get("Contents",[]))' "$work/objects" > "$work/list"
fi
LC_ALL=C sort -zr "$work/list" > "$work/sorted"
n=0
while IFS= read -r -d '' old; do
  archive_name "$old" || continue
  n=$((n + 1))
  if (( n > keep )); then
    if [[ -n ${store:-} ]]; then rm -- "$store/$old"
    else "${s3[@]}" s3api delete-object --bucket "$bucket" --key "$project/$old" >/dev/null
    fi
  fi
done < "$work/sorted"
echo "$name"
(( ready ))
