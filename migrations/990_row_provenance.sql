-- Every table row records when this database wrote it and which fetch receipt it came from:
-- created_at, updated_at, sourced_by (snapshot.source_id), sourced_at (snapshot.retrieved_at)
-- and sourced_slug (snapshot_id). Rows OpenPlans makes itself say so ('openplans' with an
-- app:, job:, derived: or registry: slug). A row without a known receipt says 'unknown'.
-- Columns are added with constant or stable defaults, so no table is rewritten; existing rows
-- in large tables are filled later in batches by `worker backfill row-provenance`.

-- How each table finds its receipt. Tables without a row here are inferred on install.
CREATE TABLE row_provenance_rule (
  table_name text PRIMARY KEY,
  reference_columns text[] NOT NULL DEFAULT '{}',
  fixed_by text,
  fixed_slug text,
  reason text NOT NULL,
  CHECK ((fixed_by IS NULL) = (fixed_slug IS NULL)),
  CHECK (cardinality(reference_columns) > 0 OR fixed_by IS NOT NULL OR reason LIKE 'inferred:%')
);
INSERT INTO row_provenance_rule(table_name,reference_columns,fixed_by,fixed_slug,reason) VALUES
 ('schema_migrations','{}','openplans','app:schema-migrations','migration journal'),
 ('row_provenance_rule','{}','openplans','app:row-provenance-rule','this registry'),
 ('api_data_generation','{}','openplans','app:api-data-generation','cache revision counters'),
 ('cms_zip_budget','{}','openplans','app:cms-zip-budget','request budget state'),
 ('cms_api_budget','{}','openplans','app:cms-api-budget','request budget state'),
 ('source','{}','openplans','registry:source','publisher registry written by OpenPlans code'),
 ('snapshot','{snapshot_id}',NULL,NULL,'the receipt itself'),
 ('geo_import','{relationship_snapshot_id}',NULL,NULL,'pointer to the ZCTA relationship file and its pair'),
 ('puf_import','{import_id}',NULL,NULL,'bundle receipt'),
 ('puf_active_catalog','{import_id}',NULL,NULL,'serving pointer to a bundle'),
 ('puf_market_catalog','{import_id}',NULL,NULL,'serving pointer to a bundle, per market'),
 ('sbe_catalog','{import_id}',NULL,NULL,'bundle receipt'),
 ('sbe_issuer_status','{import_id}',NULL,NULL,'status derived from one bundle'),
 ('state_rate_import','{import_id}',NULL,NULL,'state filing receipt'),
 ('state_rate_active','{import_id}',NULL,NULL,'serving pointer to a state filing'),
 ('state_community_rate','{publication_snapshot_id}',NULL,NULL,'published filing file'),
 ('state_vt_hios_match','{}','openplans','derived:vt-hios-exact-v1','identity match computed by OpenPlans'),
 ('qhp_index','{snapshot_id,registry_snapshot_id}',NULL,NULL,'index fetch, else the registry row that named it'),
 ('qhp_child_url','{snapshot_id,index_snapshot_id}',NULL,NULL,'child fetch, else the index that listed it'),
 ('formulary_shard','{snapshot_id}',NULL,NULL,'parsed shard receipt'),
 ('provider_plan_group','{}','openplans','derived:provider-plan-group','content-addressed plan list shared by records'),
 ('provider_plan_group_edge','{}','openplans','derived:provider-plan-group','content-addressed plan list shared by records'),
 ('geocode_attempt','{snapshot_id}',NULL,NULL,'geocoder response'),
 ('address_point','{snapshot_id}',NULL,NULL,'geocoder response'),
 ('geocode_tx_run','{}','openplans','job:geocode-run','geocoding job state'),
 ('geocode_tx_input','{source_snapshot_id}',NULL,NULL,'address copied from its source record'),
 ('geocode_tx_address','{}','openplans','job:geocode-run','geocoding job queue'),
 ('geocode_tx_batch','{snapshot_id}','openplans','job:geocode-run','batch response, else job state'),
 ('geocode_cleanup_address','{}','openplans','derived:geocode-cleanup','deterministic address cleanup'),
 ('geocode_open_run','{}','openplans','job:geocode-open-run','open-data geocoding job'),
 ('geocode_open_result','{}','openplans','job:geocode-open-run','open-data geocoding job'),
 ('cms_zip_lookup','{snapshot_id}','openplans','cache:cms-zip-lookup','response, else a cached failure'),
 ('cms_zip_attempt','{snapshot_id}','openplans','cache:cms-zip-lookup','response, else a failed attempt'),
 ('quality_issue','{snapshot_id}',NULL,NULL,'issue found in a receipt');

