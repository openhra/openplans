import { mkdir, writeFile,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../../api/app.js';
import type { SqlSession } from '../../db/database.js';
import type { County, GeocodeState } from './counties.js';
import { checkCountyPoint, geocodeState, geocodeStates } from './counties.js';

export async function radiusHttpChecks(db:SqlSession,state:GeocodeState='TX') {
  const server=serve({fetch:createApp(db).fetch,hostname:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  const address=server.address();if(!address || typeof address==='string') throw new Error('No HTTP listener');
  const results=[];
  try {
    for(const [city,zip] of ({TX:[['Dallas','75201'],['Austin','78701'],['El Paso','79901']],FL:[['Miami','33130'],['Orlando','32801'],['Tampa','33602']],NC:[['Charlotte','28202'],['Raleigh','27601']]}[state])) {
      for(const attempt of ['first','repeat'] as const) {
      const path=`/v1/providers?zip=${zip}&radius_miles=10`,start=Date.now();
      const response=await fetch(`http://127.0.0.1:${address.port}${path}`),body=await response.json() as {
        total?:number;status?:string;providers?:{distance_miles:number;addresses:{latitude:number;longitude:number;method:string;precision:string;match_status:string;centroid_snapshot_id:string|null}[]}[]};
      const providers=body.providers??[];
      const elapsed=Date.now()-start;
      const passed=elapsed<5000 && response.status===200 && body.status==='available' && (body.total??0)>0 && providers.length>0
        && providers.every(p=>Number.isFinite(p.distance_miles)&&p.distance_miles<=10&&p.addresses.length>0&&p.addresses.every(a=>
          Number.isFinite(a.latitude)&&Number.isFinite(a.longitude)&&(a.method==='census_geocoder'&&a.match_status==='Match'
            || a.method==='zcta_centroid'&&a.precision==='approximate'&&['Tie','No_Match','rejected_out_of_bounds'].includes(a.match_status)&&a.centroid_snapshot_id)));
      results.push({city,zip,path,attempt,checked_at:new Date().toISOString(),http_status:response.status,total:body.total??null,returned:providers.length,passed,elapsed_ms:elapsed,
        sample:providers[0]??null});
      }
    }
  } finally {await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  return results;
}
export async function statewideReport(db:SqlSession,runId:string,root:string,counties:County[],http?:Awaited<ReturnType<typeof radiusHttpChecks>>) {
  const run=(await db.query('SELECT state FROM geocode_tx_run WHERE run_id=$1',[runId])).rows[0];
  if(!run)throw new Error('Missing statewide run');
  const state=geocodeState(String(run.state));
  const stateFips=geocodeStates[state].fips;
  const reportName=state==='TX'?'p3h-geocode-finish':`p3l-geocode-${state.toLowerCase()}`;
  const rows=(await db.query(`SELECT coalesce(r.county_fips,a.selection_county,'unknown') county_fips,count(*)::int addresses,
    count(*) FILTER(WHERE r.match_status='Match')::int matched,count(*) FILTER(WHERE r.match_status='Tie')::int tie,
    count(*) FILTER(WHERE r.match_status='No_Match')::int no_match,
    count(*) FILTER(WHERE r.match_status='rejected_out_of_bounds')::int rejected,count(*) FILTER(WHERE r.method='zcta_centroid')::int fallback,
    count(*) FILTER(WHERE r.address_hash IS NULL)::int pending,count(*) FILTER(WHERE r.address_hash IS NOT NULL AND r.method IS NULL)::int no_point,
    count(*) FILTER(WHERE r.latitude IS NOT NULL)::int points,
    count(*) FILTER(WHERE r.latitude IS NOT NULL AND (c.county_fips IS NULL OR left(c.county_fips,2)<>$2 OR r.latitude<c.south OR r.latitude>c.north
      OR r.longitude<c.west OR r.longitude>c.east OR (r.latitude=0 AND r.longitude=0)))::int bounds_errors
    FROM geocode_tx_address a LEFT JOIN geocode_tx_result r USING(address_hash) LEFT JOIN geocode_tx_county c ON c.county_fips=r.county_fips
    WHERE a.run_id=$1 GROUP BY coalesce(r.county_fips,a.selection_county,'unknown') ORDER BY county_fips`,[runId,stateFips])).rows;
  const byCounty=new Map(rows.map(r=>[r.county_fips,r]));
  const countyRows:Record<string,unknown>[]=[...counties.map(c=>({county_fips:c.county_fips,name:c.name,addresses:0,matched:0,tie:0,no_match:0,rejected:0,fallback:0,pending:0,no_point:0,points:0,bounds_errors:0,
    ...byCounty.get(c.county_fips)})),...rows.filter(r=>r.county_fips==='unknown').map(r=>({name:'Unknown (no county evidence)',...r}))];
  const totals:Record<string,number>={};
  for(const key of ['addresses','matched','tie','no_match','rejected','fallback','pending','no_point','points','bounds_errors']) totals[key]=rows.reduce((n,r)=>n+Number(r[key]),0);
  totals.resolved=totals.addresses!-totals.pending!;
  const rejectedRows=(await db.query(`SELECT a.address_hash,
    concat_ws(', ',nullif(btrim(a.address->>'line_1'),''),nullif(btrim(a.address->>'line_2'),''),
      nullif(btrim(a.address->>'city'),''),a.address->>'state',a.address->>'zip5') AS address,
    r.snapshot_id,r.rejection,r.method,r.latitude AS published_latitude,r.longitude AS published_longitude,r.centroid_snapshot_id
    FROM geocode_tx_address a JOIN geocode_tx_result r USING(address_hash)
    WHERE a.run_id=$1 AND r.match_status='rejected_out_of_bounds' ORDER BY a.address_hash`,[runId])).rows;
  const sources=(await db.query(`SELECT i.source_table,count(*)::int source_rows,count(DISTINCT i.address_hash)::int distinct_addresses,
    count(*) FILTER(WHERE r.address_hash IS NOT NULL)::int completed FROM geocode_tx_input i LEFT JOIN geocode_tx_result r USING(address_hash)
    WHERE i.run_id=$1 GROUP BY i.source_table ORDER BY i.source_table`,[runId])).rows;
  const ledger=(await db.query(`SELECT count(*)::int batches,count(*) FILTER(WHERE completed)::int completed,
    count(*) FILTER(WHERE NOT completed)::int pending,sum(cardinality(address_hashes))::int submitted_rows FROM geocode_tx_batch WHERE run_id=$1`,[runId])).rows[0];
  let ohioRejected=false,zeroRejected=false;
  try{checkCountyPoint(39.96,-82.99,counties[0]?.county_fips??'',counties);}catch{ohioRejected=true;}
  try{checkCountyPoint(0,0,counties[0]?.county_fips??'',counties);}catch{zeroRejected=true;}
  const staging=(await db.query('SELECT npi_staged,issuer_staged,return_type,cardinality(source_shards)::int captured_issuer_shards FROM geocode_tx_run WHERE run_id=$1',[runId])).rows[0];
  const reusedObservations=Number((await db.query(`SELECT count(*)::int n FROM geocode_tx_address a JOIN geocode_tx_result r USING(address_hash)
    JOIN geocode_tx_run run ON run.run_id=a.run_id WHERE a.run_id=$1 AND r.geocoded_at<run.created_at`,[runId])).rows[0]!.n);
  const capturedIssuers=(await db.query(`SELECT DISTINCT p.issuer_id,p.plan_year,p.state,p.snapshot_id FROM geocode_tx_run r
    JOIN provider_shard s ON s.snapshot_id=ANY(r.source_shards) JOIN provider_source_set p ON p.snapshot_id=s.source_set_id
    WHERE r.run_id=$1 ORDER BY p.issuer_id,p.plan_year,p.state,p.snapshot_id`,[runId])).rows;
  const activeDrift=(await db.query(`SELECT a.issuer_id,a.plan_year,a.state,count(*)::int uncaptured_shards FROM provider_active_set a
    JOIN provider_shard s ON s.source_set_id=a.snapshot_id CROSS JOIN geocode_tx_run r
    WHERE r.run_id=$1 AND NOT(s.snapshot_id=ANY(r.source_shards))
      AND EXISTS(SELECT 1 FROM qhp_provider_address location WHERE location.snapshot_id=s.snapshot_id AND location.state=r.state)
    GROUP BY a.issuer_id,a.plan_year,a.state ORDER BY a.issuer_id,a.plan_year,a.state`,[runId])).rows;
  const publication=(await db.query(`SELECT count(*) FILTER(WHERE r.address_hash IS NOT NULL)::int completed_source_rows,
    count(*) FILTER(WHERE p.address_hash IS NOT NULL)::int published_points,
    count(*) FILTER(WHERE r.address_hash IS NOT NULL AND (g.address_hash IS NULL OR g.source_snapshot_id<>i.source_snapshot_id
      OR g.snapshot_id<>r.snapshot_id OR g.match_status<>r.match_status OR g.match_quality IS DISTINCT FROM r.match_quality
      OR g.geocoded_at IS DISTINCT FROM r.geocoded_at OR g.outcome<>CASE WHEN r.method IS NULL THEN 'no_point' ELSE 'point' END
      OR (r.method IS NULL AND p.address_hash IS NOT NULL)
      OR (r.method IS NOT NULL AND (p.address_hash IS NULL OR p.latitude IS DISTINCT FROM r.latitude OR p.longitude IS DISTINCT FROM r.longitude
        OR p.method IS DISTINCT FROM r.method OR p.snapshot_id<>r.snapshot_id OR p.centroid_snapshot_id IS DISTINCT FROM r.centroid_snapshot_id
        OR p.match_status IS DISTINCT FROM r.match_status OR p.match_quality IS DISTINCT FROM r.match_quality OR p.geocoded_at IS DISTINCT FROM r.geocoded_at
        OR c.county_fips IS NULL OR left(c.county_fips,2)<>$2 OR p.latitude<c.south OR p.latitude>c.north OR p.longitude<c.west OR p.longitude>c.east
        OR (p.method='census_geocoder' AND p.match_status<>'Match')
        OR (p.method='zcta_centroid' AND (p.match_status NOT IN ('Tie','No_Match','rejected_out_of_bounds')
          OR p.match_quality IS NOT NULL OR p.centroid_snapshot_id IS NULL))
        OR (p.latitude=0 AND p.longitude=0)))))::int errors
    FROM geocode_tx_input i LEFT JOIN geocode_tx_result r USING(address_hash)
    LEFT JOIN geocode_attempt g ON g.address_hash=i.address_hash AND g.source_table=i.source_table AND g.source_row=i.source_row
    LEFT JOIN address_point p ON p.address_hash=i.address_hash AND p.source_table=i.source_table AND p.source_row=i.source_row
      AND p.source_snapshot_id=i.source_snapshot_id
    LEFT JOIN geocode_tx_county c ON c.county_fips=r.county_fips WHERE i.run_id=$1`,[runId,stateFips])).rows[0];
  let crashControl:unknown=null;
  try{crashControl=JSON.parse(await readFile(join(root,'reports','p3e-negative-controls.json'),'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const result={state,run_id:runId,generated_at:new Date().toISOString(),totals,rejected_rows:rejectedRows,sources,batches:ledger,input_staging:staging,publication,reused_observations:reusedObservations,captured_issuers:capturedIssuers,uncaptured_active_issuers:activeDrift,
    negative_controls:{ohio_point_rejected:ohioRejected,zero_point_rejected:zeroRejected},crash_control:crashControl,http_checks:http??null,counties:countyRows};
  const lines=[`# ${state==='TX'?'P3h':'P3l'} — ${state} provider geocoding`, '',`Run: ${runId}. Generated: ${result.generated_at}.`, '',
    `Counts are distinct normalized five-field addresses across NPPES practice locations and the ${state} ACTIVE issuer shards captured when this run was created. A suite remains part of the address identity. Source-row counts below retain every attribution.`, '',
    `County is taken from the Census geography response when present; location-only matches are classified against the independently retained Census TIGERweb county polygons. All point coordinates are checked against their claimed county extent. Fallback county is the county containing the published ZCTA internal point. Unlocated/pending addresses use the largest published ${state} ZCTA overlap as a scheduling/report candidate only; they have no confirmed address county. Unknown ZIPs remain in the unknown bucket. Bounding rectangles are rejection checks; they do not independently prove polygon membership of a publisher-provided county claim.`, '',
    `Input staging: ${JSON.stringify(staging)}. Both staged flags must be true before these totals describe the whole captured scope.`, '',
    `Captured issuer source sets: ${JSON.stringify(capturedIssuers)}`, '',
    `Newly ACTIVE issuer shards outside this frozen run: ${JSON.stringify(activeDrift)}. A follow-on run is required when this list is nonempty.`, '',
    `Resolved: ${totals.resolved} / ${totals.addresses} distinct addresses.`, `Totals: ${JSON.stringify(totals)}`,`Batch ledger: ${JSON.stringify(ledger)}`,`Source rows: ${JSON.stringify(sources)}`, '',
    `${reusedObservations} distinct addresses had completed Census observations before this run was created; their original evidence is reused rather than submitted again. The batch ledger counts this run's own submissions.`, '',
    'Tie and No_Match are preserved. Out-of-state/out-of-county matches are stored as rejected_out_of_bounds with raw response evidence retained. Fallback is a subset of Tie, No_Match and rejected_out_of_bounds and is never counted as matched. No-point outcomes are terminal evidence; malformed/network failures retain a pending batch for retry.', '',
    `Bounds: ${totals.bounds_errors===0?'PASS':'FAIL'} (${totals.points} stored points checked). Ohio mutant: ${ohioRejected?'rejected':'FAILED'}. (0,0): ${zeroRejected?'rejected':'FAILED'}.`, '',
    `Published API point/attempt reconciliation: ${JSON.stringify(publication)}. This independently checks every source attribution and its actual published coordinates against its claimed county bounds.`, '',
    `Real Postgres SIGKILL/transaction-resume control: ${crashControl?JSON.stringify(crashControl):'not run (see scripts/oracle/geocode-statewide-controls.mjs)'}.`, '',
    '## Real HTTP radius checks','',...(http?http.map(h=>`${h.passed?'PASS':'FAIL'} ${h.city} ${h.attempt}: GET ${h.path} → HTTP ${h.http_status}, ${h.total} providers, ${h.returned} returned (${h.elapsed_ms} ms).`):['Not run.']), '',
    '## Rejected Census rows','', 'Returned coordinates below are quarantined evidence, never Census points in the published address table. The method column describes the separately verified ZIP fallback, if available.', '',
    '| Address (trimmed) | Returned latitude | Returned longitude | Returned state | Method |',
    '|---|---:|---:|---|---|',
    ...rejectedRows.map(r=>{const evidence=r.rejection as {latitude:number;longitude:number;returned_state:string|null};return `| ${String(r.address).replace(/\|/g,'\\|')} | ${evidence.latitude} | ${evidence.longitude} | ${evidence.returned_state??'unknown'} | ${r.method??'no_point'} |`;}), '',
    '## Per county','', '| FIPS | County | Addresses | Matched | Tie | No match | Rejected | Fallback | No point | Pending | Bounds |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|',
    ...countyRows.map(c=>`| ${c.county_fips} | ${c.name} | ${c.addresses} | ${c.matched} | ${c.tie} | ${c.no_match} | ${c.rejected} | ${c.fallback} | ${c.no_point} | ${c.pending} | ${c.bounds_errors===0?'PASS':'FAIL'} |`), '',
    '## Sources','', '[Census batch contract](https://geocoding.geo.census.gov/geocoder/Geocoding_Services_API.html); [Census TIGERweb](https://www.census.gov/data/developers/data-sets/TIGERweb-map-service.html). Raw requests, response hashes and bounds snapshots are retained in the external data cache. Sequential requests contain at most 10,000 distinct addresses, with one-second pacing and the existing capped retry/backoff policy.', '',
    '## Remaining work','',`${totals.pending??0} distinct addresses pending. Resume with the same run ID; its exact incomplete batch request is retained. Issuer sets activated after this run was created require a new run ID (completed normalized addresses are reused).`, ''];
  await mkdir(join(root,'reports'),{recursive:true});
  await writeFile(join(root,'reports',reportName+'.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(join(root,'reports',reportName+'.md'),lines.join('\n'));
  return result;
}
