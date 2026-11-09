#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

full=0
case "${1:-}" in
  '') [ "$#" -eq 0 ] || { echo 'Usage: smoke.sh [--full]' >&2; exit 1; } ;;
  --full) [ "$#" -eq 1 ] || { echo 'Usage: smoke.sh [--full]' >&2; exit 1; }; full=1 ;;
  *) echo 'Usage: smoke.sh [--full]' >&2; exit 1 ;;
esac
project="${OPENPLANS_COMPOSE_PROJECT:-openplans-h2}"
[[ "$project" =~ ^openplans-[a-z0-9][a-z0-9_-]*$ ]] || { echo 'FAIL: project must start with openplans-' >&2; exit 1; }
# Refuse to reuse or remove somebody else's stack/database.
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] ||
   [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]; then
  echo "FAIL: project $project already has containers or volumes; choose OPENPLANS_COMPOSE_PROJECT" >&2
  exit 1
fi

# Use only committed, public smoke placeholders; never read or print a real .env.
export POSTGRES_USER=openplans POSTGRES_PASSWORD=replace_this_placeholder POSTGRES_DB=openplans
export OPENPLANS_API_TOKEN=''
export API_PORT="${API_PORT:-43081}" DB_PORT="${DB_PORT:-45432}"
export COMPOSE_PROFILES=''
export OPENPLANS_RAW_READ_ONLY=true
compose=(docker compose --env-file .env.example -p "$project")
# Home is shared by Docker Desktop/Colima by default; macOS TMPDIR often is not.
scratch_root="${OPENPLANS_SMOKE_TMPDIR:-$HOME/.cache}"
mkdir -p "$scratch_root"
scratch="$(mktemp -d "$scratch_root/openplans-h2-smoke.XXXXXX")"
cleanup() {
  local code=$?
  trap - EXIT
  if [ "$code" -ne 0 ]; then "${compose[@]}" logs --no-color api || true; fi
  if ! "${compose[@]}" down -v --remove-orphans; then code=1; fi
  rm -rf "$scratch"
  return "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$full" -eq 1 ]; then
  # Same shared-cache default as the native ingesters; no checkout-path dependency.
  export OPENPLANS_DATA_DIR="${OPENPLANS_DATA_DIR:-$(node --input-type=module -e 'import { join } from "node:path"; import { homedir } from "node:os"; process.stdout.write(join(homedir(), ".local", "share", "openplans"))')}"
  node tests/smoke/check.mjs cache
  export OPENPLANS_RAW_READ_ONLY=false
  mkdir -p "$OPENPLANS_DATA_DIR/reports" "$OPENPLANS_DATA_DIR/work"
  report_dir="$OPENPLANS_DATA_DIR/reports/h2-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir "$report_dir"
else
  export OPENPLANS_DATA_DIR="$scratch/cache"
  mkdir -p "$OPENPLANS_DATA_DIR/raw" "$OPENPLANS_DATA_DIR/reports" "$OPENPLANS_DATA_DIR/work"
  report_dir="$scratch"
fi
export OPENPLANS_SMOKE_REPORT_DIR="$report_dir"
"${compose[@]}" config --format json | node tests/smoke/check.mjs config

# Probe before creating the stack: Colima's default VM may not share the external data drive.
if [ "$full" -eq 1 ] && ! docker run --rm --mount "type=bind,source=$OPENPLANS_DATA_DIR/raw,target=/cache,readonly" \
    node:22-slim node -e 'require("node:fs").accessSync("/cache/cms-exchange-puf")'; then
  echo 'FAIL: Docker cannot see OPENPLANS_DATA_DIR/raw. Do not alter the default Colima profile.' >&2
  echo 'Use a temporary profile: colima start openplans-h2 --activate=false --cpu 4 --memory 10 --mount "$OPENPLANS_DATA_DIR:w" --mount "$HOME:w"' >&2
  echo 'Then DOCKER_CONTEXT=colima-openplans-h2 ./scripts/smoke.sh --full; finally colima delete openplans-h2 --force' >&2
  exit 1
