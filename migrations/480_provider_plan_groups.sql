-- Dense publisher lists repeat the same hundreds of plans for every record. Store that
-- immutable list once; the public relation still exposes every original association ordinal.
ALTER TABLE qhp_provider_plan RENAME TO qhp_provider_plan_legacy;
CREATE TABLE provider_plan_group (
 group_id text PRIMARY KEY CHECK(group_id ~ '^[a-f0-9]{64}$')
);
CREATE TABLE provider_plan_group_edge (
 group_id text NOT NULL REFERENCES provider_plan_group(group_id),
 source_plan_index integer NOT NULL CHECK(source_plan_index>=0),
 base_hios_id text NOT NULL CHECK(base_hios_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
 plan_year integer NOT NULL, network_tier text NOT NULL,
 tier_status text NOT NULL CHECK(tier_status IN ('resolved','unresolved')),
 participation_scope text NOT NULL DEFAULT 'provider_record' CHECK(participation_scope='provider_record'),
 evidence_status text NOT NULL DEFAULT 'listed_participating'
 CHECK(evidence_status IN ('listed_participating','explicitly_not_participating')),
 PRIMARY KEY(group_id,source_plan_index)
);
CREATE INDEX provider_plan_group_lookup ON provider_plan_group_edge(base_hios_id,plan_year,group_id);
CREATE TABLE provider_record_plan_group (
 snapshot_id text NOT NULL, record_id text NOT NULL,
 group_id text NOT NULL REFERENCES provider_plan_group(group_id),
 PRIMARY KEY(snapshot_id,record_id),
 FOREIGN KEY(snapshot_id,record_id) REFERENCES qhp_provider_record(snapshot_id,record_id)
);
CREATE INDEX provider_record_plan_group_lookup ON provider_record_plan_group(group_id,snapshot_id,record_id);
-- Per-record overrides keep SQL updates/deletes independent of other records sharing a list.
CREATE TABLE provider_plan_suppressed (
 snapshot_id text NOT NULL, record_id text NOT NULL, source_plan_index integer NOT NULL CHECK(source_plan_index>=0),
 PRIMARY KEY(snapshot_id,record_id,source_plan_index),
 FOREIGN KEY(snapshot_id,record_id) REFERENCES qhp_provider_record(snapshot_id,record_id)
);
CREATE VIEW qhp_provider_plan AS
 SELECT * FROM qhp_provider_plan_legacy
 UNION ALL
 SELECT l.snapshot_id,l.record_id,e.source_plan_index,e.base_hios_id,e.plan_year,e.network_tier,e.tier_status,
   e.participation_scope,e.evidence_status
 FROM provider_record_plan_group l JOIN provider_plan_group_edge e USING(group_id)
 WHERE NOT EXISTS(SELECT 1 FROM qhp_provider_plan_legacy x WHERE x.snapshot_id=l.snapshot_id
   AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index)
 AND NOT EXISTS(SELECT 1 FROM provider_plan_suppressed x WHERE x.snapshot_id=l.snapshot_id
   AND x.record_id=l.record_id AND x.source_plan_index=e.source_plan_index);
ALTER VIEW qhp_provider_plan ALTER COLUMN participation_scope SET DEFAULT 'provider_record';
ALTER VIEW qhp_provider_plan ALTER COLUMN evidence_status SET DEFAULT 'listed_participating';
CREATE FUNCTION write_qhp_provider_plan() RETURNS trigger LANGUAGE plpgsql AS $$
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
   RETURN NEW;
 END IF;
 RETURN OLD;
END;
$$;
CREATE TRIGGER qhp_provider_plan_write INSTEAD OF INSERT OR UPDATE OR DELETE ON qhp_provider_plan
 FOR EACH ROW EXECUTE FUNCTION write_qhp_provider_plan();
