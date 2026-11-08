-- Keep the dense view's anti-join independent of millions of ordinary sparse associations.
CREATE TABLE provider_plan_override (
 snapshot_id text NOT NULL, record_id text NOT NULL, source_plan_index integer NOT NULL,
 PRIMARY KEY(snapshot_id,record_id,source_plan_index),
 FOREIGN KEY(snapshot_id,record_id,source_plan_index)
   REFERENCES qhp_provider_plan_legacy(snapshot_id,record_id,source_plan_index) ON DELETE CASCADE
);
INSERT INTO provider_plan_override
 SELECT l.snapshot_id,l.record_id,e.source_plan_index FROM provider_record_plan_group l
 CROSS JOIN LATERAL (SELECT e.source_plan_index FROM qhp_provider_plan_legacy e
   WHERE e.snapshot_id=l.snapshot_id AND e.record_id=l.record_id OFFSET 0) e;
CREATE OR REPLACE VIEW qhp_provider_plan AS
 SELECT * FROM qhp_provider_plan_legacy
 UNION ALL
 SELECT l.snapshot_id,l.record_id,e.source_plan_index,e.base_hios_id,e.plan_year,e.network_tier,e.tier_status,
   e.participation_scope,e.evidence_status
 FROM provider_record_plan_group l JOIN provider_plan_group_edge e USING(group_id)
 WHERE NOT EXISTS(SELECT 1 FROM provider_plan_override x WHERE x.snapshot_id=l.snapshot_id
   AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index)
 AND NOT EXISTS(SELECT 1 FROM provider_plan_suppressed x WHERE x.snapshot_id=l.snapshot_id
   AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index);
CREATE OR REPLACE FUNCTION write_qhp_provider_plan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN
   INSERT INTO provider_plan_suppressed VALUES(OLD.snapshot_id,OLD.record_id,OLD.source_plan_index) ON CONFLICT DO NOTHING;
   DELETE FROM qhp_provider_plan_legacy WHERE snapshot_id=OLD.snapshot_id AND record_id=OLD.record_id
     AND source_plan_index=OLD.source_plan_index;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
   DELETE FROM provider_plan_suppressed WHERE snapshot_id=NEW.snapshot_id AND record_id=NEW.record_id
     AND source_plan_index=NEW.source_plan_index;
   INSERT INTO qhp_provider_plan_legacy VALUES(NEW.snapshot_id,NEW.record_id,NEW.source_plan_index,NEW.base_hios_id,
     NEW.plan_year,NEW.network_tier,NEW.tier_status,NEW.participation_scope,NEW.evidence_status)
   ON CONFLICT(snapshot_id,record_id,source_plan_index) DO UPDATE SET base_hios_id=excluded.base_hios_id,
     plan_year=excluded.plan_year,network_tier=excluded.network_tier,tier_status=excluded.tier_status,
     participation_scope=excluded.participation_scope,evidence_status=excluded.evidence_status;
   INSERT INTO provider_plan_override VALUES(NEW.snapshot_id,NEW.record_id,NEW.source_plan_index) ON CONFLICT DO NOTHING;
   RETURN NEW;
 END IF;
 RETURN OLD;
END;
$$;
ANALYZE provider_plan_override;
ANALYZE provider_plan_suppressed;
ANALYZE provider_plan_group;
ANALYZE provider_plan_group_edge;
ANALYZE provider_record_plan_group;
ANALYZE provider_active_set;
ANALYZE provider_source_set;
ANALYZE provider_shard;
ANALYZE snapshot;
ANALYZE address_point;
