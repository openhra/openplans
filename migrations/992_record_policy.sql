-- Metadata-only column installation. Large heaps keep their relfilenode and size.
CREATE TABLE record_policy (
  name text PRIMARY KEY,
  default_ttl interval CHECK (default_ttl >= interval '0'),
  stale_window interval NOT NULL DEFAULT interval '0' CHECK (stale_window >= interval '0'),
  description text NOT NULL
);
INSERT INTO record_policy(name,default_ttl,stale_window,description) VALUES
 ('source_snapshot',NULL,'0','Imported public data; validity follows snapshot activation'),
 ('app_state',NULL,'0','Application state written by OpenPlans'),
 ('cms_api_fallback','7 days','30 days','CMS Marketplace API coverage answers'),
 ('cms_api_fallback_no_data','1 day','30 days','CMS Marketplace API DataNotProvided answers'),
 ('unknown',NULL,'0','No known source');
ALTER TABLE row_provenance_rule ADD COLUMN policy_name text REFERENCES record_policy(name);
UPDATE row_provenance_rule SET policy_name = CASE
  WHEN table_name IN ('cms_api_drug_coverage','cms_api_provider_coverage') THEN 'cms_api_fallback'
  WHEN cardinality(reference_columns)>0 THEN 'source_snapshot'
  WHEN fixed_by='openplans' THEN 'app_state' ELSE 'unknown' END;
INSERT INTO row_provenance_rule(table_name,fixed_by,fixed_slug,reason,policy_name)
VALUES ('record_policy','openplans','app:record-policy','operator expiry policies','app_state');

CREATE FUNCTION record_policy_for(target text, source_name text, coverage_name text) RETURNS text
LANGUAGE sql STABLE AS $$
 SELECT CASE WHEN target IN ('cms_api_drug_coverage','cms_api_provider_coverage')
   THEN CASE WHEN coverage_name='DataNotProvided' THEN 'cms_api_fallback_no_data' ELSE 'cms_api_fallback' END
   WHEN source_name='unknown' THEN 'unknown'
   ELSE coalesce((SELECT policy_name FROM row_provenance_rule WHERE table_name=target),
     CASE WHEN source_name='openplans' THEN 'app_state' ELSE 'source_snapshot' END) END
$$;

CREATE FUNCTION apply_record_policy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ttl interval;
  deadline timestamptz;
  reset boolean := false;
  derived text;
  coverage_name text;
  coverage_changed boolean := false;
