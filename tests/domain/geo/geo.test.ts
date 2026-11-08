import { it,expect } from 'vitest';
import { haversineMiles,zipCentroid,pointsWithinRadius,createGeoRepository } from '../../../src/domain/geo/index.js';
import { ingestGeocode } from '../../../src/ingest/geocode/index.js';
import { parseBatch } from '../../../src/ingest/geocode/parse.js';
import { setup,raw } from '../../ingest/geocode/helpers.js';
it('known Houston City Hall ↔ TMC distance is about four miles; swapped lat/lon mutant fails',async()=>{
  const parsed=await parseBatch(await raw()),a=parsed.rows.get('1')!,b=parsed.rows.get('2')!;
  expect(Math.abs(haversineMiles(a.latitude!,a.longitude!,b.latitude!,b.longitude!)-4)).toBeLessThan(0.1);
  expect(()=>haversineMiles(a.longitude!,a.latitude!,b.longitude!,b.latitude!)).toThrow('Invalid');
  expect(haversineMiles(a.latitude!,a.longitude!,a.latitude!,a.longitude!)).toBe(0);
});
it('radius includes current address points with provenance; centroid lookup has honest unknowns',async()=>{
  const h=await setup();
  try {
    await ingestGeocode(h.db,{acquire:async()=>({file:await h.file(await raw()),requests:1})});
    const a=(await parseBatch(await raw())).rows.get('1')!;
    const repo=createGeoRepository(h.db);
    const near=await repo.pointsWithinRadius(a.latitude!,a.longitude!,4.1);
    expect(near.map(p=>p.source_row)).toEqual(['1000000000:practice:0','1000000001:practice:0']);
    expect(near.every(p=>p.method==='census_geocoder' && !!p.snapshot_id)).toBe(true);
    expect(await repo.zipCentroid('77001')).toBeNull();
    const centroid=await zipCentroid(h.db,'77356');expect(centroid?.method).toBe('zcta_centroid');
    expect((await pointsWithinRadius(h.db,centroid!.latitude,centroid!.longitude,0))[0]).toMatchObject({method:'zcta_centroid',match_status:'No_Match'});
    await h.db.query("UPDATE npi_address SET snapshot_id='new-input' WHERE npi='1000000001'");
    expect(await repo.pointsWithinRadius(a.latitude!,a.longitude!,4.1)).toHaveLength(1);
    await expect(pointsWithinRadius(h.db,91,0,4)).rejects.toThrow();
    await expect(pointsWithinRadius(h.db,0,0,-1)).rejects.toThrow();
    await expect(zipCentroid(h.db,'1234')).rejects.toThrow();
  }finally{await h.cleanup();}
});
