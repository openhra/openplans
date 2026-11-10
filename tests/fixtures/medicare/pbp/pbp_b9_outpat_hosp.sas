*pbp_b9_outpat_hosp.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b9;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b9a_maxenr_yn                $1
	pbp_b9a_maxenr_ehc               $2
	pbp_b9a_maxenr_ohs_per           $1
	pbp_b9a_maxenr_ohs_per_d         $4000
	pbp_b9a_maxenr_obs_per           $1
	pbp_b9a_maxenr_obs_per_d         $4000
	pbp_b9a_coins_yn                 $1
	pbp_b9a_coins_ehc                $2
	pbp_b9a_ded_yn                   $1
	pbp_b9a_ded_ehc                  $2
	pbp_b9a_copay_yn                 $1
	pbp_b9a_copay_ehc                $2
	pbp_b9a_copay_obs_per            $1
	pbp_b9a_copay_obs_per_d          $4000
	pbp_b9a_auth_ohs_yn              $1
	pbp_b9a_auth_obs_yn              $1
	pbp_b9a_refer_ohs_yn             $1
	pbp_b9a_refer_obs_yn             $1
	pbp_b9b_maxenr_yn                $1
	pbp_b9b_maxenr_type              $1
	pbp_b9b_maxenr_per               $1
	pbp_b9b_maxenr_per_d             $4000
	pbp_b9b_coins_yn                 $1
	pbp_b9b_ded_yn                   $1
	pbp_b9b_copay_yn                 $1
	pbp_b9b_auth_yn                  $1
	pbp_b9b_refer_yn                 $1
	pbp_b9c_maxenr_yn                $1
	pbp_b9c_maxenr_type              $1
	pbp_b9c_maxenr_per               $1
	pbp_b9c_maxenr_per_d             $4000
	pbp_b9c_coins_yn                 $1
	pbp_b9c_coins_ehc                $2
	pbp_b9c_ded_yn                   $1
	pbp_b9c_copay_yn                 $1
	pbp_b9c_copay_ehc                $2
	pbp_b9c_auth_yn                  $1
	pbp_b9c_refer_yn                 $1
	pbp_b9d_maxenr_yn                $1
	pbp_b9d_maxenr_per               $1
	pbp_b9d_maxenr_per_d             $4000
	pbp_b9d_coins_yn                 $1
	pbp_b9d_ded_yn                   $1
	pbp_b9d_ded_waive_3pt_yn         $1
	pbp_b9d_copay_yn                 $1
	pbp_b9d_auth_yn                  $1
	pbp_b9d_refer_yn                 $1
;

