-- Synthetic feed fixture tables, applied only to a test database's copy of the migrations.
CREATE TABLE synthetic_feed_item (
  item_code text PRIMARY KEY,
  label text NOT NULL,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id)
);
INSERT INTO api_data_generation(table_name) VALUES ('synthetic_feed_item');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON synthetic_feed_item
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();

-- No change trigger: a feed that writes here must fail core readiness.
CREATE TABLE synthetic_feed_untracked (
  item_code text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id)
);
