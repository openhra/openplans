*pbp_b11_dme_prosth_orth_sup.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b11;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b11a_maxenr_yn               $1
	pbp_b11a_maxenr_per              $1
	pbp_b11a_maxenr_per_d            $4000
	pbp_b11a_coins_yn                $1
	pbp_b11a_ded_yn                  $1
	pbp_b11a_copay_yn                $1
	pbp_b11a_dme_pref_vend_man_yn    $1
	pbp_b11a_auth_yn                 $1
	pbp_b11b_maxenr_yn               $1
	pbp_b11b_maxenr_cost_type        $1
	pbp_b11b_maxenr_per              $1
	pbp_b11b_maxenr_per_d            $4000
	pbp_b11b_coins_yn                $1
	pbp_b11b_coins_ehc               $2
	pbp_b11b_ded_yn                  $1
	pbp_b11b_copay_yn                $1
	pbp_b11b_copay_ehc               $2
	pbp_b11b_auth_yn                 $1
	pbp_b11c_maxenr_yn               $1
	pbp_b11c_maxenr_cost_type        $1
	pbp_b11c_maxenr_per              $1
	pbp_b11c_maxenr_per_d            $4000
	pbp_b11c_coins_yn                $1
	pbp_b11c_coins_ehc               $2
	pbp_b11c_ded_yn                  $1
	pbp_b11c_copay_yn                $1
	pbp_b11c_copay_ehc               $2
	pbp_b11c_dme_limit_manufact_yn   $1
	pbp_b11c_auth_yn                 $1
;

