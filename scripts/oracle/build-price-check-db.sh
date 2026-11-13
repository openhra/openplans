#!/usr/bin/env bash
# Builds the database the Part D plan-average price check runs against: the 2026 PBP release and
# the sample's plans from the newest cached quarterly Part D archive, with pricing and
# dispensing-fee ranges. Maximum fair prices come from the pinned file in data/, not the database.
# Cache only; nothing is fetched. Run `npm run build` first.
#
#   scripts/oracle/build-price-check-db.sh build  [--year 2026] [--database-url URL | --docker-context NAME] [--work DIR]
#   scripts/oracle/build-price-check-db.sh remove [--year 2026] --docker-context NAME
#
# With --database-url (or OPENPLANS_PRICE_CHECK_DATABASE_URL) it loads that database. With
# --docker-context (or OPENPLANS_PRICE_CHECK_DOCKER_CONTEXT) it starts, or reuses, a disposable
# Postgres container in that Docker context, named openplans-price-check-<year>-db, from the
# openplans-db:local image (OPENPLANS_PRICE_CHECK_IMAGE), listening on 127.0.0.1 only. It never
# touches another container. `remove` deletes that container and its volume.
#
# `build` is idempotent: the subset is reused while the archive and the sample are unchanged, and
# the importers do nothing for a release already loaded from the same bytes. It prints the
# database URL on stdout and everything else on stderr. The work directory (default
# <data dir>/price-check/<year>) holds subset.zip, subset.json with the SHA-256 of each archive
# member read, and load.json with the import outcomes, time and database size.
set -euo pipefail
cd "$(dirname "$0")/../.."
usage() {
  echo 'Usage: scripts/oracle/build-price-check-db.sh build|remove [--year 2026] [--database-url URL | --docker-context NAME] [--work DIR]' >&2
  exit 2
}
[ "$#" -ge 1 ] || usage
action=$1
shift
case "$action" in build | remove) ;; *) usage ;; esac
year=2026
url=${OPENPLANS_PRICE_CHECK_DATABASE_URL:-}
context=${OPENPLANS_PRICE_CHECK_DOCKER_CONTEXT:-}
work=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] && [ -n "$2" ] || usage
  case "$1" in
    --year) [ "$2" = 2026 ] || usage; year=$2 ;;
    --database-url) url=$2; context= ;;
    --docker-context) context=$2; url= ;;
    --work) work=$2 ;;
    *) usage ;;
  esac
  shift 2
done
data_dir=${OPENPLANS_DATA_DIR:-$HOME/.local/share/openplans}
work=${work:-$data_dir/price-check/$year}
name=openplans-price-check-$year-db
volume=openplans-price-check-$year-data
image=${OPENPLANS_PRICE_CHECK_IMAGE:-openplans-db:local}
dk() { docker --context "$context" "$@"; }

if [ "$action" = remove ]; then
  [ -n "$context" ] || usage
  dk rm -f "$name" >/dev/null 2>&1 || true
  dk volume rm "$volume" >/dev/null 2>&1 || true
  echo "removed $name and $volume" >&2
  exit 0
fi

if [ -z "$url" ]; then
  [ -n "$context" ] || usage
  if [ -z "$(dk ps -aq --filter "name=^${name}\$")" ]; then
    dk image inspect "$image" >/dev/null 2>&1 || {
      echo "image $image is missing in context $context; build it with: docker --context $context compose build db" >&2
      exit 1
    }
    dk run -d --name "$name" --shm-size 256m -v "$volume:/var/lib/postgresql/data" \
      -p 127.0.0.1::5432 -e POSTGRES_USER=openplans -e POSTGRES_DB=price_check \
      -e POSTGRES_HOST_AUTH_METHOD=trust "$image" >/dev/null
  else
    dk start "$name" >/dev/null
  fi
  ready=
  for _ in $(seq 1 60); do
    if dk exec "$name" pg_isready -q -U openplans -d price_check; then ready=1; break; fi
    sleep 1
  done
  [ -n "$ready" ] || { echo "$name did not become ready" >&2; exit 1; }
  port=$(dk port "$name" 5432/tcp | head -n 1)
  port=${port##*:}
  case "$port" in '' | *[!0-9]*) echo "no published port for $name" >&2; exit 1 ;; esac
  url=postgres://openplans@127.0.0.1:$port/price_check
fi

[ -f dist/ingest/medicare/spuf.js ] || { echo 'dist is not built; run npm run build' >&2; exit 1; }
mkdir -p "$work"
DATABASE_URL=$url node --max-old-space-size=4096 scripts/oracle/price-check-load.mjs \
  --year "$year" --work "$work" >&2
printf '%s\n' "$url"
