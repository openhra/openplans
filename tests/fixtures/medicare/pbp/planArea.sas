*planArea.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 PS=64 LS=130 nocenter;

data planArea;

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
	county_code                      $5
	pending_flag                     $1
	partial_flag                     $1
	contract_year                    $4
	eghp_flag                        $1
	county                           $75
	stcd                             $2
;

infile '.\pbp\planArea.txt' delimiter = '09'x
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
	county_code
	pending_flag
	partial_flag
	contract_year
	eghp_flag
	county
	stcd
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
	county_code                      = 'SSA State and County Code'
	pending_flag                     = 'Pending County Flag'
	partial_flag                     = 'Partial County Flag'
	contract_year                    = 'Contract Year'
	eghp_flag                        = 'EGHP Plan Flag'
	county                           = 'County Name'
	stcd                             = 'Abbreviated State'
;

run;

proc sort data = planArea out=out.planArea;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.planArea(obs = 10);
  title 'planArea file ';
run;

proc means data = out.planArea;
  title 'planArea file ';
run;

proc freq data = out.planArea;
table
	contract_id
	plan_id
	segment_id
	county_code
	pending_flag
	partial_flag
	contract_year
	eghp_flag
	county
	stcd
/ missing;
run;

proc contents data = out.planArea;
  title 'planArea file ';
run;