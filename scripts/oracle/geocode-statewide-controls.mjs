#!/usr/bin/env node
// Real Postgres crash/rollback control. Creates and drops its own disposable database, never a container.
// DATABASE_URL is read only as a connection setting and is never logged.
import pg from 'pg';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readFile,writeFile,mkdtemp,rm,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createDatabase } from '../../dist/db/database.js';
import { migrate } from '../../dist/db/migrate.js';
import { stageStatewide,geocodeStatewide } from '../../dist/ingest/geocode/statewide.js';
import { checkCountyPoint } from '../../dist/ingest/geocode/counties.js';
import { dataDirectory,geographyEndpoint } from '../../dist/ingest/geocode/census.js';
import { readRecords } from '../../dist/ingest/csv/index.js';
const fixtures=new URL('../../tests/fixtures/geocode/',import.meta.url);
const inputs=JSON.parse(await readFile(new URL('inputs.json',fixtures),'utf8'));
const recorded=(await readFile(new URL('tx-census.csv',fixtures),'utf8')).trim().split('\n');
// Labelled synthetic rings: only the exact, recorded bounding boxes are under test here.
const counties=JSON.parse(await readFile(new URL('tx-county-bounds.json',fixtures),'utf8')).counties.map(c=>({...c,
  rings:[[[c.west,c.south],[c.east,c.south],[c.east,c.north],[c.west,c.north],[c.west,c.south]]]}));
