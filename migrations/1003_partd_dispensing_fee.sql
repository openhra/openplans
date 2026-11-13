-- Dispensing-fee ranges from the Part D pharmacy networks file: per plan, channel, area, fee type
-- and days supply, the lowest and highest readable fee over the network's pharmacies. The
-- pharmacy rows themselves are not stored. Fees of `.` are counted as missing, never as 0.
CREATE TABLE partd_dispensing_fee_range (
  snapshot_id text NOT NULL REFERENCES partd_release(snapshot_id),
  contract_id text NOT NULL,
  plan_id text NOT NULL,
  segment_id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('preferred_retail', 'standard_retail', 'preferred_mail', 'standard_mail')),
  in_area boolean NOT NULL,
  fee_type text NOT NULL CHECK (fee_type IN ('brand', 'generic', 'selected')),
  days_supply integer NOT NULL CHECK (days_supply IN (30, 60, 90)),
  pharmacies integer NOT NULL CHECK (pharmacies > 0),
  fees_readable integer NOT NULL CHECK (fees_readable >= 0),
  fees_missing integer NOT NULL CHECK (fees_missing >= 0),
  min_fee numeric(12, 4),
  max_fee numeric(12, 4),
  max_floor_price numeric(12, 4),
  floors_missing integer NOT NULL CHECK (floors_missing >= 0),
  -- Network file members the plan's rows came from, the SHA-256 of each member as stored in the
  -- archive, and the plan's first row number in the first member.
  source_files text[] NOT NULL,
  source_sha256 text[] NOT NULL,
  first_source_row bigint NOT NULL,
  CHECK (fees_readable + fees_missing = pharmacies),
  CHECK ((fees_readable = 0) = (min_fee IS NULL) AND (min_fee IS NULL) = (max_fee IS NULL)),
  CHECK (min_fee <= max_fee),
  CHECK (cardinality(source_files) = cardinality(source_sha256)),
  PRIMARY KEY (snapshot_id, contract_id, plan_id, segment_id, channel, in_area, fee_type, days_supply)
);

INSERT INTO api_data_generation(table_name) VALUES ('partd_dispensing_fee_range');
CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON partd_dispensing_fee_range
  FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
