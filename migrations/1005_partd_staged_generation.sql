-- Part D price rows are staged before they are served. stageLargeTable writes a release's unit
-- costs and dispensing-fee ranges in short transactions while the release's `tables` list does
-- not name them, and readers answer from them only once it does. Until now each of those
-- transactions moved the API data generation, so cached responses kept expiring through a load
-- that changes no answer.
--
-- From here on, a write to the three tables below moves the generation only when one of its rows,
-- before or after the write, belongs to a release that lists the table: `pricing` for the unit
-- costs and their release keys, `dispensing_fee` for the fee ranges. The check reads the rows of
-- the statement from its transition tables. Listing the tables, or withdrawing them after a failed
-- check, is an UPDATE of partd_release, and that table's own trigger moves the generation once.
-- TRUNCATE still always moves it. The shared bump_api_data_generation function is unchanged, and
-- every other table keeps its trigger. Only these three tables swap their row-write triggers to
-- bump_api_data_generation_partd_served, which refuses any other table.

-- True when a release among `snapshots` lists `served_table`. FOR SHARE waits for a listing that
-- another transaction is committing and then reads it, and makes a later listing wait until this
-- write commits, so no write lands between a listing and the generation it moved.
CREATE FUNCTION partd_price_rows_served(snapshots text[], served_table text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT coalesce(bool_or(listing.served), false) FROM (
    SELECT served_table = ANY (r.tables) AS served FROM partd_release r
    WHERE r.snapshot_id = ANY (snapshots) FOR SHARE OF r) listing
$$;

CREATE FUNCTION bump_api_data_generation_partd_served() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshots text[] := '{}';
BEGIN
  IF TG_TABLE_NAME = 'partd_plan_unit_cost' THEN
    IF TG_OP <> 'DELETE' THEN
      snapshots := snapshots || ARRAY(SELECT k.snapshot_id FROM partd_pricing_release k
        WHERE k.release_key IN (SELECT DISTINCT release_key FROM new_rows));
    END IF;
    IF TG_OP <> 'INSERT' THEN
      snapshots := snapshots || ARRAY(SELECT k.snapshot_id FROM partd_pricing_release k
        WHERE k.release_key IN (SELECT DISTINCT release_key FROM old_rows));
    END IF;
  ELSIF TG_TABLE_NAME IN ('partd_pricing_release', 'partd_dispensing_fee_range') THEN
    IF TG_OP <> 'DELETE' THEN
      snapshots := snapshots || ARRAY(SELECT DISTINCT snapshot_id FROM new_rows);
    END IF;
    IF TG_OP <> 'INSERT' THEN
      snapshots := snapshots || ARRAY(SELECT DISTINCT snapshot_id FROM old_rows);
    END IF;
  ELSE
    RAISE EXCEPTION 'bump_api_data_generation_partd_served: % is not a staged Part D price table', TG_TABLE_NAME;
  END IF;
  IF partd_price_rows_served(snapshots,
      CASE TG_TABLE_NAME WHEN 'partd_dispensing_fee_range' THEN 'dispensing_fee' ELSE 'pricing' END) THEN
    UPDATE api_data_generation SET revision=revision+1, writer_xid=txid_current()
      WHERE table_name=TG_TABLE_NAME AND writer_xid IS DISTINCT FROM txid_current();
  END IF;
  RETURN NULL;
END;
$$;

-- Each table's api_data_changed trigger (920, 1004) now fires on TRUNCATE only, through the shared
-- function, and three served-row triggers handle inserts, updates and deletes. A trigger with
-- transition tables takes one event, so each table gets three.
DROP TRIGGER api_data_changed ON partd_plan_unit_cost;
CREATE TRIGGER api_data_changed AFTER TRUNCATE ON partd_plan_unit_cost
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_served_insert AFTER INSERT ON partd_plan_unit_cost
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
CREATE TRIGGER api_data_served_update AFTER UPDATE ON partd_plan_unit_cost
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
CREATE TRIGGER api_data_served_delete AFTER DELETE ON partd_plan_unit_cost
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
DROP TRIGGER api_data_changed ON partd_pricing_release;
CREATE TRIGGER api_data_changed AFTER TRUNCATE ON partd_pricing_release
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_served_insert AFTER INSERT ON partd_pricing_release
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
CREATE TRIGGER api_data_served_update AFTER UPDATE ON partd_pricing_release
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
CREATE TRIGGER api_data_served_delete AFTER DELETE ON partd_pricing_release
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
DROP TRIGGER api_data_changed ON partd_dispensing_fee_range;
CREATE TRIGGER api_data_changed AFTER TRUNCATE ON partd_dispensing_fee_range
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER api_data_served_insert AFTER INSERT ON partd_dispensing_fee_range
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
CREATE TRIGGER api_data_served_update AFTER UPDATE ON partd_dispensing_fee_range
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
CREATE TRIGGER api_data_served_delete AFTER DELETE ON partd_dispensing_fee_range
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation_partd_served();
