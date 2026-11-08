-- An empty replacement rule set must revoke prior support, not fall back to an old rule.
CREATE TABLE rating_rule_document (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  -- Preserve the exact imported bytes even if a local source file is later edited.
  raw_text text NOT NULL
);
CREATE TABLE rating_rule_set (
  plan_year integer PRIMARY KEY CHECK (plan_year BETWEEN 2014 AND 9999),
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id)
);