async function fixtureAcquisition(csv,directory) {
  const lines=[];
  for await(const row of readRecords((async function*(){yield csv;})())) {
    const index=inputs.findIndex(a=>a.line_1===row.fields[1]);
    if(index<0)throw new Error('Unknown fixture address');
    lines.push(recorded[index].replace(/^"\d+"/,`"${row.fields[0]}"`));
  }
  const raw=lines.join('\n')+'\n',sha=createHash('sha256').update(raw).digest('hex'),path=join(directory,sha+'.csv');
  await writeFile(path,raw);
  return {requests:0,file:{outcome:'reused',snapshotId:sha,path,metadataPath:path+'.meta.json',metadata:{source:'census-geocoder-batch',
    snapshot_id:sha,url:geographyEndpoint,final_url:geographyEndpoint,redirect_chain:[],status:200,content_type:'text/csv',etag:null,
    last_modified:null,sha256:sha,bytes:Buffer.byteLength(raw),fetched_at:'2026-11-07T00:00:00Z'}}};
}
if(process.argv[2]==='--crash-child') {
  const db=createDatabase(),directory=process.env.GEOCODE_CONTROL_DIR;
  await geocodeStatewide(db,counties,{runId:'sigkill-control',batchSize:2,acquire:csv=>fixtureAcquisition(csv,directory),beforeCommit:async()=>{
    process.send({inside_batch_transaction:true});
    await new Promise(()=>{}); // Parent SIGKILLs us only after both point and attempt writes, before COMMIT.
  }});
  process.exit(2);
}
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const root=dataDirectory();await mkdir(join(root,'work'),{recursive:true});await mkdir(join(root,'reports'),{recursive:true});
const directory=await mkdtemp(join(root,'work','p3e-crash-control-')),name=`openplans_p3e_control_${process.pid}`;
const admin=new pg.Client({connectionString:process.env.DATABASE_URL});await admin.connect();
let db,created=false;
const assert=(condition,message)=>{if(!condition)throw new Error(message);};
try {
  await admin.query(`CREATE DATABASE ${name}`);created=true;
  const url=new URL(process.env.DATABASE_URL);url.pathname='/'+name;
  db=createDatabase(url.href);await migrate(db);
  await db.query(`INSERT INTO source(source_id,publisher,source_kind) VALUES('p3e-synthetic-control','Synthetic control harness','test')`);
  for(const id of ['input','centroid','relationship','rating'])await db.query(`INSERT INTO snapshot(snapshot_id,source_id) VALUES($1,'p3e-synthetic-control')`,[id]);
  await db.query(`INSERT INTO geo_import(state,plan_year,relationship_snapshot_id,centroid_snapshot_id,rating_snapshot_id) VALUES('TX',2026,'relationship','centroid','rating')`);
  const centroids=JSON.parse(await readFile(new URL('centroids.json',fixtures),'utf8')).points;
  for(const p of centroids)await db.query(`INSERT INTO zcta_centroid VALUES($1,$2,$3,'centroid',$4)`,[p.zcta,p.latitude,p.longitude,p.rowNumber]);
  for(const [i,a] of inputs.entries()) {
    const npi=`100000000${i}`; // Synthetic identifier; only the recorded public address is real.
    await db.query(`INSERT INTO npi_provider(npi,in_scope,state_filter,data_date,snapshot_id) VALUES($1,true,'TX','2026-11-07','input')`,[npi]);
    await db.query(`INSERT INTO npi_address(npi,kind,ordinal,line_1,line_2,city,state,zip5,snapshot_id) VALUES($1,'practice',0,$2,$3,$4,'TX',$5,'input')`,[npi,a.line_1,a.line_2,a.city,a.zip5]);
  }
  for(const county of counties)await db.query(`INSERT INTO geocode_tx_county SELECT * FROM json_populate_record(NULL::geocode_tx_county,$1::json)`,[JSON.stringify(county)]);
  await stageStatewide(db,{runId:'sigkill-control'});
  const child=fork(fileURLToPath(import.meta.url),['--crash-child'],{env:{...process.env,DATABASE_URL:url.href,GEOCODE_CONTROL_DIR:directory},stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash control did not reach the batch transaction'));},30_000);
    child.once('message',message=>{if(message.inside_batch_transaction){clearTimeout(timer);child.kill('SIGKILL');resolve();}});
    child.once('error',reject);
    child.once('exit',(code,signal)=>{if(signal!=='SIGKILL'){clearTimeout(timer);reject(new Error(`Unexpected control exit ${code}`));}});
  });
  await new Promise(resolve=>child.exitCode!==null||child.signalCode!==null?resolve():child.once('exit',resolve));
  const count=async table=>Number((await db.query(`SELECT count(*) n FROM ${table}`)).rows[0].n);
  assert(await count('geocode_tx_result')===0,'Killed transaction leaked distinct results');
  assert(await count('geocode_attempt')===0,'Killed transaction leaked attempts');
  assert(await count('address_point')===0,'Killed transaction leaked points');
  const pending=(await db.query(`SELECT request_csv,completed FROM geocode_tx_batch`)).rows;
  assert(pending.length===1&&!pending[0].completed,'Interrupted manifest was lost');
  const requests=[];
  await geocodeStatewide(db,counties,{runId:'sigkill-control',batchSize:2,sleep:async()=>{},acquire:csv=>{requests.push(csv);return fixtureAcquisition(csv,directory);}});
  assert(requests[0]===pending[0].request_csv,'Resume changed the pending batch');
  const attempts=await count('geocode_attempt'),distinct=await count('geocode_tx_result'),points=await count('address_point');
  assert(attempts===6&&distinct===6&&points===4,'Resume duplicated or lost rows');
  const batches=(await db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE NOT completed)::int pending FROM geocode_tx_batch`)).rows[0];
  assert(batches.total===3&&batches.pending===0,'Resume lost a batch');
  let ohio=false,zero=false;
  try{checkCountyPoint(39.96,-82.99,'48201',counties);}catch{ohio=true;}
  try{checkCountyPoint(0,0,'48201',counties);}catch{zero=true;}
  assert(ohio&&zero,'Bounds mutant escaped');
  const report={passed:true,engine:'real PostgreSQL/PostGIS',interruption:'SIGKILL after SQL writes, before COMMIT',
    rollback:{results:0,attempts:0,points:0,pending_manifests:1},resume:{identical_csv:true,attempts,distinct,points,batches},
    ohio_rejected:ohio,zero_rejected:zero,network_requests:0,fixture_scope:'recorded public addresses and Census replies; synthetic NPIs and rectangular rings'};
  await writeFile(join(root,'reports','p3e-negative-controls.json'),JSON.stringify(report,null,2)+'\n');
  console.log('PASS: Postgres SIGKILL rollback/resume, identical pending CSV, six distinct results, no duplicated/lost batches; Ohio and (0,0) rejected');
}finally{
  await db?.close();
  if(created)await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();await rm(directory,{recursive:true,force:true});
}