CREATE FUNCTION row_provenance_function_name(target text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT left('row_provenance__' || target, 63) $$;

-- Adds the five columns and the row trigger to one table. Safe to call again.
CREATE FUNCTION install_row_provenance(target text) RETURNS void LANGUAGE plpgsql AS $install$
DECLARE
  rule row_provenance_rule;
  inferred text;
  ref_expr text;
  same_ref text;
  fixed text;
  wrong text;
BEGIN
  IF to_regclass(quote_ident(target)) IS NULL THEN
    RAISE EXCEPTION 'row provenance: no table %', target;
  END IF;
  SELECT string_agg(format('%s is %s', column_name, data_type), ', ') INTO wrong
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = target AND (
    (column_name IN ('created_at','updated_at','sourced_at') AND data_type <> 'timestamp with time zone')
    OR (column_name IN ('sourced_by','sourced_slug') AND data_type <> 'text'));
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'row provenance: % has the wrong column type (%)', target, wrong;
  END IF;
  EXECUTE format('ALTER TABLE %I
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS sourced_by text NOT NULL DEFAULT ''unknown'',
    ADD COLUMN IF NOT EXISTS sourced_at timestamptz,
    ADD COLUMN IF NOT EXISTS sourced_slug text NOT NULL DEFAULT ''unknown''', target);
  -- Columns that predate this migration may allow NULL or lack the default.
  EXECUTE format('ALTER TABLE %I ALTER COLUMN created_at SET DEFAULT now(),
    ALTER COLUMN updated_at SET DEFAULT now()', target);

  SELECT * INTO rule FROM row_provenance_rule WHERE table_name = target;
  IF NOT FOUND THEN
    SELECT c.column_name INTO inferred FROM information_schema.columns c
    WHERE c.table_schema = current_schema() AND c.table_name = target AND c.column_name = 'snapshot_id';
    IF inferred IS NULL THEN
      SELECT a.attname INTO inferred
      FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      WHERE k.contype = 'f' AND k.conrelid = to_regclass(quote_ident(target))
        AND k.confrelid = 'snapshot'::regclass AND cardinality(k.conkey) = 1
      ORDER BY a.attnum LIMIT 1;
    END IF;
    INSERT INTO row_provenance_rule(table_name,reference_columns,reason)
    VALUES (target, CASE WHEN inferred IS NULL THEN '{}' ELSE ARRAY[inferred] END,
      CASE WHEN inferred IS NULL THEN 'inferred: no receipt reference'
        ELSE 'inferred: ' || inferred END)
    RETURNING * INTO rule;
  END IF;

  fixed := CASE WHEN rule.fixed_by IS NULL THEN
      'NEW.sourced_by := coalesce(NEW.sourced_by, ''unknown'');
       NEW.sourced_slug := coalesce(NEW.sourced_slug, ''unknown'');'
    ELSE format('NEW.sourced_by := %L; NEW.sourced_at := NULL; NEW.sourced_slug := %L;',
      rule.fixed_by, rule.fixed_slug) END;

  IF target = 'snapshot' THEN
    EXECUTE format($fn$CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF current_setting('openplans.row_provenance_backfill', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  ELSE
    NEW.created_at := coalesce(NEW.created_at, now());
    NEW.updated_at := coalesce(NEW.updated_at, now());
  END IF;
  NEW.sourced_by := NEW.source_id;
  NEW.sourced_at := NEW.retrieved_at;
  NEW.sourced_slug := NEW.snapshot_id;
  RETURN NEW;
END $body$$fn$, row_provenance_function_name(target));
  ELSIF cardinality(rule.reference_columns) = 0 THEN
    EXECUTE format($fn$CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $body$
BEGIN
  IF current_setting('openplans.row_provenance_backfill', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    NEW.sourced_by := OLD.sourced_by;
    NEW.sourced_at := OLD.sourced_at;
    NEW.sourced_slug := OLD.sourced_slug;
    RETURN NEW;
  END IF;
  NEW.created_at := coalesce(NEW.created_at, now());
  NEW.updated_at := coalesce(NEW.updated_at, now());
  %s
  RETURN NEW;
END $body$$fn$, row_provenance_function_name(target), fixed);
  ELSE
    SELECT 'coalesce(' || string_agg(format('NEW.%I::text', c), ',') || ', NULL)',
      'ROW(' || string_agg(format('NEW.%I', c), ',') || ', NULL) IS NOT DISTINCT FROM ROW('
        || string_agg(format('OLD.%I', c), ',') || ', NULL)'
    INTO ref_expr, same_ref FROM unnest(rule.reference_columns) c;
    EXECUTE format($fn$CREATE OR REPLACE FUNCTION %I() RETURNS trigger LANGUAGE plpgsql AS $body$
DECLARE
  ref text;
  receipt_source text;
  receipt_time timestamptz;
BEGIN
  IF current_setting('openplans.row_provenance_backfill', true) = 'on' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
    IF %s THEN
      NEW.sourced_by := OLD.sourced_by;
      NEW.sourced_at := OLD.sourced_at;
      NEW.sourced_slug := OLD.sourced_slug;
      RETURN NEW;
    END IF;
  ELSE
    NEW.created_at := coalesce(NEW.created_at, now());
    NEW.updated_at := coalesce(NEW.updated_at, now());
  END IF;
  ref := %s;
  IF ref IS NOT NULL THEN
    SELECT s.source_id, s.retrieved_at INTO receipt_source, receipt_time
    FROM snapshot s WHERE s.snapshot_id = ref;
    NEW.sourced_by := coalesce(receipt_source, 'unknown');
    NEW.sourced_at := receipt_time;
    NEW.sourced_slug := ref;
    RETURN NEW;
  END IF;
  %s
  RETURN NEW;
END $body$$fn$, row_provenance_function_name(target), same_ref, ref_expr, fixed);
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS row_provenance ON %I', target);
  EXECUTE format('CREATE TRIGGER row_provenance BEFORE INSERT OR UPDATE ON %I
    FOR EACH ROW EXECUTE FUNCTION %I()', target, row_provenance_function_name(target));
END $install$;

-- Tables that cannot carry row provenance. Extension-owned tables are skipped as well.
CREATE FUNCTION row_provenance_excluded(target text) RETURNS boolean
LANGUAGE sql STABLE STRICT AS $$
  SELECT target IN ('spatial_ref_sys') OR EXISTS (
    SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
      AND d.objid = to_regclass(quote_ident(target)) AND d.deptype = 'e')
$$;

-- Fills pre-existing rows of one table from their receipts, for heap blocks
-- [first_block, first_block + blocks). Rows already filled are skipped, so a rerun is safe.
-- created_at becomes the receipt's created_at when that is earlier (the row cannot predate
-- the import that wrote it); updated_at follows, since filling provenance changes no data.
CREATE FUNCTION backfill_row_provenance(target text, first_block bigint, blocks bigint)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  rule row_provenance_rule;
  ref_expr text;
  range_filter text;
  changed bigint := 0;
  more bigint;
BEGIN
  SELECT * INTO rule FROM row_provenance_rule WHERE table_name = target;
  IF NOT FOUND THEN RAISE EXCEPTION 'row provenance: no rule for %', target; END IF;
  range_filter := format('ctid >= %L::tid AND ctid < %L::tid',
    format('(%s,0)', first_block), format('(%s,0)', first_block + blocks));
  PERFORM set_config('openplans.row_provenance_backfill', 'on', true);
  IF target = 'snapshot' THEN
    EXECUTE format('UPDATE snapshot SET sourced_by=source_id, sourced_at=retrieved_at,
      sourced_slug=snapshot_id, updated_at=created_at WHERE sourced_slug=''unknown'' AND %s',
      range_filter);
    GET DIAGNOSTICS changed = ROW_COUNT;
  ELSE
    IF cardinality(rule.reference_columns) > 0 THEN
      SELECT 'coalesce(' || string_agg(format('t.%I::text', c), ',') || ', NULL)'
      INTO ref_expr FROM unnest(rule.reference_columns) c;
      EXECUTE format('UPDATE %I t SET (sourced_by, sourced_at, sourced_slug, created_at, updated_at) = (
          SELECT coalesce(s.source_id, ''unknown''), s.retrieved_at, %s,
            least(t.created_at, s.created_at), least(t.created_at, s.created_at)
          FROM (SELECT 1) one LEFT JOIN snapshot s ON s.snapshot_id = %s)
        WHERE t.sourced_slug = ''unknown'' AND %s IS NOT NULL AND t.%s',
        target, ref_expr, ref_expr, ref_expr, range_filter);
      GET DIAGNOSTICS changed = ROW_COUNT;
    END IF;
    IF rule.fixed_by IS NOT NULL THEN
      EXECUTE format('UPDATE %I t SET sourced_by=%L, sourced_at=NULL, sourced_slug=%L
        WHERE t.sourced_slug = ''unknown'' AND %s IS NOT DISTINCT FROM NULL AND t.%s',
        target, rule.fixed_by, rule.fixed_slug,
        coalesce(ref_expr, 'NULL'), range_filter);
      GET DIAGNOSTICS more = ROW_COUNT;
      changed := changed + more;
    END IF;
  END IF;
  PERFORM set_config('openplans.row_provenance_backfill', 'off', true);
  RETURN changed;
END $$;

-- Fills a table now when it has at most 100,000 rows. Larger tables wait for the batched
-- `worker backfill row-provenance` command, so a migration never rewrites a large table.
CREATE FUNCTION backfill_small_row_provenance(target text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  size bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM (SELECT 1 FROM %I LIMIT 100001) x', target) INTO size;
  IF size = 0 OR size > 100000 THEN RETURN 0; END IF;
  RETURN backfill_row_provenance(target, 0,
    pg_relation_size(to_regclass(quote_ident(target))) / current_setting('block_size')::bigint + 1);
END $$;

-- Covers every table that lacks a column or the trigger. Returns the tables it installed.
CREATE FUNCTION install_row_provenance_all() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  t text;
  done text[] := '{}';
BEGIN
  FOR t IN SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r','p')
      AND NOT row_provenance_excluded(c.relname)
      AND ((SELECT count(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND NOT a.attisdropped
          AND a.attname IN ('created_at','updated_at','sourced_by','sourced_at','sourced_slug')) < 5
        OR NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'row_provenance'))
    ORDER BY c.relname
  LOOP
    PERFORM install_row_provenance(t);
    PERFORM backfill_small_row_provenance(t);
    done := done || t;
  END LOOP;
  RETURN done;
END $$;

SELECT install_row_provenance_all();

-- The rule registry is a public table like the others; cached API responses track it too.
INSERT INTO api_data_generation(table_name) VALUES ('row_provenance_rule');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON row_provenance_rule
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