infile '.\pbp\pbp_b11_dme_prosth_orth_sup.txt' delimiter = '09'x
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
	pbp_b11a_maxenr_yn
	pbp_b11a_maxenr_amt
	pbp_b11a_maxenr_per
	pbp_b11a_maxenr_per_d
	pbp_b11a_coins_yn
	pbp_b11a_coins_pct_mc
	pbp_b11a_coins_pct_mcmax
	pbp_b11a_ded_yn
	pbp_b11a_ded_amt
	pbp_b11a_copay_yn
	pbp_b11a_copay_mc_amt
	pbp_b11a_copay_mcmax_amt
	pbp_b11a_dme_pref_vend_man_yn
	pbp_b11a_auth_yn
	pbp_b11b_maxenr_yn
	pbp_b11b_maxenr_cost_type
	pbp_b11b_maxenr_amt
	pbp_b11b_maxenr_per
	pbp_b11b_maxenr_per_d
	pbp_b11b_coins_yn
	pbp_b11b_coins_ehc
	pbp_b11b_coins_pct_mc
	pbp_b11b_coins_pct_mcmax
	pbp_b11b_coins_pct_mcms_min
	pbp_b11b_coins_pct_mcms_max
	pbp_b11b_ded_yn
	pbp_b11b_ded_amt
	pbp_b11b_copay_yn
	pbp_b11b_copay_ehc
	pbp_b11b_copay_mcmin_amt
	pbp_b11b_copay_mcmax_amt
	pbp_b11b_copay_mcms_min_amt
	pbp_b11b_copay_mcms_max_amt
	pbp_b11b_auth_yn
	pbp_b11c_maxenr_yn
	pbp_b11c_maxenr_cost_type
	pbp_b11c_maxenr_amt
	pbp_b11c_maxenr_per
	pbp_b11c_maxenr_per_d
	pbp_b11c_coins_yn
	pbp_b11c_coins_ehc
	pbp_b11c_coins_pct_mcmin
	pbp_b11c_coins_pct_mcmax
	pbp_b11c_coins_dtsi_mcmin_pct
	pbp_b11c_coins_dtsi_mcmax_pct
	pbp_b11c_ded_yn
	pbp_b11c_ded_amt
	pbp_b11c_copay_yn
	pbp_b11c_copay_ehc
	pbp_b11c_copay_mcmin_amt
	pbp_b11c_copay_mcmax_amt
	pbp_b11c_copay_dtsi_mcmin_amt
	pbp_b11c_copay_dtsi_mcmax_amt
	pbp_b11c_dme_limit_manufact_yn
	pbp_b11c_auth_yn
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
	pbp_b11a_maxenr_yn               = 'DME Max Enr YN'
	pbp_b11a_maxenr_amt              = 'DME Max Enr Amt'
	pbp_b11a_maxenr_per              = 'DME Max Enr Per'
	pbp_b11a_maxenr_per_d            = 'DME Max Enr Per Desc'
	pbp_b11a_coins_yn                = 'DME Coinsurance YN'
	pbp_b11a_coins_pct_mc            = 'DME MC Min Coins Pct'
	pbp_b11a_coins_pct_mcmax         = 'DME MC Max Coins Pct'
	pbp_b11a_ded_yn                  = 'DME Deductible YN'
	pbp_b11a_ded_amt                 = 'DME Deductible Amt'
	pbp_b11a_copay_yn                = 'DME Copayment YN'
	pbp_b11a_copay_mc_amt            = 'DME MC Min Copay Amt'
	pbp_b11a_copay_mcmax_amt         = 'DME MC Max Copay Amt'
	pbp_b11a_dme_pref_vend_man_yn    = 'DME Pref vendors/manufac YN'
	pbp_b11a_auth_yn                 = 'DME Auth YN'
	pbp_b11b_maxenr_yn               = 'Med Supplies Max Enr YN'
	pbp_b11b_maxenr_cost_type        = 'Med Supplies Max Enr Type'
	pbp_b11b_maxenr_amt              = 'Med Supplies Max Enr Amt'
	pbp_b11b_maxenr_per              = 'Med Supplies Max Enr Per'
	pbp_b11b_maxenr_per_d            = 'Med Supplies Max Enr Per Desc'
	pbp_b11b_coins_yn                = 'Med Supplies Coinsurance YN'
	pbp_b11b_coins_ehc               = 'Med Supplies Coins Svcs'
	pbp_b11b_coins_pct_mc            = 'Med Supplies Prosth Min Coins'
	pbp_b11b_coins_pct_mcmax         = 'Med Supplies Prosth Max Coins'
	pbp_b11b_coins_pct_mcms_min      = 'Med Supplies MC Min Coins Pct'
	pbp_b11b_coins_pct_mcms_max      = 'Med Supplies MC Max Coins Pct'
	pbp_b11b_ded_yn                  = 'Med Supplies Deductible YN'
	pbp_b11b_ded_amt                 = 'Med Supplies Deductible Amt'
	pbp_b11b_copay_yn                = 'Med Supplies Copayment YN'
	pbp_b11b_copay_ehc               = 'Med Supplies Copay Svcs'
	pbp_b11b_copay_mcmin_amt         = 'Med Supplies Prosth Min Copay'
	pbp_b11b_copay_mcmax_amt         = 'Med Supplies Prosth Max Copay'
	pbp_b11b_copay_mcms_min_amt      = 'Med Supplies MC Min Copay Amt'
	pbp_b11b_copay_mcms_max_amt      = 'Med Supplies MC Max Copay Amt'
	pbp_b11b_auth_yn                 = 'Med Supplies Auth YN'
	pbp_b11c_maxenr_yn               = 'DMS Max Enr YN'
	pbp_b11c_maxenr_cost_type        = 'DMS Max Enr Type'
	pbp_b11c_maxenr_amt              = 'DMS Max Enr Amt'
	pbp_b11c_maxenr_per              = 'DMS Max Enr Per'
	pbp_b11c_maxenr_per_d            = 'DMS Max Enr Per Desc'
	pbp_b11c_coins_yn                = 'DMS Coinsurance YN'
	pbp_b11c_coins_ehc               = 'DMS Coinsurance Svcs'
	pbp_b11c_coins_pct_mcmin         = 'DMS DS Min Coins Pct'
	pbp_b11c_coins_pct_mcmax         = 'DMS DS Max Coins Pct'
	pbp_b11c_coins_dtsi_mcmin_pct    = 'DMS DTSI Min Coins Pct'
	pbp_b11c_coins_dtsi_mcmax_pct    = 'DMS DTSI Max Coins Pct'
	pbp_b11c_ded_yn                  = 'DMS Deductible YN'
	pbp_b11c_ded_amt                 = 'DMS Deductible Amt'
	pbp_b11c_copay_yn                = 'DMS Copayment YN'
	pbp_b11c_copay_ehc               = 'DMS Copayment Svcs'
	pbp_b11c_copay_mcmin_amt         = 'DMS DS Min Copay Amt'
	pbp_b11c_copay_mcmax_amt         = 'DMS DS Max Copay Amt'
	pbp_b11c_copay_dtsi_mcmin_amt    = 'DMS DTSI Min Copay Amt'
	pbp_b11c_copay_dtsi_mcmax_amt    = 'DMS DTSI Max Copay Amt'
	pbp_b11c_dme_limit_manufact_yn   = 'DMS limit manufact YN'
	pbp_b11c_auth_yn                 = 'DMS Auth YN'
;

run;

proc sort data = pbp_b11 out=out.pbp_b11;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b11(obs = 10);
  title 'pbp_b11_dme_prosth_orth_sup file ';
run;

proc means data = out.pbp_b11;
  title 'pbp_b11_dme_prosth_orth_sup file ';
run;

proc freq data = out.pbp_b11;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b11a_maxenr_yn
	pbp_b11a_maxenr_per
	pbp_b11a_coins_yn
	pbp_b11a_ded_yn
	pbp_b11a_copay_yn
	pbp_b11a_dme_pref_vend_man_yn
	pbp_b11a_auth_yn
	pbp_b11b_maxenr_yn
	pbp_b11b_maxenr_cost_type
	pbp_b11b_maxenr_per
	pbp_b11b_coins_yn
	pbp_b11b_coins_ehc
	pbp_b11b_ded_yn
	pbp_b11b_copay_yn
	pbp_b11b_copay_ehc
	pbp_b11b_auth_yn
	pbp_b11c_maxenr_yn
	pbp_b11c_maxenr_cost_type
	pbp_b11c_maxenr_per
	pbp_b11c_coins_yn
	pbp_b11c_coins_ehc
	pbp_b11c_ded_yn
	pbp_b11c_copay_yn
	pbp_b11c_copay_ehc
	pbp_b11c_dme_limit_manufact_yn
	pbp_b11c_auth_yn
/ missing;
run;

proc contents data = out.pbp_b11;
  title 'pbp_b11 data';
run;