-- Count current identity points without reading issuer keys or coordinate heaps.
CREATE INDEX address_point_npi_source ON address_point(source_row,source_snapshot_id)
  WHERE source_table='npi_address';
CREATE INDEX npi_provider_in_scope ON npi_provider(npi) INCLUDE (entity_type,snapshot_id) WHERE in_scope;
CREATE INDEX npi_address_practice_count ON npi_address(npi,snapshot_id,(ordinal::text)) INCLUDE (ordinal) WHERE kind='practice';
