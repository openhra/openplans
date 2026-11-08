import { it, expect } from 'vitest';
import { checkPoints } from '../../scripts/oracle/geocode.mjs';
// Explicitly synthetic checker facts, not published address evidence.
const point={source_row:'synthetic',latitude:29.76,longitude:-95.36,method:'census_geocoder',match_status:'Match',match_quality:'Exact',centroid_snapshot_id:null};
it('checks every point against Texas bounds, refusing (0,0), swapped axes, NaN and empty input',()=>{
  expect(checkPoints([point])).toMatchObject({passed:true,points:1});
  expect(checkPoints([{...point,match_quality:'Non-Exact'}]).passed).toBe(true);
  for(const patch of [{latitude:0,longitude:0},{latitude:point.longitude,longitude:point.latitude},{latitude:NaN}])
    expect(checkPoints([point,{...point,...patch}]).passed).toBe(false);
  expect(checkPoints([]).passed).toBe(false);
});
it('requires explicit centroid method, match labels and snapshot provenance',()=>{
  const fallback={...point,method:'zcta_centroid',match_status:'No_Match',match_quality:null,centroid_snapshot_id:'synthetic-centroid'};
  expect(checkPoints([point,fallback])).toMatchObject({passed:true,centroid_fallbacks:1});
  for(const patch of [{centroid_snapshot_id:null},{match_quality:'Exact'},{match_status:'Match'},{method:'census_geocoder'}])
    expect(checkPoints([{...fallback,...patch}]).passed).toBe(false);
});
