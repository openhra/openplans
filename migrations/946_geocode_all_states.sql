-- County outlines now come from the national Census boundary file, so geocoding admits all 50
-- states and DC. A geocoded point keeps the longitude the geocoder returned; an Alaskan point east
-- of 180 degrees is shifted only for the extent check.
ALTER TABLE geocode_tx_run DROP CONSTRAINT geocode_tx_run_state_check;
ALTER TABLE geocode_tx_run ADD CONSTRAINT geocode_run_state CHECK (state IN (
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
  'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'));
ALTER TABLE geocode_open_run DROP CONSTRAINT geocode_open_run_state_check;
ALTER TABLE geocode_open_run ADD CONSTRAINT geocode_open_run_state CHECK (state IN (
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR',
  'PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'));
-- Per-state extents (the same table as geocodeStates in counties.ts) plus the 0.5 degree margin.
-- Alaska's west edge runs past -180: Aleutian outlines are stored shifted by -360.
CREATE FUNCTION geocode_state_extent(fips text, OUT south float8, OUT north float8, OUT west float8, OUT east float8)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT s - 0.5, n + 0.5, w - 0.5, e + 0.5 FROM (VALUES
    ('01',30.1,35.1,-88.5,-84.9),
    ('02',51.2,71.5,-187.7,-129.9),
    ('04',31.3,37.0,-114.9,-109.0),
    ('05',33.0,36.5,-94.7,-89.6),
    ('06',32.5,42.0,-124.5,-114.1),
    ('08',37.0,41.0,-109.1,-102.0),
    ('09',40.9,42.1,-73.8,-71.8),
    ('10',38.4,39.9,-75.8,-75.0),
    ('11',38.79,39.0,-77.12,-76.9),
    ('12',24.4,31.0,-87.7,-79.9),
    ('13',30.3,35.0,-85.7,-80.8),
    ('15',18.9,28.5,-178.5,-154.8),
    ('16',42.0,49.0,-117.3,-111.0),
    ('17',36.97,42.5,-91.6,-87.0),
    ('18',37.77,41.76,-88.1,-84.78),
    ('19',40.37,43.5,-96.64,-90.14),
    ('20',36.99,40.0,-102.05,-94.59),
    ('21',36.49,39.15,-89.57,-81.96),
    ('22',28.9,33.02,-94.04,-88.8),
    ('23',42.97,47.46,-71.08,-66.95),
    ('24',37.9,39.72,-79.49,-75.05),
    ('25',41.24,42.89,-73.51,-69.93),
    ('26',41.7,48.3,-90.42,-82.4),
    ('27',43.5,49.38,-97.24,-89.49),
    ('28',30.17,35.0,-91.66,-88.1),
    ('29',35.99,40.61,-95.77,-89.1),
    ('30',44.36,49.0,-116.05,-104.04),
    ('31',40.0,43.0,-104.05,-95.31),
    ('32',35.0,42.0,-120.0,-114.04),
    ('33',42.7,45.31,-72.56,-70.6),
    ('34',38.93,41.36,-75.56,-73.89),
    ('35',31.33,37.0,-109.05,-103.0),
    ('36',40.5,45.02,-79.76,-71.86),
    ('37',33.8,36.59,-84.32,-75.46),
    ('38',45.93,49.0,-104.05,-96.55),
    ('39',38.4,41.98,-84.82,-80.52),
    ('40',33.62,37.0,-103.0,-94.43),
    ('41',41.99,46.29,-124.57,-116.46),
    ('42',39.72,42.27,-80.52,-74.69),
    ('44',41.15,42.02,-71.9,-71.12),
    ('45',32.03,35.22,-83.35,-78.54),
    ('46',42.48,45.95,-104.06,-96.44),
    ('47',34.98,36.68,-90.31,-81.65),
    ('48',25.84,36.5,-106.65,-93.51),
    ('49',37.0,42.0,-114.05,-109.04),
    ('50',42.73,45.02,-73.44,-71.46),
    ('51',36.54,39.47,-83.68,-75.24),
    ('53',45.54,49.0,-124.85,-116.92),
    ('54',37.2,40.64,-82.64,-77.72),
    ('55',42.49,47.31,-92.89,-86.25),
    ('56',41.0,45.0,-111.06,-104.05)
  ) AS t(f,s,n,w,e) WHERE f = fips
$$;
-- True when a box (or a point, with equal edges) lies inside its state's extent.
CREATE FUNCTION geocode_in_state(fips text, s float8, n float8, w float8, e float8)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE((SELECT s >= x.south AND n <= x.north AND w >= x.west AND e <= x.east
    FROM geocode_state_extent(substring(fips,1,2)) x WHERE x.south IS NOT NULL), false)
$$;
ALTER TABLE geocode_tx_county DROP CONSTRAINT geocode_county_state_bounds;
ALTER TABLE geocode_tx_county ADD CONSTRAINT geocode_county_extent CHECK (
  county_fips ~ '^[0-9]{5}$' AND geocode_in_state(county_fips,south,north,west,east)
);
ALTER TABLE geocode_tx_result DROP CONSTRAINT geocode_result_state_bounds;
ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_result_extent CHECK (latitude IS NULL OR
  geocode_in_state(county_fips,latitude,latitude,
    CASE WHEN county_fips LIKE '02%' AND longitude > 0 THEN longitude - 360 ELSE longitude END,
    CASE WHEN county_fips LIKE '02%' AND longitude > 0 THEN longitude - 360 ELSE longitude END)
);
-- Statewide staging pages any state now, so the cursor index no longer carries a state list.
CREATE INDEX qhp_provider_address_state_cursor_all
  ON qhp_provider_address(snapshot_id,state,record_id,address_index);
DROP INDEX qhp_provider_address_state_cursor;
