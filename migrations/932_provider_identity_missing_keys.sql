-- Canonical current-point keys share the practice-address index's NPI ordering.
CREATE INDEX address_point_npi_identity ON address_point
  ((split_part(source_row,':',1)),source_snapshot_id,(split_part(source_row,':',3))) INCLUDE (source_row)
  WHERE source_table='npi_address'
    AND source_row=split_part(source_row,':',1)||':practice:'||split_part(source_row,':',3);
-- Foreign-keyed practice addresses can exclude this set without joining every identity.
CREATE INDEX npi_provider_out_of_scope ON npi_provider(npi) WHERE NOT in_scope;
