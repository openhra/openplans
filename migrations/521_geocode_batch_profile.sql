-- Preserve the exact Census request profile across interruptions and code/default changes.
-- Runs created before this migration used the geography response format.
ALTER TABLE geocode_tx_run ADD COLUMN return_type text NOT NULL DEFAULT 'geographies'
  CHECK(return_type IN ('locations','geographies'));
