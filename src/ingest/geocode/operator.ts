import type { Address } from './address.js';
import { countyAt, insideBounds } from './counties.js';
import type { County } from './counties.js';

export interface OperatorPoint {
  latitude:number; longitude:number; county_fips:string; source:'operator_geocoder'; as_of:string;
}
export interface OperatorGeocoder { geocode(address:Address):Promise<OperatorPoint|null> }
const jsonPath=(value:unknown,path:string):unknown => path.split('.').reduce<unknown>((v,k)=>
  v!==null && typeof v==='object' && Object.hasOwn(v,k) ? (v as Record<string,unknown>)[k] : undefined,value);
export function validateOperatorPoint(point:OperatorPoint,counties:County[]):boolean {
  const claimed=counties.find(c=>c.county_fips===point.county_fips);
  return point.source==='operator_geocoder' && typeof point.as_of==='string' && /^\d{4}-\d{2}-\d{2}$/.test(point.as_of)
    && Number.isFinite(Date.parse(point.as_of)) && new Date(point.as_of).toISOString().slice(0,10)===point.as_of
    && !!claimed && insideBounds(point.latitude,point.longitude,claimed)
    && countyAt(point.latitude,point.longitude,[claimed])!==undefined;
}
export function assertNoGeocoderKey(log:string,key:string):void {
  if(key && [key,encodeURIComponent(key)].some(k=>log.includes(k)))throw new Error('Geocoder key found in log');
}

/** The URL and JSON paths come only from operator environment settings. Never retain the reply or URL. */
export function operatorGeocoder(env:NodeJS.ProcessEnv=process.env,options:{sleep?:(ms:number)=>Promise<void>;log?:(message:string)=>void}={}):OperatorGeocoder|null {
  if(!env.OPENPLANS_GEOCODER_URL)return null;
  const template:string=env.OPENPLANS_GEOCODER_URL;
  const key=env.OPENPLANS_GEOCODER_KEY??'',latPath=env.OPENPLANS_GEOCODER_LAT_PATH??'latitude',
    lonPath=env.OPENPLANS_GEOCODER_LON_PATH??'longitude',countyPath=env.OPENPLANS_GEOCODER_COUNTY_PATH??'county_fips';
  const interval=Number(env.OPENPLANS_GEOCODER_INTERVAL_MS??1000);
  if(!Number.isFinite(interval)||interval<1000)throw new Error('Geocoder interval must be at least 1000 ms');
  const sleep=options.sleep??(ms=>new Promise(r=>setTimeout(r,ms)));
  let last=0,tail:Promise<unknown>=Promise.resolve();
  async function run(address:Address):Promise<OperatorPoint|null> {
    const values:Record<string,string>={key,address:[address.line_1,address.line_2,address.city,address.state,address.zip5].filter(Boolean).join(', '),
      line1:address.line_1??'',line2:address.line_2??'',city:address.city??'',state:address.state,zip:address.zip5??''};
    try {
      const url=new URL(template.replace(/\{(key|address|line1|line2|city|state|zip)\}/g,(_,name:string)=>encodeURIComponent(values[name]!)));
      if(url.username||url.password||url.hash || (url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname))))
        throw new Error('Invalid operator endpoint');
      const wait=interval-(Date.now()-last);if(wait>0)await sleep(wait);last=Date.now();
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(10_000),headers:{accept:'application/json'}});
      if(!response.ok || !response.headers.get('content-type')?.includes('application/json')){await response.body?.cancel();throw new Error('Invalid operator response');}
      const reader=response.body?.getReader();if(!reader)throw new Error('Empty operator response');
      const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>65536)throw new Error('Oversized operator response');chunks.push(part.value);}}
      finally{await reader.cancel();}
      const json:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const latitude=jsonPath(json,latPath),longitude=jsonPath(json,lonPath),county=jsonPath(json,countyPath);
      if(typeof latitude!=='number'||typeof longitude!=='number'||typeof county!=='string'
        || !Number.isFinite(latitude)||!Number.isFinite(longitude)||Math.abs(latitude)>90||Math.abs(longitude)>180||!/^\d{5}$/.test(county))return null;
      return {latitude,longitude,county_fips:county,source:'operator_geocoder',as_of:new Date().toISOString().slice(0,10)};
    } catch {
      const message='Operator geocoder request failed; fallback retained';
      // Fixed messages can still collide with an unusual secret value. In that case emit nothing.
      if(!key || ![key,encodeURIComponent(key)].some(k=>message.includes(k)))options.log?.(message);
      return null;
    }
  }
  return {geocode(address){const task=tail.then(()=>run(address));tail=task.catch(()=>{});return task;}};
}
