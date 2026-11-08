-- Identity evidence only: never update a filed price, raw record or serving pointer.
-- The normalization contract is documented in src/ingest/state/README.md.
CREATE FUNCTION vt_hios_name_v1(name text, issuer_id text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE issuer_id
    WHEN '13627' THEN regexp_replace(n, '^bcbsvt ', '')
    WHEN '77566' THEN regexp_replace(n, '^\[(mvp vt(?: plus)?)( hdhp)?\] (.+)$', '\1 \3\2')
    ELSE n END
  FROM (SELECT btrim(regexp_replace(lower(name), '[[:space:]]+', ' ', 'g')) AS n) folded
$$;

CREATE FUNCTION vt_hios_metal_v1(metal text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(btrim(metal)) WHEN 'expanded bronze' THEN 'bronze'
    WHEN 'bronze' THEN 'bronze' WHEN 'silver' THEN 'silver'
    WHEN 'gold' THEN 'gold' WHEN 'platinum' THEN 'platinum' END
$$;

CREATE FUNCTION vt_hios_name_metal_v1(name text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE WHEN count(DISTINCT m[1])=1 THEN min(m[1]) END
  FROM regexp_matches(lower(name), '\m(platinum|gold|silver|bronze)\M', 'g') AS m
$$;

-- A set becomes eligible only after every member and the reconciled root is ACTIVE.
-- Repeated imports of the same bundle are equivalent, with a deterministic tie break.
CREATE VIEW vt_hios_sbe_catalog AS
  SELECT DISTINCT ON (p.plan_year) p.plan_year,p.import_id,c.bundle_url,c.bundle_sha256,p.started_at
  FROM puf_import p JOIN sbe_catalog c ON c.import_id=p.import_id
  JOIN snapshot s ON s.snapshot_id=p.import_id AND s.validation_state='ACTIVE'
  WHERE p.state='VT' AND (SELECT count(*) FROM puf_import_file f
    JOIN snapshot fs ON fs.snapshot_id=f.snapshot_id AND fs.validation_state='ACTIVE'
    WHERE f.import_id=p.import_id)=6
  ORDER BY p.plan_year,p.started_at DESC,p.import_id DESC;

CREATE TABLE state_vt_hios_match (
  state_import_id text NOT NULL,
  source_index integer NOT NULL,
  record_index integer NOT NULL,
  sbe_import_id text NOT NULL REFERENCES sbe_catalog(import_id),
  rule_version text NOT NULL CHECK (rule_version='vt-hios-exact-v1'),
  plan_key text NOT NULL,
  publication_snapshot_id text NOT NULL REFERENCES snapshot(snapshot_id),
  filed_provenance jsonb NOT NULL,
  issuer_id text,
  normalized_metal text,
  normalized_name text,
  hios_id text CHECK (hios_id ~ '^[0-9]{5}VT[0-9]{7}$'),
  hios_match text NOT NULL CHECK (hios_match IN ('matched','ambiguous','none')),
  reason text NOT NULL,
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates)='array'),
  PRIMARY KEY (state_import_id,source_index,record_index,sbe_import_id,rule_version),
  FOREIGN KEY (state_import_id,source_index,record_index)
    REFERENCES state_community_rate(import_id,source_index,record_index),
  CHECK ((hios_match='matched' AND hios_id IS NOT NULL AND jsonb_array_length(candidates)=1
    AND hios_id=candidates->0->>'hios_id') OR (hios_match<>'matched' AND hios_id IS NULL))
);
CREATE INDEX state_vt_hios_id ON state_vt_hios_match(hios_id,state_import_id,sbe_import_id) WHERE hios_match='matched';
CREATE UNIQUE INDEX state_vt_hios_unique_design ON state_vt_hios_match(state_import_id,sbe_import_id,rule_version,hios_id)
  WHERE hios_match='matched';

CREATE FUNCTION refresh_vt_hios_matches() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1869636988);
  INSERT INTO state_vt_hios_match
    (state_import_id,source_index,record_index,sbe_import_id,rule_version,plan_key,
     publication_snapshot_id,filed_provenance,issuer_id,normalized_metal,normalized_name,
     hios_id,hios_match,reason,candidates)
  WITH filed AS (
    SELECT r.*,a.plan_year,c.import_id AS sbe_import_id,
      CASE r.raw_record->>'issuer' WHEN 'BCBSVT' THEN '13627' WHEN 'MVP' THEN '77566' END AS issuer_id,
      vt_hios_name_metal_v1(r.raw_record->>'plan_name') AS name_metal,
      vt_hios_metal_v1(r.raw_record->>'metal') AS filed_metal
    FROM state_rate_active a JOIN state_community_rate r ON r.import_id=a.import_id
    JOIN snapshot s ON s.snapshot_id=a.import_id AND s.validation_state='ACTIVE'
    JOIN vt_hios_sbe_catalog c ON c.plan_year=a.plan_year WHERE a.state='VT'
  ), normalized AS (
    SELECT *,vt_hios_name_v1(raw_record->>'plan_name',issuer_id) AS normalized_name,
      CASE WHEN raw_record->>'metal' IS NULL OR filed_metal=name_metal THEN name_metal END AS normalized_metal
    FROM filed
  ), matched AS (
    SELECT d.*,coalesce(c.candidates,'[]'::jsonb) AS candidates
    FROM normalized d LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('hios_id',p.base_plan_id,'issuer_id',p.issuer_id,
        'bundle_url',p.bundle_url,'bundle_sha256',p.bundle_sha256,
        'attribute_snapshot_id',p.snapshot_id,'attribute_member',p.member,
        'attribute_rows',p.attribute_rows) ORDER BY p.base_plan_id) AS candidates
      FROM (
        SELECT pa.base_plan_id,pa.issuer_id,pa.snapshot_id,c.bundle_url,c.bundle_sha256,
          CASE WHEN src.registry_evidence->>'sha256'=c.bundle_sha256
            AND src.registry_evidence->>'url'=c.bundle_url THEN src.registry_evidence->>'member' END AS member,
          jsonb_agg(jsonb_build_object('source_row',pa.source_row,'published_plan_id',pa.published_plan_id,
            'plan_name',pa.plan_name,'metal',pa.metal) ORDER BY pa.source_row) AS attribute_rows
        FROM puf_import_file f JOIN plan_attribute pa ON pa.snapshot_id=f.snapshot_id
        JOIN sbe_catalog c ON c.import_id=f.import_id
        JOIN snapshot s ON s.snapshot_id=f.snapshot_id JOIN source src ON src.source_id=s.source_id
        WHERE f.import_id=d.sbe_import_id AND f.kind='plan-attributes'
          AND pa.state='VT' AND pa.plan_year=d.plan_year AND pa.market='Individual'
          AND NOT pa.dental_only AND pa.on_exchange
          AND pa.issuer_id=d.issuer_id AND left(pa.base_plan_id,5)=d.issuer_id
          AND vt_hios_metal_v1(pa.metal)=d.normalized_metal
          AND vt_hios_name_v1(pa.plan_name,pa.issuer_id)=d.normalized_name
        GROUP BY pa.base_plan_id,pa.issuer_id,pa.snapshot_id,c.bundle_url,c.bundle_sha256,src.registry_evidence
      ) p
    ) c ON true
  ), resolved AS (
    SELECT *,count(*) FILTER (WHERE jsonb_array_length(candidates)=1)
      OVER (PARTITION BY import_id,candidates->0->>'hios_id') AS filed_claims FROM matched
  )
  SELECT import_id,source_index,record_index,sbe_import_id,'vt-hios-exact-v1',plan_key,
    publication_snapshot_id,jsonb_build_object('source_url',rate->'provenance'->>'sourceUrl',
      'source_sha256',rate->'provenance'->>'sourceSha256','source_record',rate->'provenance'->>'sourceRecord',
      'issuer',raw_record->>'issuer','plan_name',raw_record->>'plan_name','metal',raw_record->>'metal'),
    issuer_id,normalized_metal,normalized_name,
    CASE WHEN jsonb_array_length(candidates)=1 AND filed_claims=1 THEN candidates->0->>'hios_id' END,
    CASE WHEN jsonb_array_length(candidates)=0 THEN 'none'
      WHEN jsonb_array_length(candidates)>1 OR filed_claims>1 THEN 'ambiguous' ELSE 'matched' END,
    CASE WHEN issuer_id IS NULL THEN 'issuer_not_mapped'
      WHEN normalized_metal IS NULL THEN 'missing_or_conflicting_metal'
      WHEN jsonb_array_length(candidates)=0 THEN 'no_exact_individual_medical_name'
      WHEN jsonb_array_length(candidates)>1 THEN 'multiple_hios_designs'
      WHEN filed_claims>1 THEN 'multiple_filed_designs' ELSE 'unique_exact_tuple' END,
    candidates FROM resolved
  ON CONFLICT DO NOTHING;
