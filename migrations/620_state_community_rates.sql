-- State-source staging is separate from the CMS PUF catalog. No implicit support grant.
CREATE TABLE state_rate_import (
  import_id text PRIMARY KEY REFERENCES snapshot(snapshot_id),
  state text NOT NULL CHECK (state IN ('NY','VT')),
  plan_year integer NOT NULL CHECK (plan_year = 2026),
  rules_document jsonb NOT NULL,
  artifact_sha256 text NOT NULL CHECK (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  record_count integer NOT NULL CHECK (record_count > 0),
  UNIQUE (import_id,state,plan_year)
);
CREATE TABLE state_community_rate (
  import_id text NOT NULL REFERENCES state_rate_import(import_id),
  source_index integer NOT NULL,
  record_index integer NOT NULL,
  publication_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  plan_key text NOT NULL,
  region text NOT NULL,
  rate jsonb NOT NULL,
  raw_record jsonb NOT NULL,
  PRIMARY KEY (import_id,source_index,record_index)
);
CREATE INDEX state_community_rate_lookup ON state_community_rate(import_id,plan_key,region);
CREATE TABLE state_rate_active (
  state text NOT NULL,
  plan_year integer NOT NULL,
  import_id text NOT NULL,
  PRIMARY KEY (state,plan_year),
  FOREIGN KEY (import_id,state,plan_year) REFERENCES state_rate_import(import_id,state,plan_year)
);
