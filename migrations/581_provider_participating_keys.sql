-- Exact membership counts and pre-page positive checks need only these record keys.
CREATE INDEX provider_plan_participating_lookup
 ON qhp_provider_plan_legacy(base_hios_id,plan_year,snapshot_id,record_id)
 WHERE evidence_status='listed_participating';
