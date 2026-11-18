-- Derived publications are rebuilt once in the county-keyed format.
DELETE FROM handy_lowest_active;
DELETE FROM handy_lowest_build;
CREATE TABLE handy_lowest_evidence (
  evidence_id text PRIMARY KEY,
  payload text NOT NULL,
  payload_sha256 text NOT NULL,
  raw_bytes bigint NOT NULL CHECK (raw_bytes>=0)
);
ALTER TABLE handy_lowest_build ADD COLUMN evidence_id text REFERENCES handy_lowest_evidence(evidence_id);
CREATE INDEX handy_lowest_build_evidence ON handy_lowest_build(evidence_id);
CREATE TABLE handy_lowest_usage (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  payload_bytes bigint NOT NULL DEFAULT 0 CHECK (payload_bytes BETWEEN 0 AND 1073741824),
  raw_payload_bytes bigint NOT NULL DEFAULT 0 CHECK (raw_payload_bytes BETWEEN 0 AND 1073741824)
);
INSERT INTO handy_lowest_usage(singleton) VALUES (true);
INSERT INTO row_provenance_rule(table_name,fixed_by,fixed_slug,reason,policy_name) VALUES
 ('handy_lowest_evidence','openplans','derived:lowest-premiums','shared county and year pricing evidence','app_state'),
 ('handy_lowest_usage','openplans','derived:lowest-premiums','publication storage accounting','app_state');
CREATE FUNCTION handy_lowest_bytes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='handy_lowest_evidence' THEN
  UPDATE handy_lowest_usage SET payload_bytes=payload_bytes+(SELECT coalesce(sum(octet_length(payload)),0) FROM new_rows),raw_payload_bytes=raw_payload_bytes+(SELECT coalesce(sum(raw_bytes),0) FROM new_rows);
 ELSE
  UPDATE handy_lowest_usage SET payload_bytes=payload_bytes+(SELECT coalesce(sum(octet_length(payload)),0) FROM new_rows),raw_payload_bytes=raw_payload_bytes+(SELECT coalesce(sum(octet_length(payload)),0) FROM new_rows);
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION handy_lowest_bytes_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='handy_lowest_evidence' THEN
  UPDATE handy_lowest_usage SET payload_bytes=payload_bytes-(SELECT coalesce(sum(octet_length(payload)),0) FROM old_rows),raw_payload_bytes=raw_payload_bytes-(SELECT coalesce(sum(raw_bytes),0) FROM old_rows);
 ELSE
  UPDATE handy_lowest_usage SET payload_bytes=payload_bytes-(SELECT coalesce(sum(octet_length(payload)),0) FROM old_rows),raw_payload_bytes=raw_payload_bytes-(SELECT coalesce(sum(octet_length(payload)),0) FROM old_rows);
 END IF;
 RETURN NULL;
END $$;
CREATE FUNCTION handy_lowest_bytes_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='handy_lowest_evidence' THEN
  UPDATE handy_lowest_usage SET payload_bytes=payload_bytes+(SELECT coalesce(sum(octet_length(payload)),0) FROM new_rows)-(SELECT coalesce(sum(octet_length(payload)),0) FROM old_rows),raw_payload_bytes=raw_payload_bytes+(SELECT coalesce(sum(raw_bytes),0) FROM new_rows)-(SELECT coalesce(sum(raw_bytes),0) FROM old_rows);
 ELSE
  UPDATE handy_lowest_usage SET payload_bytes=payload_bytes+(SELECT coalesce(sum(octet_length(payload)),0) FROM new_rows)-(SELECT coalesce(sum(octet_length(payload)),0) FROM old_rows),raw_payload_bytes=raw_payload_bytes+(SELECT coalesce(sum(octet_length(payload)),0) FROM new_rows)-(SELECT coalesce(sum(octet_length(payload)),0) FROM old_rows);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER handy_bytes_insert AFTER INSERT ON handy_lowest_build
 REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_insert();
CREATE TRIGGER handy_bytes_delete AFTER DELETE ON handy_lowest_build
 REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_delete();
CREATE TRIGGER handy_bytes_update AFTER UPDATE ON handy_lowest_build
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_update();
CREATE TRIGGER handy_bytes_insert AFTER INSERT ON handy_lowest_evidence
 REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_insert();
CREATE TRIGGER handy_bytes_delete AFTER DELETE ON handy_lowest_evidence
 REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_delete();
CREATE TRIGGER handy_bytes_update AFTER UPDATE ON handy_lowest_evidence
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_update();
CREATE FUNCTION handy_lowest_bytes_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE handy_lowest_usage SET payload_bytes=(SELECT coalesce(sum(octet_length(payload)),0) FROM handy_lowest_build)+(SELECT coalesce(sum(octet_length(payload)),0) FROM handy_lowest_evidence),raw_payload_bytes=(SELECT coalesce(sum(octet_length(payload)),0) FROM handy_lowest_build)+(SELECT coalesce(sum(raw_bytes),0) FROM handy_lowest_evidence);
 RETURN NULL;
END $$;
CREATE TRIGGER handy_bytes_truncate AFTER TRUNCATE ON handy_lowest_build
 FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_truncate();
CREATE TRIGGER handy_bytes_truncate AFTER TRUNCATE ON handy_lowest_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION handy_lowest_bytes_truncate();
-- Shared evidence changes must invalidate readers, without changing an unused installation.
CREATE FUNCTION register_handy_shared_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM handy_lowest_build) OR EXISTS(SELECT 1 FROM handy_lowest_evidence) THEN
  INSERT INTO api_data_generation(table_name) VALUES (TG_TABLE_NAME) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER aa_handy_generation_registration AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION register_handy_shared_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_evidence
 FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
CREATE TRIGGER aa_handy_generation_registration AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_usage
 FOR EACH STATEMENT EXECUTE FUNCTION register_handy_shared_generation();
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON handy_lowest_usage
 FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