fi
SECONDS=0
"${compose[@]}" up -d --build db api
for ((attempt = 0; attempt < 60; attempt++)); do
  if node tests/smoke/check.mjs health >/dev/null 2>&1; then break; fi
  sleep 1
done
node tests/smoke/check.mjs health
echo "startup: ${SECONDS}s (including build)"
: > "$report_dir/times.tsv"
printf 'startup\t%s\n' "$SECONDS" >> "$report_dir/times.tsv"
run_worker() {
  local label=$1
  shift
  local before=$SECONDS
  local result=0
  if [ "${1:-}" = cached ]; then
    shift
    "${compose[@]}" run --rm --no-deps -T --entrypoint node worker --input-type=module - "$@" < tests/smoke/cached-worker.mjs > "$report_dir/$label.json" || result=$?
  else
    "${compose[@]}" run --rm --no-deps -T worker "$@" > "$report_dir/$label.json" || result=$?
  fi
  if [ "$result" -ne 0 ]; then
    echo "FAIL: worker $label" >&2
    cat "$report_dir/$label.json"
    return 1
  fi
  printf '%s\t%s\n' "$label" "$((SECONDS - before))" >> "$report_dir/times.tsv"
  echo "$label: $((SECONDS - before))s"
  if [ "$full" -eq 1 ]; then
    "${compose[@]}" run --rm --no-deps -T --entrypoint node worker --input-type=module - < tests/smoke/metrics.mjs > "$report_dir/$label-metrics.json"
  fi
}
run_worker migrate migrate
run_worker migrate-repeat migrate
run_worker status status
node tests/smoke/check.mjs empty
"${compose[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -c "SELECT postgis_version(); SELECT name FROM schema_migrations ORDER BY name;"'
# A server with no configured credential must refuse personalized requests too.
node tests/smoke/check.mjs unconfigured-token

if [ "$full" -eq 1 ]; then
  if ! "${compose[@]}" run --rm --no-deps -T -e OPENPLANS_SMOKE_VERIFY_WRITES=1 --entrypoint node worker --input-type=module - cache < tests/smoke/check.mjs; then
    echo 'FAIL: cache is not visible/writable in the worker; check Docker sharing and raw/reports/work permissions' >&2
    exit 1
  fi
  run_worker rating-rules ingest rating-rules
  run_worker geo ingest geo --state TX
  run_worker puf ingest puf import --year 2026 --state TX
  node tests/smoke/check.mjs import
  # Exercise both production batch dispatchers on PostgreSQL, including all federal
  # states. NY is a separate geography import because it is absent from the PUF.
  run_worker geo-all-states ingest geo --all-states --year 2026
  run_worker geo-ny ingest geo --state NY --year 2026
  run_worker puf-all-states ingest puf import --all-states --year 2026
  run_worker rating-rules-all ingest rating-rules --file data/rating-rules/2026.json
  run_worker rxnorm cached rxnorm
  run_worker qhp-discover cached discover
  run_worker qhp-formulary ingest qhp formulary --year 2026 --state TX --issuer 76589
  run_worker nppes cached nppes
  run_worker qhp-providers ingest qhp providers --year 2026 --state TX --issuer 76589
  run_worker geocode cached geocode
  run_worker taxonomy ingest taxonomy --accept-nucc-terms  # smoke opts in to NUCC on purpose
  # This is an intentionally public test credential, never a real API secret.
  export OPENPLANS_API_TOKEN=replace_this_api_token_placeholder
  "${compose[@]}" up -d --no-deps api
  for ((attempt = 0; attempt < 60; attempt++)); do
    if node tests/smoke/check.mjs health >/dev/null 2>&1; then break; fi
    sleep 1
  done
  node tests/smoke/check.mjs full
  multi_before=$SECONDS
  python3 - <<'PY_RAW'
