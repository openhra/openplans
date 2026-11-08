-- Share normalized address evidence while retaining each publisher's row/snapshot provenance.
ALTER TABLE geocode_attempt DROP CONSTRAINT geocode_attempt_source_table_check;
ALTER TABLE geocode_attempt ADD CONSTRAINT geocode_attempt_source_table_check
  CHECK (source_table IN ('npi_address','qhp_provider_address'));
CREATE INDEX geocode_attempt_reuse ON geocode_attempt(address_hash) WHERE outcome <> 'issue';
CREATE INDEX address_point_source ON address_point(source_table,source_row,source_snapshot_id);
CREATE INDEX qhp_provider_address_zip ON qhp_provider_address(state,(substring(zip,1,5)),record_id,snapshot_id);