infile '.\pbp\pbp_b9_outpat_hosp.txt' delimiter = '09'x
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
	pbp_b9a_maxenr_yn
	pbp_b9a_maxenr_ehc
	pbp_b9a_maxenr_ohs_amt
	pbp_b9a_maxenr_ohs_per
	pbp_b9a_maxenr_ohs_per_d
	pbp_b9a_maxenr_obs_amt
	pbp_b9a_maxenr_obs_per
	pbp_b9a_maxenr_obs_per_d
	pbp_b9a_coins_yn
	pbp_b9a_coins_ehc
	pbp_b9a_coins_ohs_pct_min
	pbp_b9a_coins_ohs_pct_max
	pbp_b9a_coins_obs_pct_min
	pbp_b9a_coins_obs_pct_max
	pbp_b9a_ded_yn
	pbp_b9a_ded_ehc
	pbp_b9a_ded_ohs_amt
	pbp_b9a_ded_obs_amt
	pbp_b9a_copay_yn
	pbp_b9a_copay_ehc
	pbp_b9a_copay_ohs_amt_min
	pbp_b9a_copay_ohs_amt_max
	pbp_b9a_copay_obs_amt_min
	pbp_b9a_copay_obs_amt_max
	pbp_b9a_copay_obs_per
	pbp_b9a_copay_obs_per_d
	pbp_b9a_auth_ohs_yn
	pbp_b9a_auth_obs_yn
	pbp_b9a_refer_ohs_yn
	pbp_b9a_refer_obs_yn
	pbp_b9b_maxenr_yn
	pbp_b9b_maxenr_type
	pbp_b9b_maxenr_amt
	pbp_b9b_maxenr_per
	pbp_b9b_maxenr_per_d
	pbp_b9b_coins_yn
	pbp_b9b_coins_pct_mc
	pbp_b9b_coins_pct_mcmax
	pbp_b9b_ded_yn
	pbp_b9b_ded_amt
	pbp_b9b_copay_yn
	pbp_b9b_copay_mc_amt
	pbp_b9b_copay_mc_amt_max
	pbp_b9b_auth_yn
	pbp_b9b_refer_yn
	pbp_b9c_maxenr_yn
	pbp_b9c_maxenr_type
	pbp_b9c_maxenr_amt
	pbp_b9c_maxenr_per
	pbp_b9c_maxenr_per_d
	pbp_b9c_coins_yn
	pbp_b9c_coins_ehc
	pbp_b9c_coins_mcis_minpct
	pbp_b9c_coins_mcis_maxpct
	pbp_b9c_coins_mcgs_minpct
	pbp_b9c_coins_mcgs_maxpct
	pbp_b9c_ded_yn
	pbp_b9c_ded_amt
	pbp_b9c_copay_yn
	pbp_b9c_copay_ehc
	pbp_b9c_copay_mcis_minamt
	pbp_b9c_copay_mcis_maxamt
	pbp_b9c_copay_mcgs_minamt
	pbp_b9c_copay_mcgs_maxamt
	pbp_b9c_auth_yn
	pbp_b9c_refer_yn
	pbp_b9d_maxenr_yn
	pbp_b9d_maxenr_amt
	pbp_b9d_maxenr_per
	pbp_b9d_maxenr_per_d
	pbp_b9d_coins_yn
	pbp_b9d_coins_pct_mc_min
	pbp_b9d_coins_pct_mc_max
	pbp_b9d_ded_yn
	pbp_b9d_ded_amt
	pbp_b9d_ded_waive_3pt_yn
	pbp_b9d_copay_yn
	pbp_b9d_copay_mc_amt_min
	pbp_b9d_copay_mc_amt_max
	pbp_b9d_auth_yn
	pbp_b9d_refer_yn
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
	pbp_b9a_maxenr_yn                = 'OHS Max Enr YN'
	pbp_b9a_maxenr_ehc               = 'OHS max enr benefits'
	pbp_b9a_maxenr_ohs_amt           = 'OHS MC Max Enr Amt'
	pbp_b9a_maxenr_ohs_per           = 'OHS MC Max Enr Per'
	pbp_b9a_maxenr_ohs_per_d         = 'OHS MC Max Enr Per Desc'
	pbp_b9a_maxenr_obs_amt           = 'OHS Obs Serv Max Enr Amt'
	pbp_b9a_maxenr_obs_per           = 'OHS Obs serv Max Enr Per'
	pbp_b9a_maxenr_obs_per_d         = 'OHS Obs serv Max Enr Per Desc'
	pbp_b9a_coins_yn                 = 'OHS Coinsurance YN'
	pbp_b9a_coins_ehc                = 'OHS coins benefits'
	pbp_b9a_coins_ohs_pct_min        = 'OHS MC Min Coins Pct'
	pbp_b9a_coins_ohs_pct_max        = 'OHS MC Max Coins Pct'
	pbp_b9a_coins_obs_pct_min        = 'OHS Obs Serv MC Min Coins'
	pbp_b9a_coins_obs_pct_max        = 'OHS Obs Serv MC Max Coins'
	pbp_b9a_ded_yn                   = 'OHS Deductible YN'
	pbp_b9a_ded_ehc                  = 'OHS deductible benefits'
	pbp_b9a_ded_ohs_amt              = 'OHS MC Deductible Amt'
	pbp_b9a_ded_obs_amt              = 'OHS Obs Serv Deductible Amt'
	pbp_b9a_copay_yn                 = 'OHS Copayment YN'
	pbp_b9a_copay_ehc                = 'OHS copay benefits'
	pbp_b9a_copay_ohs_amt_min        = 'OHS MC Min Copay Amt'
	pbp_b9a_copay_ohs_amt_max        = 'OHS MC Max Copay Amt'
	pbp_b9a_copay_obs_amt_min        = 'OHS Obs Serv MC Min Copay Amt'
	pbp_b9a_copay_obs_amt_max        = 'OHS Obs Serv MC Max Copay Amt'
	pbp_b9a_copay_obs_per            = 'OHS MC Copay Period'
	pbp_b9a_copay_obs_per_d          = 'OHS MC Period Desc'
	pbp_b9a_auth_ohs_yn              = 'OHS MC Auth YN'
	pbp_b9a_auth_obs_yn              = 'OHS Obs serv Auth YN'
	pbp_b9a_refer_ohs_yn             = 'OHS MC Referral YN'
	pbp_b9a_refer_obs_yn             = 'OHS Obs Serv Referral YN'
	pbp_b9b_maxenr_yn                = 'ASC Services Max Enr YN'
	pbp_b9b_maxenr_type              = 'ASC Services Max Enr Type'
	pbp_b9b_maxenr_amt               = 'ASC Services Max Enr Amt'
	pbp_b9b_maxenr_per               = 'ASC Services Max Enr Per'
	pbp_b9b_maxenr_per_d             = 'ASC Svcs Max Enr Per Desc'
	pbp_b9b_coins_yn                 = 'ASC Services Coinsurance YN'
	pbp_b9b_coins_pct_mc             = 'ASC Services MC Min Coins Pct'
	pbp_b9b_coins_pct_mcmax          = 'ASC Services MC Max Coins Pct'
	pbp_b9b_ded_yn                   = 'ASC Services Deductible YN'
	pbp_b9b_ded_amt                  = 'ASC Services Deductible Amt'
	pbp_b9b_copay_yn                 = 'ASC Services Copayment YN'
	pbp_b9b_copay_mc_amt             = 'ASC Services MC Min Copay Amt'
	pbp_b9b_copay_mc_amt_max         = 'ASC Services MC Max Copay Amt'
	pbp_b9b_auth_yn                  = 'ASC Services Enrollee Auth'
	pbp_b9b_refer_yn                 = 'ASC Services Referral YN'
	pbp_b9c_maxenr_yn                = 'Outpnt SA Svcs Max Enr YN'
	pbp_b9c_maxenr_type              = 'Outpnt SA Svcs Max Enr Type'
	pbp_b9c_maxenr_amt               = 'Outpnt SA Svcs Max Enr Amt'
	pbp_b9c_maxenr_per               = 'Outpnt SA Svcs Max Enr Per'
	pbp_b9c_maxenr_per_d             = 'Outpnt SA Svcs Max Enr Desc'
	pbp_b9c_coins_yn                 = 'Outpnt SA Svcs Coinsurance YN'
	pbp_b9c_coins_ehc                = 'Outpnt SA Coins  Ben'
	pbp_b9c_coins_mcis_minpct        = 'Outpnt SA Min Coins Individual'
	pbp_b9c_coins_mcis_maxpct        = 'Outpnt SA Max Coins Individual'
	pbp_b9c_coins_mcgs_minpct        = 'Outpnt SA Min Coins Group'
	pbp_b9c_coins_mcgs_maxpct        = 'Outpnt SA Max Coins Group'
	pbp_b9c_ded_yn                   = 'Outpnt SA Svcs Deductible YN'
	pbp_b9c_ded_amt                  = 'Outpnt SA Svcs Deductible Amt'
	pbp_b9c_copay_yn                 = 'Outpnt SA Svcs Copayment YN'
	pbp_b9c_copay_ehc                = 'Outpnt SA Copay Ben'
	pbp_b9c_copay_mcis_minamt        = 'Outpnt SA Min Copay Individual'
	pbp_b9c_copay_mcis_maxamt        = 'Outpnt SA Max Copay Individual'
	pbp_b9c_copay_mcgs_minamt        = 'Outpnt SA Min Copay Group'
	pbp_b9c_copay_mcgs_maxamt        = 'Outpnt SA Max Copay Group'
	pbp_b9c_auth_yn                  = 'Outpnt SA Svcs  YN'
	pbp_b9c_refer_yn                 = 'Outpnt SA Svcs Referral YN'
	pbp_b9d_maxenr_yn                = 'Outpnt Blood Max Enr YN'
	pbp_b9d_maxenr_amt               = 'Outpnt Blood Max Enr Amt'
	pbp_b9d_maxenr_per               = 'Outpnt Blood Max Enr Per'
	pbp_b9d_maxenr_per_d             = 'Outpt Bld Max Enr Per Desc'
	pbp_b9d_coins_yn                 = 'Outpnt Blood Coinsurance YN'
	pbp_b9d_coins_pct_mc_min         = 'Outpnt Blood MC Coins Min Pct'
	pbp_b9d_coins_pct_mc_max         = 'Outpnt Blood MC Coins Max Pct'
	pbp_b9d_ded_yn                   = 'Outpnt Blood Deductible YN'
	pbp_b9d_ded_amt                  = 'Outpnt Blood Deductible Amt'
	pbp_b9d_ded_waive_3pt_yn         = 'Outpnt Blood Waive 3pt YN'
	pbp_b9d_copay_yn                 = 'Outpnt Blood Copayment YN'
	pbp_b9d_copay_mc_amt_min         = 'Outpnt Blood MC Copay Min Amt'
	pbp_b9d_copay_mc_amt_max         = 'Outpnt Blood MC Copay Max Amt'
	pbp_b9d_auth_yn                  = 'Outpnt Blood Enrollee Auth'
	pbp_b9d_refer_yn                 = 'Outpnt Blood Referral YN'
