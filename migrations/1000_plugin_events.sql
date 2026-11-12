CREATE TABLE plugin_event_outbox (
  event_id text PRIMARY KEY CHECK (event_id ~ '^[0-9a-f-]{36}$'),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z_]+\.[a-z_]+$'),
  idempotency_key text NOT NULL UNIQUE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  emitted_by text NOT NULL,
  emitted_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);
CREATE TABLE plugin_event_delivery (
  event_id text NOT NULL REFERENCES plugin_event_outbox(event_id) ON DELETE CASCADE,
  subscriber text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error_code text,
  PRIMARY KEY (event_id, subscriber)
);
CREATE INDEX plugin_event_delivery_due ON plugin_event_delivery (next_attempt_at) WHERE delivered_at IS NULL;
INSERT INTO row_provenance_rule (table_name, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('plugin_event_outbox', 'openplans', 'app:plugin_event_outbox', 'application event log', 'app_state'),
  ('plugin_event_delivery', 'openplans', 'app:plugin_event_delivery', 'application delivery state', 'app_state');

CREATE TABLE plugin_state (
  plugin text,
  key text,
  value jsonb NOT NULL,
  PRIMARY KEY (plugin, key)
);
INSERT INTO row_provenance_rule (table_name, fixed_by, fixed_slug, reason, policy_name) VALUES
  ('plugin_state', 'openplans', 'app:plugin_state', 'application plugin state', 'app_state');

CREATE FUNCTION plugin_event_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_type text;
  payload jsonb;
  reason_code text;
BEGIN
  IF NEW.validation_state = 'ACTIVE' THEN
    event_type := 'snapshot.activated';
    -- Snapshots do not record imported row counts. Unknown is not zero.
    payload := jsonb_build_object('sourceId', NEW.source_id, 'snapshotId', NEW.snapshot_id, 'rows', NULL);
  ELSIF NEW.validation_state = 'QUARANTINED' THEN
    SELECT issue_code INTO reason_code FROM quality_issue
      WHERE snapshot_id = NEW.snapshot_id AND severity = 'error'
      ORDER BY quality_issue_id LIMIT 1;
    event_type := 'snapshot.quarantined';
    payload := jsonb_build_object('sourceId', NEW.source_id, 'snapshotId', NEW.snapshot_id,
      'reasonCode', coalesce(reason_code, 'unknown'));
  ELSE
    RETURN NEW;
  END IF;
  INSERT INTO plugin_event_outbox (event_id, event_type, idempotency_key, emitted_by, payload)
    VALUES (gen_random_uuid()::text, event_type,
      'snapshot:' || NEW.snapshot_id || ':' || NEW.validation_state, 'db', payload)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER plugin_event_snapshot AFTER UPDATE OF validation_state ON snapshot
  FOR EACH ROW EXECUTE FUNCTION plugin_event_snapshot();
