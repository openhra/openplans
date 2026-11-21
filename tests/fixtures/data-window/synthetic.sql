-- Synthetic publication identities only. No premiums, coverage decisions, NPIs or RxCUIs.
INSERT INTO source(source_id,publisher,source_kind)
VALUES('synthetic-histqualify','Synthetic qualification publisher','synthetic');
INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,fetched_children,
  sha256,retrieved_at,activated_at)
SELECT 'synthetic-window-'||y,'synthetic-histqualify','ACTIVE',0,0,
  repeat('a',64),'2026-01-01Z','2026-01-01Z' FROM generate_series(2024,2029) y;
INSERT INTO puf_import(import_id,state,plan_year)
SELECT 'synthetic-window-'||y,'TX',y FROM generate_series(2024,2029) y;
INSERT INTO puf_import_file(import_id,kind,snapshot_id)
SELECT import_id,'plan-attributes',import_id FROM puf_import;
INSERT INTO puf_active_catalog(state,plan_year,import_id)
SELECT state,plan_year,import_id FROM puf_import;
INSERT INTO issuer(snapshot_id,source_row,issuer_id,state,plan_year,marketing_names)
SELECT import_id,2,'00000','TX',plan_year,jsonb_build_array('Synthetic qualification issuer '||plan_year) FROM puf_import;
INSERT INTO plan(snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,market,metal,
  dental_only,network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange)
SELECT import_id,2,plan_year,'TX','00000','00000TX0000000','Individual','Silver',false,
  'synthetic','synthetic','Synthetic qualification plan '||plan_year,'On Exchange',true,false FROM puf_import;
INSERT INTO medicare_release(snapshot_id,family,contract_year,as_of,as_of_label,member_name)
SELECT import_id,'landscape',plan_year,make_date(plan_year,1,1),'synthetic','synthetic.csv' FROM puf_import;
-- The restore sample contains both admitted and waiting domains in 2026, and waiting next years in 2027.
INSERT INTO annual_data_admission(domain,coverage_year,manifest)
VALUES('individual',2027,'{"schema_version":1,"releases":[{"kind":"puf","snapshot_id":"synthetic-window-2027","contract_year":2027}]}');
-- Exercise the stored CHECK function that originally broke restores with an empty search_path.
INSERT INTO geocode_tx_county(county_fips,name,south,north,west,east,rings,snapshot_id)
VALUES('48201','Synthetic qualification county',29,31,-96,-94,'[]','synthetic-window-2026');
INSERT INTO geocode_tx_result(address_hash,normalized_address,match_status,match_quality,method,
  latitude,longitude,county_basis,county_fips,snapshot_id)
VALUES(repeat('a',64),'Synthetic qualification address','Match','Exact','census_geocoder',29.7,-95.3,
  'point_in_county','48201','synthetic-window-2026');
