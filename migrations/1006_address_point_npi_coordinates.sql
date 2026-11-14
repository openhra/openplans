-- Identity name searches measure candidate points from this index without reading the table.
CREATE INDEX CONCURRENTLY address_point_npi_coordinates ON address_point(source_row,source_snapshot_id)
  INCLUDE (latitude,longitude) WHERE source_table='npi_address';