import csv, hashlib, io, json, os, re, zipfile
from decimal import Decimal
from html.parser import HTMLParser
from pathlib import Path
cache = Path(os.environ['OPENPLANS_DATA_DIR'])
report = Path(os.environ['OPENPLANS_SMOKE_REPORT_DIR'])
raw = cache/'raw/cms-exchange-puf'
manifest_path = sorted(raw.glob('manifest-*.json'))[-1]
files = {f['kind']: f for f in json.loads(manifest_path.read_text())['files'] if f['year'] == 2026}
def rows(kind):
    f = files[kind]; path = raw/f['sha256']/'payload'
    h = hashlib.sha256()
    with path.open('rb') as body:
        for chunk in iter(lambda: body.read(1024*1024), b''): h.update(chunk)
    assert h.hexdigest() == f['sha256'] and path.stat().st_size == f['bytes'], 'raw archive integrity'
    with zipfile.ZipFile(path) as archive:
        assert len(archive.namelist()) == 1
        reader = csv.DictReader(io.TextIOWrapper(archive.open(archive.namelist()[0]), encoding='utf-8-sig', newline=''))
        _ = reader.fieldnames
        previous = reader.line_num
        for row in reader:
            start = previous + 1; previous = reader.line_num
            yield start, row
# Independently inspect the cached raw CMS first (individual-market) HTML table.
class Table(HTMLParser):
    def __init__(self):
        super().__init__(); self.depth=0; self.done=False; self.cell=None; self.row=[]; self.rows=[]
    def handle_starttag(self, tag, attrs):
        if tag == 'table' and not self.done: self.depth += 1
        if self.depth and tag == 'tr': self.row=[]
        if self.depth and tag in ('td','th'): self.cell=''
    def handle_data(self, data):
        if self.cell is not None: self.cell += data
    def handle_endtag(self, tag):
        if self.depth and tag in ('td','th') and self.cell is not None:
            self.row.append(self.cell.strip()); self.cell=None
        if self.depth and tag == 'tr': self.rows.append(self.row)
        if self.depth and tag == 'table':
            self.depth -= 1
            if not self.depth: self.done=True
locations = {'FL': dict(zip='33130',county='12086',county_name='miamidade'),
             'AK': dict(zip='99501',county='02020',county_name='anchorage')}
for state, loc in locations.items():
    metas = [json.loads(p.read_text()) for p in (cache/'raw/cms-rating-areas').glob('*.meta.json')]
    meta = sorted((m for m in metas if m['url'].endswith('/'+state.lower()+'-gra')), key=lambda m:m['fetched_at'])[-1]
    path = cache/'raw/cms-rating-areas'/meta['sha256']/'payload'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == meta['sha256']
    table=Table(); table.feed(path.read_text())
    matches=[]
    for row in table.rows:
        if not row or not re.fullmatch(r'Rating Area [1-9][0-9]*',row[0]): continue
        if state == 'AK':
            if len(row)>2 and loc['zip'][:3] in re.findall(r'(?<![0-9])[0-9]{3}(?![0-9])',row[2]): matches.append(row[0])
        elif len(row)>1 and re.sub(r'[^a-z]','',row[1].lower().replace(' county','')) == loc['county_name']: matches.append(row[0])
    assert len(matches)==1, (state,matches)
    loc.update(area=matches[0],geo_sha256=meta['sha256'],geo_url=meta['url'])
service=set()
for _,r in rows('service-area'):
    loc=locations.get(r['StateCode'])
    if not loc or r['MarketCoverage']!='Individual' or r['DentalOnlyPlan']!='No': continue
    if r['CoverEntireState']=='Yes' or (r['County']==loc['county'] and
        (r['PartialCounty']=='No' or loc['zip'] in re.split(r'[,;\s]+',r['ZipCodes'].strip()))):
        service.add((r['StateCode'],r['IssuerId'],r['ServiceAreaId']))