BEGIN
  IF TG_TABLE_NAME IN ('cms_api_drug_coverage','cms_api_provider_coverage') THEN
    coverage_name := to_jsonb(NEW)->>'coverage';
    IF TG_OP='UPDATE' THEN coverage_changed := coverage_name IS DISTINCT FROM (to_jsonb(OLD)->>'coverage'); END IF;
  END IF;
  derived := record_policy_for(TG_TABLE_NAME, NEW.sourced_by, coverage_name);
  IF TG_OP='INSERT' THEN
    -- The heap default classifies old rows. New writes use the current rule, even when
    -- an operator changed it after this table received its constant default.
    NEW.record_policy := derived;
    reset := true;
  ELSE
    reset := ROW(NEW.sourced_by,NEW.sourced_slug,NEW.sourced_at) IS DISTINCT FROM
      ROW(OLD.sourced_by,OLD.sourced_slug,OLD.sourced_at);
    IF reset OR coverage_changed THEN
      NEW.record_policy := derived;
      IF NEW.record_ttl IS NOT DISTINCT FROM OLD.record_ttl THEN NEW.record_ttl := NULL; END IF;
      reset := true;
    END IF;
    IF NEW.record_policy IS DISTINCT FROM OLD.record_policy THEN
      IF NEW.record_ttl IS NOT DISTINCT FROM OLD.record_ttl THEN NEW.record_ttl := NULL; END IF;
      reset := true;
    END IF;
  END IF;
  -- Coverage rows always use their coverage policy, even if a caller supplies another name.
  IF TG_TABLE_NAME IN ('cms_api_drug_coverage','cms_api_provider_coverage') THEN
    NEW.record_policy := derived;
  END IF;
  SELECT default_ttl INTO ttl FROM record_policy WHERE name=NEW.record_policy;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown record policy: %',NEW.record_policy; END IF;
  IF NEW.record_ttl < interval '0' THEN RAISE EXCEPTION 'Negative record ttl'; END IF;
  NEW.record_ttl := CASE WHEN NEW.record_ttl IS NULL THEN ttl
    WHEN ttl IS NULL THEN NEW.record_ttl ELSE least(NEW.record_ttl,ttl) END;
  -- Calendar intervals can compare equally while ending on different dates.
  IF ttl IS NOT NULL AND coalesce(NEW.sourced_at,NEW.created_at)+NEW.record_ttl >
    coalesce(NEW.sourced_at,NEW.created_at)+ttl THEN NEW.record_ttl := ttl; END IF;
  deadline := coalesce(NEW.sourced_at,NEW.created_at) + NEW.record_ttl;
  -- A writer may shorten expiry. A source/policy change starts a new validity period.
  IF reset THEN NEW.expired_at := deadline;
  ELSIF deadline IS NOT NULL THEN
    NEW.expired_at := least(coalesce(NEW.expired_at,deadline),deadline);
  END IF;
  IF TG_TABLE_NAME IN ('cms_api_drug_coverage','cms_api_provider_coverage') THEN
    NEW := jsonb_populate_record(NEW,jsonb_build_object('expires_at',NEW.expired_at));
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION install_record_policy_all() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE t text; policy text; done text[] := '{}';
BEGIN
 FOR t IN SELECT c.relname FROM pg_class c
   WHERE c.relnamespace=current_schema()::regnamespace AND c.relkind IN ('r','p')
     AND NOT row_provenance_excluded(c.relname)
     AND ((SELECT count(*) FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped
       AND a.attname IN ('record_policy','record_ttl','expired_at'))<3
       OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid=c.oid AND g.tgname='zz_record_policy'))
   ORDER BY c.relname
 LOOP
   UPDATE row_provenance_rule SET policy_name=CASE
     WHEN cardinality(reference_columns)>0 THEN 'source_snapshot'
     WHEN fixed_by='openplans' THEN 'app_state' ELSE 'unknown' END
     WHERE table_name=t AND policy_name IS NULL;
   SELECT coalesce(policy_name,'unknown') INTO policy FROM row_provenance_rule WHERE table_name=t;
   EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS record_policy text NOT NULL DEFAULT %L,
     ADD COLUMN IF NOT EXISTS record_ttl interval, ADD COLUMN IF NOT EXISTS expired_at timestamptz',t,policy);
   EXECUTE format('DROP TRIGGER IF EXISTS zz_record_policy ON %I',t);
   EXECUTE format('CREATE TRIGGER zz_record_policy BEFORE INSERT OR UPDATE ON %I
     FOR EACH ROW EXECUTE FUNCTION apply_record_policy()',t);
   IF to_regproc('backfill_row_provenance_receipts') IS NOT NULL THEN
     PERFORM backfill_small_row_provenance(t);
   END IF;
   done := done || t;
 END LOOP;
 RETURN done;
END $$;
SELECT install_row_provenance_all();
SELECT install_record_policy_all();
-- Nullable legacy aliases are needed when the operator selects a policy with no expiry.
ALTER TABLE cms_api_drug_coverage ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE cms_api_provider_coverage ALTER COLUMN expires_at DROP NOT NULL;

-- Reuse the provenance command's bounded heap-block batches. It also fills policy metadata
-- for rows whose provenance was already filled before this migration.
ALTER FUNCTION backfill_row_provenance(text,bigint,bigint) RENAME TO backfill_row_provenance_receipts;
CREATE FUNCTION backfill_row_provenance(target text, first_block bigint, blocks bigint)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE changed bigint; more bigint;
BEGIN
 changed := backfill_row_provenance_receipts(target,first_block,blocks);
 -- Late migrations install provenance before expiry columns. The policy installer fills
 -- their small tables after it adds the columns; large tables wait for the worker batches.
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
   AND table_name=target AND column_name='record_policy') THEN RETURN changed; END IF;
 EXECUTE format('UPDATE %I SET record_policy=CASE WHEN record_policy=''unknown''
     OR %L IN (''cms_api_drug_coverage'',''cms_api_provider_coverage'')
     THEN record_policy_for(%L,sourced_by,to_jsonb(%I)->>''coverage'') ELSE record_policy END,
   record_ttl=NULL,expired_at=NULL
   WHERE ctid >= %L::tid AND ctid < %L::tid AND
     ((record_policy=''unknown'' OR %L IN (''cms_api_drug_coverage'',''cms_api_provider_coverage''))
       AND record_policy IS DISTINCT FROM record_policy_for(%L,sourced_by,to_jsonb(%I)->>''coverage'')
       OR (record_ttl IS NULL AND record_policy IN (SELECT name FROM record_policy WHERE default_ttl IS NOT NULL)))',
   target,target,target,target,format('(%s,0)',first_block),format('(%s,0)',first_block+blocks),target,target,target);
 GET DIAGNOSTICS more = ROW_COUNT;
 RETURN changed+more;
END $$;
-- Only the fallback tables need immediate TTL initialization. Official tables already
-- have their constant policy default and NULL validity fields; no data UPDATE is needed there.
SELECT backfill_row_provenance('cms_api_drug_coverage',0,
 pg_relation_size('cms_api_drug_coverage')/current_setting('block_size')::bigint+1);
SELECT backfill_row_provenance('cms_api_provider_coverage',0,
 pg_relation_size('cms_api_provider_coverage')/current_setting('block_size')::bigint+1);
INSERT INTO api_data_generation(table_name) VALUES ('record_policy');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON record_policy
 FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
