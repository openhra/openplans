#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
export OPENPLANS_DATA_DIR="${OPENPLANS_DATA_DIR:?Set the external data directory}"
case "${OPENPLANS_GEOCODER_STATE:-}" in tx|fl|nc) ;; *) echo 'Set OPENPLANS_GEOCODER_STATE=tx|fl|nc' >&2; exit 1;; esac
[[ "${OPENPLANS_GEOCODER_SNAPSHOT:-}" =~ ^[0-9]{6}$ ]] || { echo 'Set OPENPLANS_GEOCODER_SNAPSHOT=YYMMDD' >&2; exit 1; }
action="${1:-}"
export OPENPLANS_GEOCODER_VOLUME_DIR="/mnt/openplans-geocoder-$OPENPLANS_GEOCODER_STATE-$OPENPLANS_GEOCODER_SNAPSHOT/postgres"
case "$action" in up|prepare|stop|logs) ;; *) echo 'Usage: geocoder.sh up|prepare|stop|logs' >&2; exit 1;; esac
if [ "$action" = up ]; then
  container=openplans-geocoder-geocoder-1
  current=$(docker --context colima-openplans-big inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/16/main"}}{{.Name}}{{end}}{{end}} {{.State.Running}}' "$container" 2>/dev/null || true)
  if [[ "$current" = *' true' ]] && ! docker --context colima-openplans-big exec "$container" test -f /var/lib/postgresql/16/main/import-finished; then
    expected="openplans-geocoder-$OPENPLANS_GEOCODER_STATE-$OPENPLANS_GEOCODER_SNAPSHOT-ext4 true"
    [ "$current" = "$expected" ] || { echo 'Another unfinished import is running; refusing to replace its container' >&2; exit 1; }
    echo 'Unfinished import is running; container unchanged'
    exit 0
  fi
fi
if [ "$action" = up ] || [ "$action" = prepare ]; then
  # Inspect the VM Docker disk separately from the bind-backed database filesystem.
  free_kib=$(COLIMA_HOME="$OPENPLANS_DATA_DIR/colima" colima --profile openplans-big ssh -- df -Pk /var/lib/docker | awk 'NR==2 {print $4}')
  [ "$free_kib" -ge 42991616 ] || { echo 'VM has less than 41 GiB free; keeping the 40 GiB reserve' >&2; exit 1; }
  host_kib=$(df -Pk "$OPENPLANS_DATA_DIR" | awk 'NR==2 {print $4}')
  [ "$host_kib" -ge 167772160 ] || { echo 'External disk needs 160 GiB free before import, including flatnode staging' >&2; exit 1; }
  python3 src/ingest/geocode/prepare-open.py "$(echo "$OPENPLANS_GEOCODER_STATE" | tr '[:lower:]' '[:upper:]')" --snapshot "$OPENPLANS_GEOCODER_SNAPSHOT"
  flatnode="$OPENPLANS_DATA_DIR/work/open-geocoder/$OPENPLANS_GEOCODER_STATE-$OPENPLANS_GEOCODER_SNAPSHOT-flatnode"
  mkdir -p "$flatnode"
  # Public OSM staging only. The container's Linux UID is not preserved by virtiofs.
  chmod 0777 "$flatnode"
  stamp=$(python3 -c 'import datetime,json,sys; print(datetime.datetime.fromisoformat(json.load(open(sys.argv[1]))["data_timestamp"]).strftime("%Y%m%dT%H%M%SZ"))' \
    "$OPENPLANS_DATA_DIR/raw/open-geocoder/$OPENPLANS_GEOCODER_STATE/$OPENPLANS_GEOCODER_SNAPSHOT/metadata.json")
  shared="$OPENPLANS_DATA_DIR/work/open-geocoder/flatnode-$stamp.file"
  # Every indexed way node is present in the verified input and overwritten on import.
  # Clone the seed to isolate writers; freeze removes only the state's cache file.
  if [ ! -e "$shared" ]; then
    if [ -e "$flatnode/flatnode.file" ]; then ln "$flatnode/flatnode.file" "$shared"; else touch "$shared"; fi
  fi
  if [ ! -e "$flatnode/flatnode.file" ]; then
    if [ "$(uname -s)" = Darwin ]; then cp -c "$shared" "$flatnode/flatnode.file";
    else cp --reflink=auto "$shared" "$flatnode/flatnode.file"; fi
  fi
  chmod 0666 "$shared"
  chmod 0666 "$flatnode/flatnode.file"
  # virtiofs does not preserve PostgreSQL's Linux ownership on macOS. An external
  # sparse ext4 image gives the database Linux semantics without filling the VM disk.
  image="$OPENPLANS_DATA_DIR/work/open-geocoder/$OPENPLANS_GEOCODER_STATE-$OPENPLANS_GEOCODER_SNAPSHOT.ext4"
  mount_dir="${OPENPLANS_GEOCODER_VOLUME_DIR%/postgres}"
  mkdir -p "$OPENPLANS_DATA_DIR/work/open-geocoder"
  COLIMA_HOME="$OPENPLANS_DATA_DIR/colima" colima --profile openplans-big ssh -- sudo sh -s -- "$image" "$mount_dir" "$action" <<'SH'
set -eu
image=$1
mount_dir=$2
action=$3
if [ ! -f "$image" ]; then
  truncate -s 40G "$image.part"
  mkfs.ext4 -q -F -m 0 "$image.part"
  mv "$image.part" "$image"
fi
mkdir -p "$mount_dir"
if ! mountpoint -q "$mount_dir"; then mount -o loop "$image" "$mount_dir"; fi
mkdir -p "$mount_dir/postgres"
if [ "$action" = up ] && [ -f "$mount_dir/postgres/PG_VERSION" ] && [ ! -f "$mount_dir/postgres/import-finished" ]; then
  echo 'Unfinished import database retained; explicit Nominatim continuation is required before restart' >&2
  exit 1
fi
SH
  [ "$action" = prepare ] && exit 0
  exec docker --context colima-openplans-big compose --env-file /dev/null -f compose.geocoder.yml -p openplans-geocoder up -d
fi
exec docker --context colima-openplans-big compose --env-file /dev/null -f compose.geocoder.yml -p openplans-geocoder "$action"
