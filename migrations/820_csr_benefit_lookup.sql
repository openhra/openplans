-- Detail enumerates all benefit variants for one base plan in an ACTIVE snapshot.
CREATE INDEX plan_benefit_base_lookup ON plan_benefit(snapshot_id, base_plan_id, published_plan_id);
