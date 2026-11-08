-- Membership probes need the group and ordinal/status, not the publisher payload.
-- Cover both candidate-first probes and shard-scoped scans without scattered heap reads.
CREATE INDEX provider_record_plan_group_search
  ON provider_record_plan_group(snapshot_id,record_id) INCLUDE (group_id);
CREATE INDEX provider_plan_group_search
  ON provider_plan_group_edge(base_hios_id,plan_year,group_id)
  INCLUDE (source_plan_index,evidence_status);
-- Exact missing-point counts scan current shards independently of the radius.
CREATE INDEX address_point_provider_source
  ON address_point(source_snapshot_id,source_row) WHERE source_table='qhp_provider_address';
