#!/usr/bin/env node
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Database, SqlSession } from '../../db/database.js';
import { migrationsDirectory } from '../../db/migrate.js';
import { dataDirectory } from './census.js';
import { acquireCounties, geocodeState } from './counties.js';
import type { County } from './counties.js';
import { stageStatewide, geocodeStatewide, publishStatewide,refreshStatewideFallbacks } from './statewide.js';
import { radiusHttpChecks, statewideReport } from './statewide-report.js';

// Dedicated bulk runner: a single connection owns the advisory lock and permits long staging queries.
const args=process.argv.slice(2), options={state:'TX',runId:'tx-20261107',maxBatches:Infinity,deadline:Date.now()+120*60_000,geographies:false,progress:console.log};
let reportOnly=false,stageOnly=false,http=false;
for(let i=0;i<args.length;i++) {
  const a=args[i],v=args[i+1];
  if(a==='--state'&&v){options.state=geocodeState(v);i++;}
  else if(a==='--run-id'&&v&&/^[a-zA-Z0-9_-]{1,80}$/.test(v)){options.runId=v;i++;}
  else if(a==='--max-batches'&&v&&/^\d+$/.test(v)){options.maxBatches=Number(v);i++;}
  else if(a==='--budget-minutes'&&v&&/^[1-9]\d*$/.test(v)){options.deadline=Date.now()+Number(v)*60_000;i++;}
  else if(a==='--report-only')reportOnly=true;
  else if(a==='--stage-only')stageOnly=true;
  else if(a==='--http-check')http=true;
  else if(a==='--geographies')options.geographies=true;
  else throw new Error('Usage: tx-cli [--state TX|FL|NC] [--run-id ID] [--max-batches N] [--budget-minutes N] [--report-only|--stage-only] [--http-check] [--geographies]');
}
if(!args.includes('--run-id') && options.state!=='TX')options.runId=`${options.state.toLowerCase()}-${new Date().toISOString().slice(0,10).replaceAll('-','')}`;
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10_000,idleTimeoutMillis:0});
pool.on('error',()=>{});
const sql:SqlSession={query:(q,a)=>pool.query(q,a),exec:async q=>{await pool.query(q);}};
const db:Database={...sql,close:()=>pool.end(),transaction:async run=>{
  const client=await pool.connect();
  try{await client.query('BEGIN');const result=await run({query:(q,a)=>client.query(q,a),exec:async q=>{await client.query(q);}});await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}};
process.on('SIGINT',()=>{options.deadline=Date.now();console.log('Stopping after the current atomic batch');});
process.on('SIGTERM',()=>{options.deadline=Date.now();console.log('Stopping after the current atomic batch');});
let reportCounties:County[]|undefined;
try {
  // Bulk joins must also work in a stock Docker Postgres with its small /dev/shm allocation.
  // These are connection-local settings; other ingest/API sessions keep their own configuration.
  await db.exec('SET max_parallel_workers_per_gather=0; SET jit=off');
  if(!(await db.query<{locked:boolean}>('SELECT pg_try_advisory_lock(1869636988) locked')).rows[0]!.locked)throw new Error('Another statewide geocoder owns the lock');
  // Apply only this lane's migration; concurrent lanes can already have newer independent migrations.
  await db.transaction(async tx=>{
    await tx.query('SELECT pg_advisory_xact_lock(1869636974)');
    for(const name of ['520_tx_geocode.sql','521_geocode_batch_profile.sql','600_geocode_row_rejection.sql','870_multistate_geocode.sql','871_geocode_state_cursors.sql','872_geocode_bootstrap_scope.sql']) {
      const text=await readFile(join(migrationsDirectory,name),'utf8'),sha=createHash('sha256').update(text).digest('hex');
      const applied=(await tx.query<{sha256:string}>('SELECT sha256 FROM schema_migrations WHERE name=$1',[name])).rows[0];
      if(applied&&applied.sha256!==sha)throw new Error('Statewide migration changed after application');
      if(!applied){await tx.exec(text);await tx.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[name,sha]);}
    }
  });
  const existing=(await db.query('SELECT state FROM geocode_tx_run WHERE run_id=$1',[options.runId])).rows[0];
  if(reportOnly && !existing)throw new Error('Missing statewide run');
  if(existing && existing.state!==options.state)throw new Error('Statewide run state differs; use a new run ID');
  const counties=await acquireCounties(db,dataDirectory(),geocodeState(options.state)),root=dataDirectory();reportCounties=counties;
  if(!reportOnly) {
    const staged=await stageStatewide(db,options);
    console.log(JSON.stringify({fallbacks_added:await refreshStatewideFallbacks(db,counties,options.runId)}));
    // Copies reused observations onto newly captured source rows before making any requests.
    await db.transaction(tx=>publishStatewide(tx,options.runId));
    if(staged&&!stageOnly)console.log(JSON.stringify(await geocodeStatewide(db,counties,options)));
  }
  const checks=http?await radiusHttpChecks(db,geocodeState(options.state)):undefined;
  const result=await statewideReport(db,options.runId,root,counties,checks);
  console.log(JSON.stringify({report:join(root,'reports',options.state==='TX'?'p3h-geocode-finish.md':`p3l-geocode-${options.state.toLowerCase()}.md`),totals:result.totals}));
  if(result.totals.bounds_errors || result.publication?.errors || checks?.some(c=>!c.passed))process.exitCode=1;
}catch(error){
  // Never emit driver messages/connection strings. Domain failures are fixed, non-secret strings.
  const code=(error as {code?:unknown})?.code;
  if(typeof code==='string' && /^[a-zA-Z0-9_]{1,40}$/.test(code))console.error(`Failure code: ${code}`);
  console.error(error instanceof Error && /^(County bounds|Point has|Incomplete Census|Census snapshot|Census request profile|Statewide migration|Statewide run state|Missing statewide run|Another statewide)/.test(error.message)?error.message:'Statewide geocode failed; pending batches retained (inspect schema/cache/service)');
  if(reportCounties) {
    try{await statewideReport(db,options.runId,dataDirectory(),reportCounties);}
    catch(reportError){
      const reportCode=(reportError as {code?:unknown})?.code;
      console.error(`Could not write the partial statewide report${typeof reportCode==='string'&&/^[a-zA-Z0-9_]{1,40}$/.test(reportCode)?' (code '+reportCode+')':''}`);
    }
  }
  process.exitCode=1;
}finally{await db.close();}
