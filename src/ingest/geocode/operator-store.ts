import { mkdir,readFile,writeFile,rename,rm,access,realpath } from 'node:fs/promises';
import { join,resolve,dirname,relative,isAbsolute } from 'node:path';
import type { SqlSession } from '../../db/database.js';
import { dataDirectory } from './census.js';
import { validateOperatorPoint } from './operator.js';
import type { OperatorPoint } from './operator.js';
import type { County } from './counties.js';

export interface StoredOperatorPoint extends OperatorPoint { address_hash:string; bounds_snapshot_id:string }
async function storePath(root:string):Promise<string> {
  let absolute=resolve(root),missing:string[]=[];
  for(;;) {
    try{absolute=join(await realpath(absolute),...missing.reverse());break;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;missing.push(absolute.slice(dirname(absolute).length+1));absolute=dirname(absolute);}
  }
  // Private points must never land in any checkout, even when dataDir is misconfigured.
  for(let parent=absolute;;parent=dirname(parent)) {
    try{await access(join(parent,'.git'));throw new Error('Operator point store must be outside the repository');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(dirname(parent)===parent)break;
  }
  const rel=relative(resolve(import.meta.dirname,'../../..'),absolute);
  if(!rel.startsWith('..')&&!isAbsolute(rel))throw new Error('Operator point store must be outside the package');
  return join(absolute,'operator-geocoder','points.json');
}
export async function readOperatorPoints(root=dataDirectory(),env:NodeJS.ProcessEnv=process.env):Promise<StoredOperatorPoint[]> {
  if(env.OPENPLANS_GEOCODER_STORE!=='1')return [];
  try {
    const value:unknown=JSON.parse(await readFile(await storePath(root),'utf8'));
    return Array.isArray(value)?value.filter((p):p is StoredOperatorPoint=>p && p.source==='operator_geocoder'
      && /^[a-f0-9]{64}$/.test(p.address_hash) && typeof p.bounds_snapshot_id==='string'):[];
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
}
export async function storeOperatorPoints(points:StoredOperatorPoint[],counties:County[],root=dataDirectory(),env:NodeJS.ProcessEnv=process.env):Promise<number> {
  if(env.OPENPLANS_GEOCODER_STORE!=='1')return 0;
  if(points.some(p=>!validateOperatorPoint(p,counties)||!/^[a-f0-9]{64}$/.test(p.address_hash)
    || !counties.some(c=>c.county_fips===p.county_fips && c.snapshot_id===p.bounds_snapshot_id)))throw new Error('Operator point failed county validation');
  const path=await storePath(root),directory=dirname(path),lock=join(directory,'write.lock');
  await mkdir(directory,{recursive:true,mode:0o700});await mkdir(lock);
  const temp=`${path}.${process.pid}.part`;
  try {
    const all=new Map((await readOperatorPoints(root,env)).map(p=>[p.address_hash,p]));
    // Whitelist fields: caller objects and provider replies may carry credentials or restricted metadata.
    for(const p of points)all.set(p.address_hash,{address_hash:p.address_hash,latitude:p.latitude,longitude:p.longitude,
      county_fips:p.county_fips,source:'operator_geocoder',as_of:p.as_of,bounds_snapshot_id:p.bounds_snapshot_id});
    await writeFile(temp,JSON.stringify([...all.values()]),{mode:0o600});await rename(temp,path);
    return points.length;
  }finally{await rm(temp,{force:true});await rm(lock,{recursive:true,force:true});}
}
export async function searchOperatorPoints(db:SqlSession):Promise<StoredOperatorPoint[]> {
  // Shared response caches can be dumped separately from PostgreSQL. Private points never enter them.
  if(process.env.OPENPLANS_API_CACHE!=='off')return [];
  try {
    const points=await readOperatorPoints();if(!points.length)return [];
    const counties=(await db.query<County>('SELECT * FROM geocode_tx_county')).rows;
    return points.filter(p=>validateOperatorPoint(p,counties)
      && counties.some(c=>c.county_fips===p.county_fips && c.snapshot_id===p.bounds_snapshot_id));
  }catch{return [];}
}