plans={s:set() for s in locations}
for _,r in rows('plan-attributes'):
    state=r['StateCode']
    if state in locations and r['MarketCoverage']=='Individual' and r['DentalOnlyPlan']=='No' and r['QHPNonQHPTypeId']!='Off the Exchange' and (state,r['IssuerId'],r['ServiceAreaId']) in service:
        plans[state].add(r['StandardComponentId'])
samples={s:{} for s in locations}; family=set()
family_fields=['Couple','PrimarySubscriberAndOneDependent','PrimarySubscriberAndTwoDependents',
    'PrimarySubscriberAndThreeOrMoreDependents','CoupleAndOneDependent','CoupleAndTwoDependents','CoupleAndThreeOrMoreDependents']
for line,r in rows('rate'):
    state=r['StateCode']; loc=locations.get(state)
    if not loc or r['PlanId'] not in plans[state] or r['RatingAreaId']!=loc['area']: continue
    if r['Age']=='Family Option' or any(r[f].strip() for f in family_fields): family.add((state,r['PlanId']))
    if r['Age']=='40' and r['RateEffectiveDate']=='2026-01-01' and r['IndividualRate'].strip():
        samples[state].setdefault(r['PlanId'],[]).append(dict(source_row=line,raw=r,cents=int(Decimal(r['IndividualRate'])*100)))
for state,loc in locations.items():
    loc['plan_ids']=sorted(plans[state]); loc['plan_count']=len(plans[state])
    loc['samples']=[samples[state][p][0] for p in sorted(samples[state]) if len(samples[state][p])==1 and (state,p) not in family][:3]
    assert len(loc['samples'])==3
    print(f"raw {state} ZIP {loc['zip']}: {loc['plan_count']} plans; {loc['area']}",flush=True)
    for sample in loc['samples']: print(json.dumps(dict(state=state,**sample)),flush=True)
