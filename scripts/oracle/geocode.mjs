import { PGlite } from '@electric-sql/pglite';
import { access, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { database } from './negative-controls.mjs';

// Enclosing Texas bounding rectangle, WGS84 (deliberately not a county/state polygon).
export const TEXAS_BOUNDS={south:25.8,north:36.6,west:-106.7,east:-93.5};
export function checkPoints(points) {
  const errors=[];let fallbacks=0;
  for(const p of points) {
    if(!Number.isFinite(p.latitude)||!Number.isFinite(p.longitude)||p.latitude<TEXAS_BOUNDS.south||p.latitude>TEXAS_BOUNDS.north||p.longitude<TEXAS_BOUNDS.west||p.longitude>TEXAS_BOUNDS.east)
      errors.push({source_row:p.source_row,cause:'outside_texas_bounds'});
    if(p.method==='zcta_centroid') {
      fallbacks++;
      if(!p.centroid_snapshot_id||!['Tie','No_Match','rejected_out_of_bounds'].includes(p.match_status)||p.match_quality!==null)
        errors.push({source_row:p.source_row,cause:'unlabelled_centroid_fallback'});
    } else if(p.method!=='census_geocoder'||p.match_status!=='Match'||!['Exact','Non_Exact','Non-Exact'].includes(p.match_quality)||p.centroid_snapshot_id!==null)
      errors.push({source_row:p.source_row,cause:'invalid_geocode_label'});
  }
  return {passed:points.length>0&&!errors.length,points:points.length,centroid_fallbacks:fallbacks,errors};
}
export async function runGeocodeOracle(cache,scratch) {
  const path=process.env.OPENPLANS_GEOCODE_DB ?? join(cache,'geocode-pglite-p3c');
  await access(path);
  const db=database(new PGlite(path));
  let points;
  try { points=(await db.query(`SELECT source_row,latitude,longitude,method,match_status,match_quality,centroid_snapshot_id FROM address_point ORDER BY source_row`)).rows; }
  finally { await db.close(); }
  const result=checkPoints(points);
  const mutant=structuredClone(points);if(!mutant.length) throw new Error('No geocode points for control');
  mutant[0].latitude=0;mutant[0].longitude=0;
  const copy=join(scratch,'geocode-zero-point.json');await writeFile(copy,JSON.stringify(mutant));
  const broken=checkPoints(JSON.parse(await readFile(copy,'utf8')));
  result.negative_controls=[{name:'point_moved_to_0_0',passed:result.passed&&!broken.passed&&broken.errors.some(e=>e.cause==='outside_texas_bounds'),mutant_errors:broken.errors.length,scope:'temporary point copy'}];
  result.passed=result.passed&&result.negative_controls.every(c=>c.passed);
  result.bounds=TEXAS_BOUNDS;result.database=path;
  await writeFile(join(cache,'reports','h2-geocode-oracle.json'),JSON.stringify(result,null,2)+'\n');
  console.log(`geocode oracle: ${result.points} points; ${result.centroid_fallbacks} labelled fallbacks; ${result.errors.length} errors`);
  return result;
}
