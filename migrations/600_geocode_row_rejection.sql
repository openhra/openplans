-- Keep the Census observation even when its coordinates cannot be published.
ALTER TABLE geocode_tx_result DROP CONSTRAINT geocode_tx_result_match_status_check;
ALTER TABLE geocode_tx_result DROP CONSTRAINT geocode_tx_result_check5;
ALTER TABLE geocode_tx_result ADD COLUMN rejection jsonb;
ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_tx_result_match_status_check
  CHECK (match_status IN ('Match','Tie','No_Match','rejected_out_of_bounds'));
ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_tx_result_fallback_status_check
  CHECK (method IS DISTINCT FROM 'zcta_centroid' OR
    (match_status IN ('Tie','No_Match','rejected_out_of_bounds') AND match_quality IS NULL));
ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_tx_result_rejection_check
  CHECK ((match_status='rejected_out_of_bounds') = (rejection IS NOT NULL));
ALTER TABLE geocode_tx_result ADD CONSTRAINT geocode_tx_result_rejected_point_check
  CHECK (match_status<>'rejected_out_of_bounds' OR
    (match_quality IS NULL AND (method IS NULL OR method='zcta_centroid')));