(report/'multistate-reference.json').write_text(json.dumps(dict(manifest=str(manifest_path),files=files,locations=locations),indent=2)+'\n')
PY_RAW
  node --input-type=module - <<'JS_HTTP'
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createDatabase} from './dist/db/database.js';
const directory=process.env.OPENPLANS_SMOKE_REPORT_DIR;
const reference=JSON.parse(await readFile(join(directory,'multistate-reference.json'),'utf8'));
const base=`http://127.0.0.1:${process.env.API_PORT}`;
async function get(path) {
  const response=await fetch(base+path,{headers:{authorization:`Bearer ${process.env.OPENPLANS_API_TOKEN}`}});
  assert.equal(response.status,200,path); return response.json();
}
async function quote(loc) {
  const response=await fetch(base+'/v1/premium-quotes',{method:'POST',headers:{'content-type':'application/json',
    authorization:`Bearer ${process.env.OPENPLANS_API_TOKEN}`},body:JSON.stringify({zip:loc.zip,coverage_start:'2026-01-01',
    plan_ids:loc.samples.map(s=>s.raw.PlanId),members:[{age:40,tobacco:false,relationship:'subscriber'}]})});
  assert.equal(response.status,200); return (await response.json()).quotes;
}
function rawCheck(estimates,loc) {
  assert.equal(estimates.length,3);
  for (const [i,sample] of loc.samples.entries()) {
    const e=estimates[i]; assert.equal(e.status,'rated','raw-row premium status');
    assert.equal(e.total_cents,sample.cents,'raw-row premium cents');
    assert.equal(e.rating_area_id,loc.area,'raw-row rating area');
    assert.equal(e.rate_rows_used.length,1); assert.equal(e.rate_rows_used[0].provenance.source_row,sample.source_row);
  }
}
const results={};
for (const [state,loc] of Object.entries(reference.locations)) {
  const ids=[],availability=[];
  for (let page=1; page!==null;) {
    const response=await get(`/v1/plans?zip=${loc.zip}&year=2026&page=${page}`);
    assert.equal(response.status,'available'); assert.equal(response.total,loc.plan_count);
    assert.equal(response.location.county,loc.county);
    ids.push(...response.plans.map(p=>p.base_plan_id));
    availability.push(...response.plans.map(p=>p.premium_availability)); page=response.next_page;
  }
  assert.deepEqual(ids.sort(),loc.plan_ids,'raw plan set');
  for (const a of availability) assert.deepEqual({status:a.status,area:a.rating_area_id},{status:'available',area:loc.area});
  const estimates=await quote(loc); rawCheck(estimates,loc);
  const manifest=await get(`/v1/data-availability?state=${state}&year=2026`);
  assert.ok(manifest.some(e=>e.premium_status==='available' && (state==='AK' ? e.rating_area_geography.zip3_areas>0 : e.rating_area_geography.county_areas>0)));
  results[state]={zip:loc.zip,plan_count:ids.length,area:loc.area,estimates};
  console.log(`HTTP ${state} ${loc.zip}: ${ids.length} plans; ${loc.area}; 3 raw premiums exact`);
}
const ny=await get('/v1/benchmark?zip=10001&year=2026&ages=40');
assert.equal(ny.status,'unsupported_rating_method'); assert.equal(ny.slcsp_monthly_cents,null);
assert.deepEqual(ny.lowest_silver_plans,[]); assert.equal(ny.rating_area_id,null);
results.NY=ny; console.log('HTTP NY 10001: unsupported_rating_method; no premium');
// Only this smoke-owned temporary database is mutated. Restore each mutation
// before proceeding, even when a negative-control assertion fails.
const db=createDatabase(`postgresql://openplans:replace_this_placeholder@127.0.0.1:${process.env.DB_PORT}/openplans`);
try {
  const taxonomy=JSON.parse(await readFile(join(directory,'taxonomy.json'),'utf8'));
  const count=Number((await db.query('SELECT count(*) AS n FROM provider_taxonomy')).rows[0].n);
  assert.ok(count>0); assert.equal(count,taxonomy.codes);
  assert.equal((await db.query("SELECT display_name FROM provider_taxonomy WHERE code='207Q00000X'")).rows.length,1);
  results.taxonomy={...taxonomy,stored_codes:count}; console.log(`taxonomy: ${count} codes on Postgres`);
  const loc=reference.locations.AK;
  const original=(await db.query("SELECT z.* FROM rating_area_zip z JOIN geo_import g ON g.rating_snapshot_id=z.snapshot_id AND g.state=z.state AND g.plan_year=z.plan_year WHERE z.state='AK' AND z.plan_year=2026 AND zip_prefix='995'")).rows[0];
  assert.equal(original.rating_area_id,loc.area);
  try {
    await db.query("UPDATE rating_area_zip SET rating_area_id='Rating Area 2' WHERE snapshot_id=$1 AND state='AK' AND plan_year=2026 AND zip_prefix='995'",[original.snapshot_id]);
    const mutant=await quote(loc);
    assert.throws(()=>rawCheck(mutant,loc),/raw-row/);
    results.mutant={rejected:true,estimates:mutant};
    console.log('negative control: Anchorage -> Rating Area 2 fails raw-row premium check');
  } finally {
    await db.query("UPDATE rating_area_zip SET rating_area_id=$1 WHERE snapshot_id=$2 AND state='AK' AND plan_year=2026 AND zip_prefix='995'",[original.rating_area_id,original.snapshot_id]);
  }
  // Labelled synthetic conflicting ZIP3 fixture. The production uniqueness
  // constraint is relaxed only inside the isolated smoke database, then restored.
  try {
    await db.exec('ALTER TABLE rating_area_zip DROP CONSTRAINT rating_area_zip_pkey');
    await db.query("INSERT INTO rating_area_zip VALUES ('AK','995','Rating Area 2',2026,$1,999999)",[original.snapshot_id]);
    const ambiguous=await quote(loc);
    for (const e of ambiguous) {
      assert.equal(e.status,'ambiguous'); assert.equal(e.reason,'UNRESOLVED_RATING_AREA'); assert.ok(!('total_cents' in e));
    }
    const plans=await get('/v1/plans?zip=99501&year=2026');
    for (const p of plans.plans) assert.deepEqual(p.premium_availability,{status:'ambiguous',reason:'UNRESOLVED_RATING_AREA'});
    results.synthetic_ambiguous_zip3={rejected:true,estimates:ambiguous};
    console.log('negative control: synthetic ZIP3 995 -> two areas is ambiguous; no premiums');
  } finally {
    await db.query("DELETE FROM rating_area_zip WHERE snapshot_id=$1 AND state='AK' AND plan_year=2026 AND zip_prefix='995' AND source_row=999999",[original.snapshot_id]);
    await db.exec('ALTER TABLE rating_area_zip ADD PRIMARY KEY(snapshot_id,state,zip_prefix,plan_year)');
  }
  rawCheck(await quote(loc),loc);
  await writeFile(join(directory,'multistate-api.json'),JSON.stringify({passed:true,results},null,2)+'\n');
} finally { await db.close(); }
JS_HTTP
  printf 'multistate-http\t%s\n' "$((SECONDS - multi_before))" >> "$report_dir/times.tsv"
  "${compose[@]}" run --rm --no-deps -T --entrypoint node worker --input-type=module - < tests/smoke/metrics.mjs > "$report_dir/multistate-http-metrics.json"
  echo "multi-state HTTP and raw-row checks: $((SECONDS - multi_before))s"
  db_state() {
    "${compose[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "SELECT import_id FROM puf_active_catalog ORDER BY state,plan_year; SELECT count(*) FROM snapshot WHERE validation_state='\''ACTIVE'\''; SELECT count(*) FROM puf_import;"'
  }
  before="$(db_state)"
  # Connect to a nonexistent DB on the real server: exit must be nonzero, with no activation.
  if "${compose[@]}" run --rm --no-deps -T \
      -e DATABASE_URL=postgresql://openplans:replace_this_placeholder@db:5432/openplans_missing \
      worker ingest puf import --year 2026 --state TX > "$report_dir/wrong-db.log" 2>&1; then
    echo 'FAIL: wrong-database import unexpectedly succeeded' >&2
    exit 1
  fi
  after="$(db_state)"
  [ "$before" = "$after" ] || { echo 'FAIL: failed import changed active snapshots/catalog' >&2; exit 1; }
  echo 'negative control: wrong DB import refused; ACTIVE snapshots/catalog unchanged'
  "${compose[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atc "SELECT pg_database_size(current_database());"' > "$report_dir/db-size.txt"
  printf 'total_before_teardown\t%s\n' "$SECONDS" >> "$report_dir/times.tsv"
  node tests/smoke/check.mjs summary
  node --input-type=module - <<'JS_SUMMARY'
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const dir=process.env.OPENPLANS_SMOKE_REPORT_DIR;
const summary=JSON.parse(await readFile(join(dir,'summary.json'),'utf8'));
const lines=(await readFile(join(dir,'puf-all-states.json'),'utf8')).trim().split('\n');
const puf=JSON.parse(lines.at(-1));
if (!puf.passed || puf.results.some(r=>r.status!=='ACTIVE')) throw new Error('All-state production import incomplete');
summary.all_states={year:puf.year,states:puf.results.map(r=>r.state),passed:puf.passed};
summary.multi_state=JSON.parse(await readFile(join(dir,'multistate-api.json'),'utf8'));
await writeFile(join(dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
JS_SUMMARY
  echo "reports: $report_dir"
fi
elapsed=$SECONDS
cleanup
trap - EXIT
# Assert teardown by label, independent of other owners' Compose projects.
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]
[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]
echo "teardown: $project containers/volumes empty"
if [ "$full" -eq 1 ]; then
  node tests/smoke/check.mjs complete
  echo "PASS: smoke --full (${elapsed}s before teardown)"
else echo "PASS: smoke (${elapsed}s before teardown)"; fi
