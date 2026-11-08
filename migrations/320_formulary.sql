-- Publication attempts are separate from immutable acquisition snapshots.
CREATE TABLE formulary_source_set (
  snapshot_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  issuer_id text NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  discovery_id text,
  catalog_snapshot_id text REFERENCES snapshot(snapshot_id)
);
CREATE TABLE formulary_shard (
  source_set_id text NOT NULL REFERENCES formulary_source_set(snapshot_id),
  child_id bigint NOT NULL REFERENCES qhp_child_url(qhp_child_url_id),
  snapshot_id text NOT NULL UNIQUE REFERENCES snapshot(snapshot_id),
  raw_snapshot_id text REFERENCES snapshot(snapshot_id),
  status text NOT NULL CHECK (status IN ('complete','partial','failed')),
  reason text,
  record_count integer NOT NULL DEFAULT 0,
  edge_count integer NOT NULL DEFAULT 0,
  PRIMARY KEY(source_set_id,child_id)
);
CREATE TABLE formulary_edge (
  snapshot_id text NOT NULL REFERENCES formulary_shard(snapshot_id),
  source_record bigint NOT NULL CHECK (source_record >= 0),
  source_plan_index integer NOT NULL CHECK (source_plan_index >= 0),
  rxcui text NOT NULL CHECK (rxcui ~ '^[0-9]+$'),
  base_hios_id text NOT NULL CHECK (base_hios_id ~ '^[0-9]{5}[A-Z]{2}[0-9]{7}$'),
  plan_year integer NOT NULL,
  drug_tier text NOT NULL,
  prior_authorization boolean,
  step_therapy boolean,
  quantity_limit boolean,
  evidence_status text NOT NULL DEFAULT 'listed_covered'
    CHECK (evidence_status IN ('listed_covered','explicitly_not_covered')),
  source_updated_at text,
  PRIMARY KEY(snapshot_id,source_record,source_plan_index)
);
CREATE INDEX formulary_edge_lookup ON formulary_edge(base_hios_id,plan_year,rxcui,snapshot_id);
CREATE TABLE formulary_active_set (
  issuer_id text NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  snapshot_id text NOT NULL REFERENCES formulary_source_set(snapshot_id),
  PRIMARY KEY(issuer_id,plan_year,state)
);
CREATE TABLE qhp_coverage_manifest (
  issuer_id text NOT NULL,
  plan_year integer NOT NULL,
  state text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('drug','provider')),
  status text NOT NULL CHECK (status IN ('complete','partial','failed')),
  reason text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  expected_children integer NOT NULL,
  complete_children integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(issuer_id,plan_year,state,kind)
);
