-- Keep the complete association history available for ingestion/audits, and make the
-- API's existing current-source restriction effective before evidence aggregation.
ALTER VIEW qhp_provider_plan RENAME TO qhp_provider_plan_all;
CREATE VIEW qhp_provider_plan AS
 SELECT e.* FROM qhp_provider_plan_all e JOIN provider_shard f ON f.snapshot_id=e.snapshot_id
 JOIN provider_active_set a ON a.snapshot_id=f.source_set_id
 JOIN snapshot s ON s.snapshot_id=f.snapshot_id AND s.validation_state='ACTIVE';
ALTER VIEW qhp_provider_plan ALTER COLUMN participation_scope SET DEFAULT 'provider_record';
ALTER VIEW qhp_provider_plan ALTER COLUMN evidence_status SET DEFAULT 'listed_participating';
CREATE TRIGGER qhp_provider_plan_write INSTEAD OF INSERT OR UPDATE OR DELETE ON qhp_provider_plan
 FOR EACH ROW EXECUTE FUNCTION write_qhp_provider_plan();
