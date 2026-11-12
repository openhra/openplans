-- A CMS Marketplace API attempt that got no response has no receipt. Its row now says
-- sourced_by 'openplans', sourced_slug 'cache:cms-api-attempt' and no sourced_at, as a failed
-- cms_zip_attempt row does, instead of 'unknown'.
--
-- The rule 990 inferred for this table keeps '{snapshot_id}' with no fixed value. Changing it
-- would mean rebuilding the table's row_provenance trigger, and a migration cannot do that
-- without review. Triggers run in name order, so this one runs after row_provenance and before
-- zz_record_policy, and the record policy sees the new sourced_by. Attempts with a snapshot_id
-- keep their receipt. Attempts logged before this migration keep 'unknown' until a later write.
CREATE FUNCTION row_provenance_cms_api_attempt_fallback() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('openplans.row_provenance_backfill', true) = 'on' THEN RETURN NEW; END IF;
  IF NEW.snapshot_id IS NULL THEN
    NEW.sourced_by := 'openplans';
    NEW.sourced_at := NULL;
    NEW.sourced_slug := 'cache:cms-api-attempt';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER row_provenance_fallback BEFORE INSERT OR UPDATE ON cms_api_attempt
  FOR EACH ROW EXECUTE FUNCTION row_provenance_cms_api_attempt_fallback();
COMMENT ON TRIGGER row_provenance_fallback ON cms_api_attempt IS
  'Attempts without a response: openplans, cache:cms-api-attempt';
