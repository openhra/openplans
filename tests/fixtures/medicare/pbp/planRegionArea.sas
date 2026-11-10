*planRegionArea.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 PS=64 LS=130 nocenter;

data planRegionArea;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	contract_id                      $5
	plan_id                          $3
	segment_id                       $3
	pending_flag                     $1
	partial_flag                     $1
	contract_year                    $4
	eghp_flag                        $1
	region_type                      $2
	ma_or_pdp_region_code            $2
	region                           $150
;

infile '.\pbp\planRegionArea.txt' delimiter = '09'x
dsd lrecl = 30000 firstobs=2 missover;


input
	pbp_a_hnumber
	pbp_a_plan_identifier
	segment_id
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	bid_id
	contract_id
	plan_id
	segment_id
	pending_flag
	partial_flag
	contract_year
	eghp_flag
	region_type
	ma_or_pdp_region_code
	region
;


label
	pbp_a_hnumber                    = 'H Number'
	pbp_a_plan_identifier            = 'Plan ID'
	segment_id                       = 'Segment ID'
	pbp_a_ben_cov                    = 'Coverage Criteria'
	pbp_a_plan_type                  = 'Plan Type'
	orgtype                          = 'Organization Type'
	bid_id                           = 'Bid ID'
	contract_id                      = 'H-Number'
	plan_id                          = 'Plan ID'
	segment_id                       = 'Segment ID'
	pending_flag                     = 'Pending Region Flag'
	partial_flag                     = 'Partial Region Flag'
	contract_year                    = 'Contract Year'
	eghp_flag                        = 'EGHP Plan Flag'
	region_type                      = 'Region Type'
	ma_or_pdp_region_code            = 'MA or PDP Region Code'
	region                           = 'Region'
;

run;

proc sort data = planRegionArea out=out.planRegionArea;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.planRegionArea(obs = 10);
  title 'planRegionArea file ';
run;

proc means data = out.planRegionArea;
  title 'planRegionArea file ';
run;

proc freq data = out.planRegionArea;
table
	contract_id
	plan_id
	segment_id
	pending_flag
	partial_flag
	contract_year
	eghp_flag
	region_type
	ma_or_pdp_region_code
	region
/ missing;
run;

proc contents data = out.planRegionArea;
  title 'planRegionArea file ';
run;