-- Cover normalized wire locations before fetching full page addresses.
CREATE INDEX npi_address_practice_location ON npi_address(npi,snapshot_id,ordinal,
  (ARRAY[upper(btrim(regexp_replace(coalesce(line_1,''),U&'[\0009-\000d \00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+',' ','g')) COLLATE "und-x-icu"),
    upper(btrim(regexp_replace(coalesce(line_2,''),U&'[\0009-\000d \00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+',' ','g')) COLLATE "und-x-icu"),
    upper(btrim(regexp_replace(coalesce(city,''),U&'[\0009-\000d \00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+',' ','g')) COLLATE "und-x-icu"),
    upper(btrim(regexp_replace(coalesce(state,''),U&'[\0009-\000d \00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+',' ','g')) COLLATE "und-x-icu"),
    upper(btrim(regexp_replace(coalesce(zip5,''),U&'[\0009-\000d \00a0\1680\2000-\200a\2028\2029\202f\205f\3000\feff]+',' ','g')) COLLATE "und-x-icu")])) INCLUDE (line_1,line_2,city,state,zip5) WHERE kind='practice';
