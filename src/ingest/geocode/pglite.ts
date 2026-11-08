#!/usr/bin/env node
/** Developer real-data runner. Copies only county-selected published rows into a fresh, isolated file DB. */
import { PGlite } from '@electric-sql/pglite';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, SqlSession } from '../../db/database.js';
import { migrate, migrationsDirectory } from '../../db/migrate.js';
import { ingestGeocode } from './index.js';
import { dataDirectory } from './census.js';
const root=dataDirectory(), county=process.argv[2] ?? '48201';
if(county!=='48201') throw new Error('Developer real run is limited to Harris County');
const directory=await mkdtemp(join(tmpdir(),'openplans-geocode-migrations-'));
const dbPath=join(root,'geocode-pglite-p3c');
let db: Database | undefined;
const opened: PGlite[]=[];
function session(pg: PGlite): Database {
  const sql: SqlSession = { query: (q,a)=>pg.query(q,a),exec: async q=>{await pg.exec(q);} };
  return { ...sql, close: ()=>pg.close(),transaction: run=>pg.transaction(tx=>run({query:(q,a)=>tx.query(q,a),exec:async q=>{await tx.exec(q);}})) };
}
try {
  await mkdir(join(root,'reports'),{recursive:true});
  for(const name of await readdir(migrationsDirectory)) if(name.endsWith('.sql') && name!=='002_postgis.sql') await cp(join(migrationsDirectory,name),join(directory,name));
  const pg=new PGlite(dbPath); db=session(pg); await migrate(db,directory);
  if(!(await db.query('SELECT 1 FROM npi_address LIMIT 1')).rows.length) {
    // Open existing, completed caches for SELECTs only; never apply this lane's earlier-numbered migration to them.
    const nppes=new PGlite(join(root,'nppes-pglite-p3a')), geo=new PGlite(join(root,'geo-pglite')); opened.push(nppes,geo);
    const copyRows=async(table: string,rows: unknown[])=> {
      for(let i=0;i<rows.length;i+=500) await db!.query(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},$1::json) ON CONFLICT DO NOTHING`,[JSON.stringify(rows.slice(i,i+500))]);
    };
    for(const source of [nppes,geo]) {
      await copyRows('source',(await source.query('SELECT * FROM source')).rows);
      await copyRows('snapshot',(await source.query('SELECT * FROM snapshot')).rows);
    }
    for(const table of ['zcta_county','zcta_centroid','rating_area','geo_import']) await copyRows(table,(await geo.query(`SELECT * FROM ${table}`)).rows);
    const zips=(await geo.query<{zcta: string}>(`SELECT DISTINCT z.zcta FROM zcta_county z JOIN geo_import g ON z.snapshot_id=g.relationship_snapshot_id
      WHERE g.state='TX' AND z.county_fips=$1`,[county])).rows.map(z=>z.zcta);
    const providers=(await nppes.query(`SELECT p.* FROM npi_provider p WHERE p.in_scope AND EXISTS
      (SELECT 1 FROM npi_address a WHERE a.npi=p.npi AND a.kind='practice' AND a.state='TX' AND a.zip5=ANY($1::text[]))`,[zips])).rows;
    await copyRows('npi_provider',providers);
    await copyRows('npi_address',(await nppes.query(`SELECT a.* FROM npi_address a JOIN npi_provider p USING(npi)
      WHERE p.in_scope AND a.kind='practice' AND a.state='TX' AND a.zip5=ANY($1::text[])`,[zips])).rows);
    for(const source of opened) await source.close(); opened.length=0;
    console.log(JSON.stringify({prepared: true,providers:providers.length,zips:zips.length}));
  }
  const report=await ingestGeocode(db,{county,progress:console.log});
  const path=join(root,'reports','p3c-geocode-harris.json');
  await writeFile(path,JSON.stringify({database:dbPath,county,report},null,2)+'\n'); console.log(JSON.stringify({path,...report}));
} catch { console.error('Geocode file run failed; inspect Census availability, cache and schema'); process.exitCode=1; }
finally { for(const source of opened) await source.close(); await db?.close(); await rm(directory,{recursive:true,force:true}); }
