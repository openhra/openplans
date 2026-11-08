-- State-first keyset pages avoid rereading unrelated locations in a multi-state cache.
CREATE INDEX npi_practice_state_cursor ON npi_address(state,npi,kind,ordinal) WHERE kind='practice';
CREATE INDEX qhp_provider_address_state_cursor ON qhp_provider_address(snapshot_id,state,record_id,address_index)
  WHERE state IN ('TX','FL','NC');

ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_point_county_required CHECK (latitude IS NULL OR county_fips IS NOT NULL);
