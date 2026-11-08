-- Preserve existing TX run identities and observations while admitting reviewed FL/NC geography.
ALTER TABLE geocode_tx_run ADD COLUMN state text NOT NULL DEFAULT 'TX'
  CHECK (state IN ('TX','FL','NC'));
ALTER TABLE geocode_tx_county DROP CONSTRAINT geocode_tx_county_county_fips_check;
ALTER TABLE geocode_tx_county DROP CONSTRAINT geocode_tx_county_check;
ALTER TABLE geocode_tx_county ADD CONSTRAINT geocode_county_state_bounds CHECK (
  (county_fips ~ '^48[0-9]{3}$' AND south > 25 AND north < 37 AND west > -107 AND east < -93)
  OR (county_fips ~ '^12[0-9]{3}$' AND south > 24 AND north < 32 AND west > -88 AND east < -79)
  OR (county_fips ~ '^37[0-9]{3}$' AND south > 33 AND north < 37 AND west > -85 AND east < -75)
);
ALTER TABLE geocode_tx_result DROP CONSTRAINT geocode_tx_result_check2;
ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_result_state_bounds CHECK (latitude IS NULL OR (
  (county_fips LIKE '48%' AND latitude > 25 AND latitude < 37 AND longitude > -107 AND longitude < -93)
  OR (county_fips LIKE '12%' AND latitude > 24 AND latitude < 32 AND longitude > -88 AND longitude < -79)
  OR (county_fips LIKE '37%' AND latitude > 33 AND latitude < 37 AND longitude > -85 AND longitude < -75)
));
