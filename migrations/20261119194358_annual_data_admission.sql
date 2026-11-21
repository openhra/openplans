-- A reviewed annual release may advance the serving window. Importers do not write this ledger.
CREATE TABLE annual_data_admission (
  domain text NOT NULL CHECK (domain IN ('individual','medicare')),
  coverage_year integer NOT NULL CHECK (coverage_year BETWEEN 2006 AND 9999),
  manifest jsonb NOT NULL CHECK (manifest @> '{"schema_version":1}'::jsonb
    AND jsonb_typeof(manifest->'releases') = 'array'
    AND jsonb_array_length(manifest->'releases') > 0),
  PRIMARY KEY (domain,coverage_year)
);
INSERT INTO api_data_generation(table_name) VALUES ('annual_data_admission');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON annual_data_admission
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
INSERT INTO row_provenance_rule(table_name,fixed_by,fixed_slug,reason,policy_name)
VALUES ('annual_data_admission','openplans','app:annual-data-admission','reviewed annual serving admissions','app_state');
