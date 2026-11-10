-- Which ACTIVE import serves each state/year/market. puf_active_catalog stays the
-- individual serving pointer; this table also records markets an import may hold
-- without replacing that pointer, such as an SBE bundle that contains only SHOP plans.
CREATE TABLE puf_market_catalog (
  state text NOT NULL,
  plan_year integer NOT NULL,
  market text NOT NULL,
  import_id text NOT NULL REFERENCES puf_import(import_id),
  PRIMARY KEY (state, plan_year, market)
);
INSERT INTO puf_market_catalog(state,plan_year,market,import_id)
SELECT a.state,a.plan_year,p.market,a.import_id FROM puf_active_catalog a
JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
JOIN plan p ON p.snapshot_id=f.snapshot_id
GROUP BY a.state,a.plan_year,p.market,a.import_id;

-- Same statement trigger as every catalog table (920_api_data_generation.sql).
INSERT INTO api_data_generation(table_name) VALUES ('puf_market_catalog');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON puf_market_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
