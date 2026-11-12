-- Which ingest run inserted a snapshot or changed its validation state, so that run's
-- `ingest.completed` event lists its own snapshots and never another run's. The worker puts the
-- run id in the `openplans.ingest_run` setting for the transaction that writes the snapshot;
-- writes without that setting record nothing.
CREATE TABLE ingest_run_snapshot (
  run_id text NOT NULL CHECK (run_id ~ '^[0-9a-f-]{36}$'),
  snapshot_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, snapshot_id)
);
INSERT INTO row_provenance_rule (table_name, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('ingest_run_snapshot', 'openplans', 'app:ingest_run_snapshot', 'application ingest run log', 'app_state');

CREATE FUNCTION ingest_run_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  run text := current_setting('openplans.ingest_run', true);
BEGIN
  IF run ~ '^[0-9a-f-]{36}$' THEN
    INSERT INTO ingest_run_snapshot (run_id, snapshot_id) VALUES (run, NEW.snapshot_id)
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER ingest_run_snapshot AFTER INSERT OR UPDATE OF validation_state ON snapshot
  FOR EACH ROW EXECUTE FUNCTION ingest_run_snapshot();
