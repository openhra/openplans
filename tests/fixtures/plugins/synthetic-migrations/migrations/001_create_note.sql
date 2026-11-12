-- Synthetic fixture table. No source data. It references the core snapshot table, so it can
-- only run after the core migrations.
CREATE TABLE plg_synmig_note (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  snapshot_id text REFERENCES snapshot(snapshot_id),
  body text NOT NULL
);
