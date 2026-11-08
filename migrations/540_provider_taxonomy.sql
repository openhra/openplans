CREATE TABLE provider_taxonomy (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{10}$'),
  display_name text NOT NULL,
  classification text NOT NULL,
  specialization text,
  version text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id)
);
