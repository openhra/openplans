*pbp_b6_home_health.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b6;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b6_maxenr_yn                 $1
	pbp_b6_maxenr_per                $1
	pbp_b6_maxenr_per_d              $4000
	pbp_b6_coins_yn                  $1
	pbp_b6_ded_yn                    $1
	pbp_b6_copay_yn                  $1
	pbp_b6_auth_yn                   $1
	pbp_b6_refer_yn                  $1
;

infile '.\pbp\pbp_b6_home_health.txt' delimiter = '09'x
dsd lrecl = 30000 firstobs=2 missover;


input
	pbp_a_hnumber
	pbp_a_plan_identifier
	segment_id
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	bid_id
	version
	pbp_b6_maxenr_yn
	pbp_b6_maxenr_amt
	pbp_b6_maxenr_per
	pbp_b6_maxenr_per_d
	pbp_b6_coins_yn
	pbp_b6_coins_pct_mc_min
	pbp_b6_coins_pct_mc_max
	pbp_b6_ded_yn
	pbp_b6_ded_amt
	pbp_b6_copay_yn
	pbp_b6_copay_mc_amt_min
	pbp_b6_copay_mc_amt_max
	pbp_b6_auth_yn
	pbp_b6_refer_yn
;


label
	pbp_a_hnumber                    = 'H Number'
	pbp_a_plan_identifier            = 'Plan ID'
	segment_id                       = 'Segment ID'
	pbp_a_ben_cov                    = 'Coverage Criteria'
	pbp_a_plan_type                  = 'Plan Type'
	orgtype                          = 'Organization Type'
	bid_id                           = 'Bid ID'
	version                          = 'Version Number'
	pbp_b6_maxenr_yn                 = 'Home Health Max Enr YN'
	pbp_b6_maxenr_amt                = 'Home Health Max Enr Amt'
	pbp_b6_maxenr_per                = 'Home Health Max Enr Per'
	pbp_b6_maxenr_per_d              = 'Home Hlth Max Enr Per Desc'
	pbp_b6_coins_yn                  = 'Home Health Coinsurance YN'
	pbp_b6_coins_pct_mc_min          = 'Home Health MC Min Coins Pct'
	pbp_b6_coins_pct_mc_max          = 'Home Health MC Max Coins Pct'
	pbp_b6_ded_yn                    = 'Home Health Deductible YN'
	pbp_b6_ded_amt                   = 'Home Health Deductible Amt'
	pbp_b6_copay_yn                  = 'Home Health Copayment YN'
	pbp_b6_copay_mc_amt_min          = 'Home Health MC Min Copay Amt'
	pbp_b6_copay_mc_amt_max          = 'Home Health MC Max Copay Amt'
	pbp_b6_auth_yn                   = 'Home Health Enrollee Auth'
	pbp_b6_refer_yn                  = 'Home Health Referral YN'
;

run;

proc sort data = pbp_b6 out=out.pbp_b6;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b6(obs = 10);
  title 'pbp_b6_home_health file ';
run;

proc means data = out.pbp_b6;
  title 'pbp_b6_home_health file ';
run;

proc freq data = out.pbp_b6;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b6_maxenr_yn
	pbp_b6_maxenr_per
	pbp_b6_coins_yn
	pbp_b6_ded_yn
	pbp_b6_copay_yn
	pbp_b6_auth_yn
	pbp_b6_refer_yn
/ missing;
run;

proc contents data = out.pbp_b6;
  title 'pbp_b6 data';
run;