;

run;

proc sort data = pbp_b9 out=out.pbp_b9;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b9(obs = 10);
  title 'pbp_b9_outpat_hosp file ';
run;

proc means data = out.pbp_b9;
  title 'pbp_b9_outpat_hosp file ';
run;

proc freq data = out.pbp_b9;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b9a_maxenr_yn
	pbp_b9a_maxenr_ehc
	pbp_b9a_maxenr_ohs_per
	pbp_b9a_maxenr_obs_per
	pbp_b9a_coins_yn
	pbp_b9a_coins_ehc
	pbp_b9a_ded_yn
	pbp_b9a_ded_ehc
	pbp_b9a_copay_yn
	pbp_b9a_copay_ehc
	pbp_b9a_copay_obs_per
	pbp_b9a_auth_ohs_yn
	pbp_b9a_auth_obs_yn
	pbp_b9a_refer_ohs_yn
	pbp_b9a_refer_obs_yn
	pbp_b9b_maxenr_yn
	pbp_b9b_maxenr_type
	pbp_b9b_maxenr_per
	pbp_b9b_coins_yn
	pbp_b9b_ded_yn
	pbp_b9b_copay_yn
	pbp_b9b_auth_yn
	pbp_b9b_refer_yn
	pbp_b9c_maxenr_yn
	pbp_b9c_maxenr_type
	pbp_b9c_maxenr_per
	pbp_b9c_coins_yn
	pbp_b9c_coins_ehc
	pbp_b9c_ded_yn
	pbp_b9c_copay_yn
	pbp_b9c_copay_ehc
	pbp_b9c_auth_yn
	pbp_b9c_refer_yn
	pbp_b9d_maxenr_yn
	pbp_b9d_maxenr_per
	pbp_b9d_coins_yn
	pbp_b9d_ded_yn
	pbp_b9d_ded_waive_3pt_yn
	pbp_b9d_copay_yn
	pbp_b9d_auth_yn
	pbp_b9d_refer_yn
/ missing;
run;

proc contents data = out.pbp_b9;
  title 'pbp_b9 data';
run;