END
$$;

CREATE FUNCTION refresh_vt_hios_on_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='VT' THEN PERFORM refresh_vt_hios_matches(); END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER state_vt_hios_activation AFTER INSERT OR UPDATE ON state_rate_active
  FOR EACH ROW EXECUTE FUNCTION refresh_vt_hios_on_state();

CREATE FUNCTION refresh_vt_hios_on_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM sbe_catalog c JOIN puf_import p ON p.import_id=c.import_id
    WHERE p.state='VT' AND (p.import_id=NEW.snapshot_id OR EXISTS
      (SELECT 1 FROM puf_import_file f WHERE f.import_id=p.import_id AND f.snapshot_id=NEW.snapshot_id)))
  THEN PERFORM refresh_vt_hios_matches(); END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER state_vt_hios_sbe_activation AFTER UPDATE OF validation_state ON snapshot
  FOR EACH ROW WHEN (NEW.validation_state='ACTIVE' AND OLD.validation_state IS DISTINCT FROM NEW.validation_state)
  EXECUTE FUNCTION refresh_vt_hios_on_snapshot();

CREATE VIEW state_vt_hios_current AS
  SELECT m.* FROM state_vt_hios_match m
  JOIN state_rate_active a ON a.import_id=m.state_import_id AND a.state='VT'
  JOIN snapshot s ON s.snapshot_id=a.import_id AND s.validation_state='ACTIVE'
  JOIN vt_hios_sbe_catalog c ON c.plan_year=a.plan_year AND c.import_id=m.sbe_import_id
  WHERE m.rule_version='vt-hios-exact-v1';

-- Deployments with both sources already installed acquire the join during migration.
SELECT refresh_vt_hios_matches();
