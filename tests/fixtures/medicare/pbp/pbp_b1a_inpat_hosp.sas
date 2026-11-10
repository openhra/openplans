*pbp_b1a_inpat_hosp.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b1a_inpat_hosp;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b1a_bendesc_yn               $1
	pbp_b1a_bendesc_ad_up_nmcs       $3
	pbp_b1a_bendesc_amo_ad           $1
	pbp_b1a_bendesc_lim_ad           $1
	pbp_b1a_bendesc_amo_nmcs         $1
	pbp_b1a_bendesc_amo_up           $1
	pbp_b1a_maxenr_yn                $1
	pbp_b1a_maxenr_per               $1
	pbp_b1a_maxenr_per_d             $4000
	pbp_b1a_cost_vary_tiers_yn       $1
	pbp_b1a_cost_vary_tier_num       $1
	pbp_b1a_cost_vary_low_tier       $1
	pbp_b1a_coins_yn                 $1
	pbp_b1a_mc_coins_cstshr_yn_t1    $1
	pbp_b1a_coins_mcs_int_num_t1     $1
	pbp_b1a_mc_coins_cstshr_yn_t2    $1
	pbp_b1a_coins_mcs_int_num_t2     $1
	pbp_b1a_mc_coins_cstshr_yn_t3    $1
	pbp_b1a_coins_mcs_int_num_t3     $1
	pbp_b1a_coins_lrd_int_num_t1     $1
	pbp_b1a_coins_lrd_int_num_t2     $1
	pbp_b1a_coins_lrd_int_num_t3     $1
	pbp_b1a_ad_cost_vary_tiers_yn    $1
	pbp_b1a_ad_cost_vary_tier_num    $1
	pbp_b1a_ad_cost_vary_low_tier    $1
	pbp_b1a_coins_ad_intrvl_num_t1   $1
	pbp_b1a_coins_ad_intrvl_num_t2   $1
	pbp_b1a_coins_ad_intrvl_num_t3   $1
	pbp_b1a_coins_nmcs_struc_yn      $1
	pbp_b1a_coins_nmcs_intrvl_num    $1
	pbp_b1a_coins_up_cstshr_yn       $1
	pbp_b1a_ded_yn                   $1
	pbp_b1a_copay_yn                 $1
	pbp_b1a_mc_copay_cstshr_yn_t1    $1
	pbp_b1a_copay_mcs_int_num_t1     $1
	pbp_b1a_mc_copay_cstshr_yn_t2    $1
	pbp_b1a_copay_mcs_int_num_t2     $1
	pbp_b1a_mc_copay_cstshr_yn_t3    $1
	pbp_b1a_copay_mcs_int_num_t3     $1
	pbp_b1a_copay_lrd_int_num_t1     $1
	pbp_b1a_copay_lrd_int_num_t2     $1
	pbp_b1a_copay_lrd_int_num_t3     $1
	pbp_b1a_copay_ad_intrvl_num_t1   $1
	pbp_b1a_copay_ad_intrvl_num_t2   $1
	pbp_b1a_copay_ad_intrvl_num_t3   $1
	pbp_b1a_copay_nmcs_struc_yn      $1
	pbp_b1a_copay_nmcs_intrvl_num    $1
	pbp_b1a_copay_up_cstshr_yn       $1
	pbp_b1a_hosp_ben_period          $1
	pbp_b1a_hosp_ben_period_oth      $4000
	pbp_b1a_cost_discharge_yn        $1
	pbp_b1a_auth_yn                  $1
	pbp_b1a_refer_yn                 $1
	pbp_b1a_bendesc_yn_bonly         $1
	pbp_b1a_bendesc_amo_iact_bonly   $1
	pbp_b1a_bendesc_ulim_bonly       $1
	pbp_b1a_bendesc_per_bonly        $1
	pbp_b1a_bendesc_per_bonly_d      $4000
	pbp_b1a_maxplan_yn_bonly         $1
	pbp_b1a_maxplan_per_bonly        $1
	pbp_b1a_maxplan_per_bonly_d      $4000
	pbp_b1a_maxenr_yn_bonly          $1
	pbp_b1a_maxenr_per_bonly         $1
	pbp_b1a_maxenr_per_bonly_d       $4000
	pbp_b1a_coins_yn_bonly           $1
	pbp_b1a_coins_ps_num_bonly       $1
	pbp_b1a_ded_yn_bonly             $1
	pbp_b1a_copay_yn_bonly           $1
	pbp_b1a_copay_ps_num_bonly       $1
	pbp_b1a_discharge_yn_bonly       $1
	pbp_b1a_auth_yn_bonly            $1
	pbp_b1a_refer_yn_bonly           $1
;

infile '.\pbp\pbp_b1a_inpat_hosp.txt' delimiter = '09'x
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
	pbp_b1a_bendesc_yn
	pbp_b1a_bendesc_ad_up_nmcs
	pbp_b1a_bendesc_amo_ad
	pbp_b1a_bendesc_lim_ad
	pbp_b1a_bendesc_amt_ad
	pbp_b1a_bendesc_amo_nmcs
	pbp_b1a_bendesc_amo_up
	pbp_b1a_maxenr_yn
	pbp_b1a_maxenr_amt
	pbp_b1a_maxenr_per
	pbp_b1a_maxenr_per_d
	pbp_b1a_cost_vary_tiers_yn
	pbp_b1a_cost_vary_tier_num
	pbp_b1a_cost_vary_low_tier
	pbp_b1a_coins_yn
	pbp_b1a_mc_coins_cstshr_yn_t1
	pbp_b1a_coins_mcs_pct_t1
	pbp_b1a_coins_mcs_int_num_t1
	pbp_b1a_coins_mcs_pct_int1_t1
	pbp_b1a_coins_mcs_bgnd_int1_t1
	pbp_b1a_coins_mcs_endd_int1_t1
	pbp_b1a_coins_mcs_pct_int2_t1
	pbp_b1a_coins_mcs_bgnd_int2_t1
	pbp_b1a_coins_mcs_endd_int2_t1
	pbp_b1a_coins_mcs_pct_int3_t1
	pbp_b1a_coins_mcs_bgnd_int3_t1
	pbp_b1a_coins_mcs_endd_int3_t1
	pbp_b1a_mc_coins_cstshr_yn_t2
	pbp_b1a_coins_mcs_pct_t2
	pbp_b1a_coins_mcs_int_num_t2
	pbp_b1a_coins_mcs_pct_int1_t2
	pbp_b1a_coins_mcs_bgnd_int1_t2
	pbp_b1a_coins_mcs_endd_int1_t2
	pbp_b1a_coins_mcs_pct_int2_t2
	pbp_b1a_coins_mcs_bgnd_int2_t2
	pbp_b1a_coins_mcs_endd_int2_t2
	pbp_b1a_coins_mcs_pct_int3_t2
	pbp_b1a_coins_mcs_bgnd_int3_t2
	pbp_b1a_coins_mcs_endd_int3_t2
	pbp_b1a_mc_coins_cstshr_yn_t3
	pbp_b1a_coins_mcs_pct_t3
	pbp_b1a_coins_mcs_int_num_t3
	pbp_b1a_coins_mcs_pct_int1_t3
	pbp_b1a_coins_mcs_bgnd_int1_t3
	pbp_b1a_coins_mcs_endd_int1_t3
	pbp_b1a_coins_mcs_pct_int2_t3
	pbp_b1a_coins_mcs_bgnd_int2_t3
	pbp_b1a_coins_mcs_endd_int2_t3
	pbp_b1a_coins_mcs_pct_int3_t3
	pbp_b1a_coins_mcs_bgnd_int3_t3
	pbp_b1a_coins_mcs_endd_int3_t3
	pbp_b1a_coins_lrd_int_num_t1
	pbp_b1a_coins_lrd_pct_int1_t1
	pbp_b1a_coins_lrd_bgnd_int1_t1
	pbp_b1a_coins_lrd_endd_int1_t1
	pbp_b1a_coins_lrd_pct_int2_t1
	pbp_b1a_coins_lrd_bgnd_int2_t1
	pbp_b1a_coins_lrd_endd_int2_t1
	pbp_b1a_coins_lrd_pct_int3_t1
	pbp_b1a_coins_lrd_bgnd_int3_t1
	pbp_b1a_coins_lrd_endd_int3_t1
	pbp_b1a_coins_lrd_int_num_t2
	pbp_b1a_coins_lrd_pct_int1_t2
	pbp_b1a_coins_lrd_bgnd_int1_t2
	pbp_b1a_coins_lrd_endd_int1_t2
	pbp_b1a_coins_lrd_pct_int2_t2
	pbp_b1a_coins_lrd_bgnd_int2_t2
	pbp_b1a_coins_lrd_endd_int2_t2
	pbp_b1a_coins_lrd_pct_int3_t2
	pbp_b1a_coins_lrd_bgnd_int3_t2
	pbp_b1a_coins_lrd_endd_int3_t2
	pbp_b1a_coins_lrd_int_num_t3
	pbp_b1a_coins_lrd_pct_int1_t3
	pbp_b1a_coins_lrd_bgnd_int1_t3
	pbp_b1a_coins_lrd_endd_int1_t3
	pbp_b1a_coins_lrd_pct_int2_t3
	pbp_b1a_coins_lrd_bgnd_int2_t3
	pbp_b1a_coins_lrd_endd_int2_t3
	pbp_b1a_coins_lrd_pct_int3_t3
	pbp_b1a_coins_lrd_bgnd_int3_t3
	pbp_b1a_coins_lrd_endd_int3_t3
	pbp_b1a_ad_cost_vary_tiers_yn
	pbp_b1a_ad_cost_vary_tier_num
	pbp_b1a_ad_cost_vary_low_tier
	pbp_b1a_coins_ad_intrvl_num_t1
	pbp_b1a_coins_ad_pct_int1_t1
	pbp_b1a_coins_ad_bgnd_int1_t1
	pbp_b1a_coins_ad_endd_int1_t1
	pbp_b1a_coins_ad_pct_int2_t1
	pbp_b1a_coins_ad_bgnd_int2_t1
	pbp_b1a_coins_ad_endd_int2_t1
	pbp_b1a_coins_ad_pct_int3_t1
	pbp_b1a_coins_ad_bgnd_int3_t1
	pbp_b1a_coins_ad_endd_int3_t1
	pbp_b1a_coins_ad_intrvl_num_t2
	pbp_b1a_coins_ad_pct_int1_t2
	pbp_b1a_coins_ad_bgnd_int1_t2
	pbp_b1a_coins_ad_endd_int1_t2
	pbp_b1a_coins_ad_pct_int2_t2
	pbp_b1a_coins_ad_bgnd_int2_t2
	pbp_b1a_coins_ad_endd_int2_t2
	pbp_b1a_coins_ad_pct_int3_t2
	pbp_b1a_coins_ad_bgnd_int3_t2
	pbp_b1a_coins_ad_endd_int3_t2
	pbp_b1a_coins_ad_intrvl_num_t3
	pbp_b1a_coins_ad_pct_int1_t3
	pbp_b1a_coins_ad_bgnd_int1_t3
	pbp_b1a_coins_ad_endd_int1_t3
	pbp_b1a_coins_ad_pct_int2_t3
	pbp_b1a_coins_ad_bgnd_int2_t3
	pbp_b1a_coins_ad_endd_int2_t3
	pbp_b1a_coins_ad_pct_int3_t3
	pbp_b1a_coins_ad_bgnd_int3_t3
	pbp_b1a_coins_ad_endd_int3_t3
	pbp_b1a_coins_nmcs_struc_yn
	pbp_b1a_coins_nmcs_pct
	pbp_b1a_coins_nmcs_intrvl_num
	pbp_b1a_coins_nmcs_pct_intrvl1
	pbp_b1a_coins_nmcs_bgnd_ntrvl1
	pbp_b1a_coins_nmcs_endd_ntrvl1
	pbp_b1a_coins_nmcs_pct_intrvl2
	pbp_b1a_coins_nmcs_bgnd_ntrvl2
	pbp_b1a_coins_nmcs_endd_ntrvl2
	pbp_b1a_coins_nmcs_pct_intrvl3
	pbp_b1a_coins_nmcs_bgnd_ntrvl3
	pbp_b1a_coins_nmcs_endd_ntrvl3
	pbp_b1a_coins_up_cstshr_yn
	pbp_b1a_coins_pct_up
	pbp_b1a_ded_yn
	pbp_b1a_ded_amt_t1
	pbp_b1a_ded_amt_t2
	pbp_b1a_ded_amt_t3
	pbp_b1a_copay_yn
	pbp_b1a_mc_copay_cstshr_yn_t1
	pbp_b1a_copay_mcs_amt_t1
	pbp_b1a_copay_mcs_int_num_t1
	pbp_b1a_copay_mcs_amt_int1_t1
	pbp_b1a_copay_mcs_bgnd_int1_t1
	pbp_b1a_copay_mcs_endd_int1_t1
	pbp_b1a_copay_mcs_amt_int2_t1
	pbp_b1a_copay_mcs_bgnd_int2_t1
	pbp_b1a_copay_mcs_endd_int2_t1
	pbp_b1a_copay_mcs_amt_int3_t1
	pbp_b1a_copay_mcs_bgnd_int3_t1
	pbp_b1a_copay_mcs_endd_int3_t1
	pbp_b1a_mc_copay_cstshr_yn_t2
	pbp_b1a_copay_mcs_amt_t2
	pbp_b1a_copay_mcs_int_num_t2
	pbp_b1a_copay_mcs_amt_int1_t2
	pbp_b1a_copay_mcs_bgnd_int1_t2
	pbp_b1a_copay_mcs_endd_int1_t2
	pbp_b1a_copay_mcs_amt_int2_t2
	pbp_b1a_copay_mcs_bgnd_int2_t2
	pbp_b1a_copay_mcs_endd_int2_t2
	pbp_b1a_copay_mcs_amt_int3_t2
	pbp_b1a_copay_mcs_bgnd_int3_t2
	pbp_b1a_copay_mcs_endd_int3_t2
	pbp_b1a_mc_copay_cstshr_yn_t3
	pbp_b1a_copay_mcs_amt_t3
	pbp_b1a_copay_mcs_int_num_t3
	pbp_b1a_copay_mcs_amt_int1_t3
	pbp_b1a_copay_mcs_bgnd_int1_t3
	pbp_b1a_copay_mcs_endd_int1_t3
	pbp_b1a_copay_mcs_amt_int2_t3
	pbp_b1a_copay_mcs_bgnd_int2_t3
	pbp_b1a_copay_mcs_endd_int2_t3
	pbp_b1a_copay_mcs_amt_int3_t3
	pbp_b1a_copay_mcs_bgnd_int3_t3
	pbp_b1a_copay_mcs_endd_int3_t3
	pbp_b1a_copay_lrd_int_num_t1
	pbp_b1a_copay_lrd_amt_int1_t1
	pbp_b1a_copay_lrd_bgnd_int1_t1
	pbp_b1a_copay_lrd_endd_int1_t1
	pbp_b1a_copay_lrd_amt_int2_t1
	pbp_b1a_copay_lrd_bgnd_int2_t1
	pbp_b1a_copay_lrd_endd_int2_t1
	pbp_b1a_copay_lrd_amt_int3_t1
	pbp_b1a_copay_lrd_bgnd_int3_t1
	pbp_b1a_copay_lrd_endd_int3_t1
	pbp_b1a_copay_lrd_int_num_t2
	pbp_b1a_copay_lrd_amt_int1_t2
	pbp_b1a_copay_lrd_bgnd_int1_t2
	pbp_b1a_copay_lrd_endd_int1_t2
	pbp_b1a_copay_lrd_amt_int2_t2
	pbp_b1a_copay_lrd_bgnd_int2_t2
	pbp_b1a_copay_lrd_endd_int2_t2
	pbp_b1a_copay_lrd_amt_int3_t2
	pbp_b1a_copay_lrd_bgnd_int3_t2
	pbp_b1a_copay_lrd_endd_int3_t2
	pbp_b1a_copay_lrd_int_num_t3
	pbp_b1a_copay_lrd_amt_int1_t3
	pbp_b1a_copay_lrd_bgnd_int1_t3
	pbp_b1a_copay_lrd_endd_int1_t3
	pbp_b1a_copay_lrd_amt_int2_t3
	pbp_b1a_copay_lrd_bgnd_int2_t3
	pbp_b1a_copay_lrd_endd_int2_t3
	pbp_b1a_copay_lrd_amt_int3_t3
	pbp_b1a_copay_lrd_bgnd_int3_t3
	pbp_b1a_copay_lrd_endd_int3_t3
	pbp_b1a_copay_ad_intrvl_num_t1
	pbp_b1a_copay_ad_amt_int1_t1
	pbp_b1a_copay_ad_bgnd_int1_t1
	pbp_b1a_copay_ad_endd_int1_t1
	pbp_b1a_copay_ad_amt_int2_t1
	pbp_b1a_copay_ad_bgnd_int2_t1
	pbp_b1a_copay_ad_endd_int2_t1
	pbp_b1a_copay_ad_amt_int3_t1
	pbp_b1a_copay_ad_bgnd_int3_t1
	pbp_b1a_copay_ad_endd_int3_t1
	pbp_b1a_copay_ad_intrvl_num_t2
	pbp_b1a_copay_ad_amt_int1_t2
	pbp_b1a_copay_ad_bgnd_int1_t2
	pbp_b1a_copay_ad_endd_int1_t2
	pbp_b1a_copay_ad_amt_int2_t2
	pbp_b1a_copay_ad_bgnd_int2_t2
	pbp_b1a_copay_ad_endd_int2_t2
	pbp_b1a_copay_ad_amt_int3_t2
	pbp_b1a_copay_ad_bgnd_int3_t2
	pbp_b1a_copay_ad_endd_int3_t2
	pbp_b1a_copay_ad_intrvl_num_t3
	pbp_b1a_copay_ad_amt_int1_t3
	pbp_b1a_copay_ad_bgnd_int1_t3
	pbp_b1a_copay_ad_endd_int1_t3
	pbp_b1a_copay_ad_amt_int2_t3
	pbp_b1a_copay_ad_bgnd_int2_t3
	pbp_b1a_copay_ad_endd_int2_t3
	pbp_b1a_copay_ad_amt_int3_t3
	pbp_b1a_copay_ad_bgnd_int3_t3
	pbp_b1a_copay_ad_endd_int3_t3
	pbp_b1a_copay_nmcs_struc_yn
	pbp_b1a_copay_nmcs_amt
	pbp_b1a_copay_nmcs_intrvl_num
	pbp_b1a_copay_nmcs_amt_intrvl1
	pbp_b1a_copay_nmcs_bgnd_ntrvl1
	pbp_b1a_copay_nmcs_endd_ntrvl1
	pbp_b1a_copay_nmcs_amt_intrvl2
	pbp_b1a_copay_nmcs_bgnd_ntrvl2
	pbp_b1a_copay_nmcs_endd_ntrvl2
	pbp_b1a_copay_nmcs_amt_intrvl3
	pbp_b1a_copay_nmcs_bgnd_ntrvl3
	pbp_b1a_copay_nmcs_endd_ntrvl3
	pbp_b1a_copay_up_cstshr_yn
	pbp_b1a_copay_up_amt_stay
	pbp_b1a_copay_up_amt_day
	pbp_b1a_hosp_ben_period
	pbp_b1a_hosp_ben_period_oth
	pbp_b1a_cost_discharge_yn
	pbp_b1a_auth_yn
	pbp_b1a_refer_yn
	pbp_b1a_bendesc_yn_bonly
	pbp_b1a_bendesc_amo_iact_bonly
	pbp_b1a_bendesc_ulim_bonly
	pbp_b1a_bendesc_amt_days_bonly
	pbp_b1a_bendesc_per_bonly
	pbp_b1a_bendesc_per_bonly_d
	pbp_b1a_maxplan_yn_bonly
	pbp_b1a_maxplan_amt_bonly
	pbp_b1a_maxplan_per_bonly
	pbp_b1a_maxplan_per_bonly_d
	pbp_b1a_maxenr_yn_bonly
	pbp_b1a_maxenr_amt_bonly
	pbp_b1a_maxenr_per_bonly
	pbp_b1a_maxenr_per_bonly_d
	pbp_b1a_coins_yn_bonly
	pbp_b1a_coins_pct_bonly
	pbp_b1a_coins_ps_num_bonly
	pbp_b1a_coins_ps_pct1_bonly
	pbp_b1a_coins_ps_bgnd1_bonly
	pbp_b1a_coins_ps_endd1_bonly
	pbp_b1a_coins_ps_pct2_bonly
	pbp_b1a_coins_ps_bgnd2_bonly
	pbp_b1a_coins_ps_endd2_bonly
	pbp_b1a_coins_ps_pct3_bonly
	pbp_b1a_coins_ps_bgnd3_bonly
	pbp_b1a_coins_ps_endd3_bonly
	pbp_b1a_ded_yn_bonly
	pbp_b1a_ded_amt_bonly
	pbp_b1a_copay_yn_bonly
	pbp_b1a_copay_amt_ps_bonly
	pbp_b1a_copay_ps_num_bonly
	pbp_b1a_copay_ps_amt1_bonly
	pbp_b1a_copay_ps_bgnd1_bonly
	pbp_b1a_copay_ps_endd1_bonly
	pbp_b1a_copay_ps_amt2_bonly
	pbp_b1a_copay_ps_bgnd2_bonly
	pbp_b1a_copay_ps_endd2_bonly
	pbp_b1a_copay_ps_amt3_bonly
	pbp_b1a_copay_ps_bgnd3_bonly
	pbp_b1a_copay_ps_endd3_bonly
	pbp_b1a_discharge_yn_bonly
	pbp_b1a_auth_yn_bonly
	pbp_b1a_refer_yn_bonly
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
	pbp_b1a_bendesc_yn               = 'IHA Supp Benefits YN'
	pbp_b1a_bendesc_ad_up_nmcs       = 'IHA (1a) Supp Benefits'
	pbp_b1a_bendesc_amo_ad           = 'IHA Ben Desc AD AMO'
	pbp_b1a_bendesc_lim_ad           = 'IHA Ben Desc AD Lim YN'
	pbp_b1a_bendesc_amt_ad           = 'IHA Ben Desc AD Amt'
	pbp_b1a_bendesc_amo_nmcs         = 'IHA Ben Desc NMCS AMO'
	pbp_b1a_bendesc_amo_up           = 'IHA Ben Desc UP AMO'
	pbp_b1a_maxenr_yn                = 'IHA Max Enr YN'
	pbp_b1a_maxenr_amt               = 'IHA Max Enr Amt'
	pbp_b1a_maxenr_per               = 'IHA Max Enr Per'
	pbp_b1a_maxenr_per_d             = 'IHA Max Enr Per Desc'
	pbp_b1a_cost_vary_tiers_yn       = 'IHA Cost Share Tiers Vary YN'
	pbp_b1a_cost_vary_tier_num       = 'IHA Cost Sharing Tiers'
	pbp_b1a_cost_vary_low_tier       = 'IHA Cost Shr Tier Low Num'
	pbp_b1a_coins_yn                 = 'IHA Coinsurance YN'
	pbp_b1a_mc_coins_cstshr_yn_t1    = 'IHA Med Def Coins Cost Shrs YN'
	pbp_b1a_coins_mcs_pct_t1         = 'IHA MCS Coins Pct'
	pbp_b1a_coins_mcs_int_num_t1     = 'IHA MCS Coins Interval Num'
	pbp_b1a_coins_mcs_pct_int1_t1    = 'IHA MCS Coins Pct Intrvl 1'
	pbp_b1a_coins_mcs_bgnd_int1_t1   = 'IHA MCS Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_mcs_endd_int1_t1   = 'IHA MCS Coins End Day Intrvl 1'
	pbp_b1a_coins_mcs_pct_int2_t1    = 'IHA MCS Coins Pct Intrvl 2'
	pbp_b1a_coins_mcs_bgnd_int2_t1   = 'IHA MCS Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_mcs_endd_int2_t1   = 'IHA MCS Coins End Day Intrvl 2'
	pbp_b1a_coins_mcs_pct_int3_t1    = 'IHA MCS Coins Pct Intrvl 3'
	pbp_b1a_coins_mcs_bgnd_int3_t1   = 'IHA MCS Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_mcs_endd_int3_t1   = 'IHA MCS Coins End Day Intrvl 3'
	pbp_b1a_mc_coins_cstshr_yn_t2    = 'IHA Med Def Coins Cost Shrs YN'
	pbp_b1a_coins_mcs_pct_t2         = 'IHA MCS Coins Pct'
	pbp_b1a_coins_mcs_int_num_t2     = 'IHA MCS Coins Interval Num'
	pbp_b1a_coins_mcs_pct_int1_t2    = 'IHA MCS Coins Pct Intrvl 1'
	pbp_b1a_coins_mcs_bgnd_int1_t2   = 'IHA MCS Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_mcs_endd_int1_t2   = 'IHA MCS Coins End Day Intrvl 1'
	pbp_b1a_coins_mcs_pct_int2_t2    = 'IHA MCS Coins Pct Intrvl 2'
	pbp_b1a_coins_mcs_bgnd_int2_t2   = 'IHA MCS Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_mcs_endd_int2_t2   = 'IHA MCS Coins End Day Intrvl 2'
	pbp_b1a_coins_mcs_pct_int3_t2    = 'IHA MCS Coins Pct Intrvl 3'
	pbp_b1a_coins_mcs_bgnd_int3_t2   = 'IHA MCS Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_mcs_endd_int3_t2   = 'IHA MCS Coins End Day Intrvl 3'
	pbp_b1a_mc_coins_cstshr_yn_t3    = 'IHA Med Def Coins Cost Shrs YN'
	pbp_b1a_coins_mcs_pct_t3         = 'IHA MCS Coins Pct'
	pbp_b1a_coins_mcs_int_num_t3     = 'IHA MCS Coins Interval Num'
	pbp_b1a_coins_mcs_pct_int1_t3    = 'IHA MCS Coins Pct Intrvl 1'
	pbp_b1a_coins_mcs_bgnd_int1_t3   = 'IHA MCS Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_mcs_endd_int1_t3   = 'IHA MCS Coins End Day Intrvl 1'
	pbp_b1a_coins_mcs_pct_int2_t3    = 'IHA MCS Coins Pct Intrvl 2'
	pbp_b1a_coins_mcs_bgnd_int2_t3   = 'IHA MCS Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_mcs_endd_int2_t3   = 'IHA MCS Coins End Day Intrvl 2'
	pbp_b1a_coins_mcs_pct_int3_t3    = 'IHA MCS Coins Pct Intrvl 3'
	pbp_b1a_coins_mcs_bgnd_int3_t3   = 'IHA MCS Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_mcs_endd_int3_t3   = 'IHA MCS Coins End Day Intrvl 3'
	pbp_b1a_coins_lrd_int_num_t1     = 'IHA LRD Coins Interval Num'
	pbp_b1a_coins_lrd_pct_int1_t1    = 'IHA LRD Coins Pct Intrvl 1'
	pbp_b1a_coins_lrd_bgnd_int1_t1   = 'IHA LRD Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_lrd_endd_int1_t1   = 'IHA LRD Coins End Day Intrvl 1'
	pbp_b1a_coins_lrd_pct_int2_t1    = 'IHA LRD Coins Pct Intrvl 2'
	pbp_b1a_coins_lrd_bgnd_int2_t1   = 'IHA LRD Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_lrd_endd_int2_t1   = 'IHA LRD Coins End Day Intrvl 2'
	pbp_b1a_coins_lrd_pct_int3_t1    = 'IHA LRD Coins Pct Intrvl 3'
	pbp_b1a_coins_lrd_bgnd_int3_t1   = 'IHA LRD Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_lrd_endd_int3_t1   = 'IHA LRD Coins End Day Intrvl 3'
	pbp_b1a_coins_lrd_int_num_t2     = 'IHA LRD Coins Interval Num'
	pbp_b1a_coins_lrd_pct_int1_t2    = 'IHA LRD Coins Pct Intrvl 1'
	pbp_b1a_coins_lrd_bgnd_int1_t2   = 'IHA LRD Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_lrd_endd_int1_t2   = 'IHA LRD Coins End Day Intrvl 1'
	pbp_b1a_coins_lrd_pct_int2_t2    = 'IHA LRD Coins Pct Intrvl 2'
	pbp_b1a_coins_lrd_bgnd_int2_t2   = 'IHA LRD Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_lrd_endd_int2_t2   = 'IHA LRD Coins End Day Intrvl 2'
	pbp_b1a_coins_lrd_pct_int3_t2    = 'IHA LRD Coins Pct Intrvl 3'
	pbp_b1a_coins_lrd_bgnd_int3_t2   = 'IHA LRD Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_lrd_endd_int3_t2   = 'IHA LRD Coins End Day Intrvl 3'
	pbp_b1a_coins_lrd_int_num_t3     = 'IHA LRD Coins Interval Num'
	pbp_b1a_coins_lrd_pct_int1_t3    = 'IHA LRD Coins Pct Intrvl 1'
	pbp_b1a_coins_lrd_bgnd_int1_t3   = 'IHA LRD Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_lrd_endd_int1_t3   = 'IHA LRD Coins End Day Intrvl 1'
	pbp_b1a_coins_lrd_pct_int2_t3    = 'IHA LRD Coins Pct Intrvl 2'
	pbp_b1a_coins_lrd_bgnd_int2_t3   = 'IHA LRD Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_lrd_endd_int2_t3   = 'IHA LRD Coins End Day Intrvl 2'
	pbp_b1a_coins_lrd_pct_int3_t3    = 'IHA LRD Coins Pct Intrvl 3'
	pbp_b1a_coins_lrd_bgnd_int3_t3   = 'IHA LRD Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_lrd_endd_int3_t3   = 'IHA LRD Coins End Day Intrvl 3'
	pbp_b1a_ad_cost_vary_tiers_yn    = 'IHA AD Cost ByTiers Vary YN'
	pbp_b1a_ad_cost_vary_tier_num    = 'IHA AD Cost Sharing Tiers'
	pbp_b1a_ad_cost_vary_low_tier    = 'IHA AD Lowest Cost Tier'
	pbp_b1a_coins_ad_intrvl_num_t1   = 'IHA AD Coins Interval Num'
	pbp_b1a_coins_ad_pct_int1_t1     = 'IHA AD Coins Pct Intrvl 1'
	pbp_b1a_coins_ad_bgnd_int1_t1    = 'IHA AD Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_ad_endd_int1_t1    = 'IHA AD Coins End Day Intrvl 1'
	pbp_b1a_coins_ad_pct_int2_t1     = 'IHA AD Coins Pct Intrvl 2'
	pbp_b1a_coins_ad_bgnd_int2_t1    = 'IHA AD Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_ad_endd_int2_t1    = 'IHA AD Coins End Day Intrvl 2'
	pbp_b1a_coins_ad_pct_int3_t1     = 'IHA AD Coins Pct Intrvl 3'
	pbp_b1a_coins_ad_bgnd_int3_t1    = 'IHA AD Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_ad_endd_int3_t1    = 'IHA AD Coins End Day Intrvl 3'
	pbp_b1a_coins_ad_intrvl_num_t2   = 'IHA AD Coins Interval Num'
	pbp_b1a_coins_ad_pct_int1_t2     = 'IHA AD Coins Pct Intrvl 1'
	pbp_b1a_coins_ad_bgnd_int1_t2    = 'IHA AD Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_ad_endd_int1_t2    = 'IHA AD Coins End Day Intrvl 1'
	pbp_b1a_coins_ad_pct_int2_t2     = 'IHA AD Coins Pct Intrvl 2'
	pbp_b1a_coins_ad_bgnd_int2_t2    = 'IHA AD Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_ad_endd_int2_t2    = 'IHA AD Coins End Day Intrvl 2'
	pbp_b1a_coins_ad_pct_int3_t2     = 'IHA AD Coins Pct Intrvl 3'
	pbp_b1a_coins_ad_bgnd_int3_t2    = 'IHA AD Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_ad_endd_int3_t2    = 'IHA AD Coins End Day Intrvl 3'
	pbp_b1a_coins_ad_intrvl_num_t3   = 'IHA AD Coins Interval Num'
	pbp_b1a_coins_ad_pct_int1_t3     = 'IHA AD Coins Pct Intrvl 1'
	pbp_b1a_coins_ad_bgnd_int1_t3    = 'IHA AD Coins Bgn Day Intrvl 1'
	pbp_b1a_coins_ad_endd_int1_t3    = 'IHA AD Coins End Day Intrvl 1'
	pbp_b1a_coins_ad_pct_int2_t3     = 'IHA AD Coins Pct Intrvl 2'
	pbp_b1a_coins_ad_bgnd_int2_t3    = 'IHA AD Coins Bgn Day Intrvl 2'
	pbp_b1a_coins_ad_endd_int2_t3    = 'IHA AD Coins End Day Intrvl 2'
	pbp_b1a_coins_ad_pct_int3_t3     = 'IHA AD Coins Pct Intrvl 3'
	pbp_b1a_coins_ad_bgnd_int3_t3    = 'IHA AD Coins Bgn Day Intrvl 3'
	pbp_b1a_coins_ad_endd_int3_t3    = 'IHA AD Coins End Day Intrvl 3'
	pbp_b1a_coins_nmcs_struc_yn      = 'IHA NMCS Coins Structure YN'
	pbp_b1a_coins_nmcs_pct           = 'IHA NMCS Coins Pct'
	pbp_b1a_coins_nmcs_intrvl_num    = 'IHA NMCS Coins Interval Num'
	pbp_b1a_coins_nmcs_pct_intrvl1   = 'IHA NMCS Coins Pct Intrvl 1'
	pbp_b1a_coins_nmcs_bgnd_ntrvl1   = 'IHA NMCS Coins BgnDay Intrvl 1'
	pbp_b1a_coins_nmcs_endd_ntrvl1   = 'IHA NMCS Coins EndDay Intrvl 1'
	pbp_b1a_coins_nmcs_pct_intrvl2   = 'IHA NMCS Coins Pct Intrvl 2'
	pbp_b1a_coins_nmcs_bgnd_ntrvl2   = 'IHA NMCS Coins BgnDay Intrvl 2'
	pbp_b1a_coins_nmcs_endd_ntrvl2   = 'IHA NMCS Coins EndDay Intrvl 2'
	pbp_b1a_coins_nmcs_pct_intrvl3   = 'IHA NMCS Coins Pct Intrvl 3'
	pbp_b1a_coins_nmcs_bgnd_ntrvl3   = 'IHA NMCS Coins BgnDay Intrvl 3'
	pbp_b1a_coins_nmcs_endd_ntrvl3   = 'IHA NMCS Coins EndDay Intrvl 3'
	pbp_b1a_coins_up_cstshr_yn       = 'IHA UP Cost Same MC YN'
	pbp_b1a_coins_pct_up             = 'IHA UP Coin Pct'
	pbp_b1a_ded_yn                   = 'IHA Deductible YN'
	pbp_b1a_ded_amt_t1               = 'IHA Deductible Amt Tier 1'
	pbp_b1a_ded_amt_t2               = 'IHA Deductible Amt Tier 2'
	pbp_b1a_ded_amt_t3               = 'IHA Deductible Amt Tier 3'
	pbp_b1a_copay_yn                 = 'IHA Copayment YN'
	pbp_b1a_mc_copay_cstshr_yn_t1    = 'IHA Med Def Copay Cost Shrs YN'
	pbp_b1a_copay_mcs_amt_t1         = 'IHA MCS Copay Amt'
	pbp_b1a_copay_mcs_int_num_t1     = 'IHA MCS Copay Interval Num'
	pbp_b1a_copay_mcs_amt_int1_t1    = 'IHA MCS Copay Amt Interval 1'
	pbp_b1a_copay_mcs_bgnd_int1_t1   = 'IHA MCS Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_mcs_endd_int1_t1   = 'IHA MCS Copay End Day Intrvl 1'
	pbp_b1a_copay_mcs_amt_int2_t1    = 'IHA MCS Copay Amt Interval 2'
	pbp_b1a_copay_mcs_bgnd_int2_t1   = 'IHA MCS Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_mcs_endd_int2_t1   = 'IHA MCS Copay End Day Intrvl 2'
	pbp_b1a_copay_mcs_amt_int3_t1    = 'IHA MCS Copay Amt Interval 3'
	pbp_b1a_copay_mcs_bgnd_int3_t1   = 'IHA MCS Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_mcs_endd_int3_t1   = 'IHA MCS Copay End Day Intrvl 3'
	pbp_b1a_mc_copay_cstshr_yn_t2    = 'IHA Med Def Copay Cost Shrs YN'
	pbp_b1a_copay_mcs_amt_t2         = 'IHA MCS Copay Amt'
	pbp_b1a_copay_mcs_int_num_t2     = 'IHA MCS Copay Interval Num'
	pbp_b1a_copay_mcs_amt_int1_t2    = 'IHA MCS Copay Amt Interval 1'
	pbp_b1a_copay_mcs_bgnd_int1_t2   = 'IHA MCS Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_mcs_endd_int1_t2   = 'IHA MCS Copay End Day Intrvl 1'
	pbp_b1a_copay_mcs_amt_int2_t2    = 'IHA MCS Copay Amt Interval 2'
	pbp_b1a_copay_mcs_bgnd_int2_t2   = 'IHA MCS Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_mcs_endd_int2_t2   = 'IHA MCS Copay End Day Intrvl 2'
	pbp_b1a_copay_mcs_amt_int3_t2    = 'IHA MCS Copay Amt Interval 3'
	pbp_b1a_copay_mcs_bgnd_int3_t2   = 'IHA MCS Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_mcs_endd_int3_t2   = 'IHA MCS Copay End Day Intrvl 3'
	pbp_b1a_mc_copay_cstshr_yn_t3    = 'IHA Med Def Copay Cost Shrs YN'
	pbp_b1a_copay_mcs_amt_t3         = 'IHA MCS Copay Amt'
	pbp_b1a_copay_mcs_int_num_t3     = 'IHA MCS Copay Interval Num'
	pbp_b1a_copay_mcs_amt_int1_t3    = 'IHA MCS Copay Amt Interval 1'
	pbp_b1a_copay_mcs_bgnd_int1_t3   = 'IHA MCS Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_mcs_endd_int1_t3   = 'IHA MCS Copay End Day Intrvl 1'
	pbp_b1a_copay_mcs_amt_int2_t3    = 'IHA MCS Copay Amt Interval 2'
	pbp_b1a_copay_mcs_bgnd_int2_t3   = 'IHA MCS Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_mcs_endd_int2_t3   = 'IHA MCS Copay End Day Intrvl 2'
	pbp_b1a_copay_mcs_amt_int3_t3    = 'IHA MCS Copay Amt Interval 3'
	pbp_b1a_copay_mcs_bgnd_int3_t3   = 'IHA MCS Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_mcs_endd_int3_t3   = 'IHA MCS Copay End Day Intrvl 3'
	pbp_b1a_copay_lrd_int_num_t1     = 'IHA LRD Copay Interval Num'
	pbp_b1a_copay_lrd_amt_int1_t1    = 'IHA LRD Copay Amt Interval 1'
	pbp_b1a_copay_lrd_bgnd_int1_t1   = 'IHA LRD Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_lrd_endd_int1_t1   = 'IHA LRD Copay End Day Intrvl 1'
	pbp_b1a_copay_lrd_amt_int2_t1    = 'IHA LRD Copay Amt Interval 2'
	pbp_b1a_copay_lrd_bgnd_int2_t1   = 'IHA LRD Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_lrd_endd_int2_t1   = 'IHA LRD Copay End Day Intrvl 2'
	pbp_b1a_copay_lrd_amt_int3_t1    = 'IHA LRD Copay Amt Interval 3'
	pbp_b1a_copay_lrd_bgnd_int3_t1   = 'IHA LRD Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_lrd_endd_int3_t1   = 'IHA LRD Copay End Day Intrvl 3'
	pbp_b1a_copay_lrd_int_num_t2     = 'IHA LRD Copay Interval Num'
	pbp_b1a_copay_lrd_amt_int1_t2    = 'IHA LRD Copay Amt Interval 1'
	pbp_b1a_copay_lrd_bgnd_int1_t2   = 'IHA LRD Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_lrd_endd_int1_t2   = 'IHA LRD Copay End Day Intrvl 1'
	pbp_b1a_copay_lrd_amt_int2_t2    = 'IHA LRD Copay Amt Interval 2'
	pbp_b1a_copay_lrd_bgnd_int2_t2   = 'IHA LRD Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_lrd_endd_int2_t2   = 'IHA LRD Copay End Day Intrvl 2'
	pbp_b1a_copay_lrd_amt_int3_t2    = 'IHA LRD Copay Amt Interval 3'
	pbp_b1a_copay_lrd_bgnd_int3_t2   = 'IHA LRD Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_lrd_endd_int3_t2   = 'IHA LRD Copay End Day Intrvl 3'
	pbp_b1a_copay_lrd_int_num_t3     = 'IHA LRD Copay Interval Num'
	pbp_b1a_copay_lrd_amt_int1_t3    = 'IHA LRD Copay Amt Interval 1'
	pbp_b1a_copay_lrd_bgnd_int1_t3   = 'IHA LRD Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_lrd_endd_int1_t3   = 'IHA LRD Copay End Day Intrvl 1'
	pbp_b1a_copay_lrd_amt_int2_t3    = 'IHA LRD Copay Amt Interval 2'
	pbp_b1a_copay_lrd_bgnd_int2_t3   = 'IHA LRD Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_lrd_endd_int2_t3   = 'IHA LRD Copay End Day Intrvl 2'
	pbp_b1a_copay_lrd_amt_int3_t3    = 'IHA LRD Copay Amt Interval 3'
	pbp_b1a_copay_lrd_bgnd_int3_t3   = 'IHA LRD Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_lrd_endd_int3_t3   = 'IHA LRD Copay End Day Intrvl 3'
	pbp_b1a_copay_ad_intrvl_num_t1   = 'IHA AD Copay Interval Num'
	pbp_b1a_copay_ad_amt_int1_t1     = 'IHA AD Copay Amt Interval 1'
	pbp_b1a_copay_ad_bgnd_int1_t1    = 'IHA AD Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_ad_endd_int1_t1    = 'IHA AD Copay End Day Intrvl 1'
	pbp_b1a_copay_ad_amt_int2_t1     = 'IHA AD Copay Amt Interval 2'
	pbp_b1a_copay_ad_bgnd_int2_t1    = 'IHA AD Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_ad_endd_int2_t1    = 'IHA AD Copay End Day Intrvl 2'
	pbp_b1a_copay_ad_amt_int3_t1     = 'IHA AD Copay Amt Interval 3'
	pbp_b1a_copay_ad_bgnd_int3_t1    = 'IHA AD Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_ad_endd_int3_t1    = 'IHA AD Copay End Day Intrvl 3'
	pbp_b1a_copay_ad_intrvl_num_t2   = 'IHA AD Copay Interval Num'
	pbp_b1a_copay_ad_amt_int1_t2     = 'IHA AD Copay Amt Interval 1'
	pbp_b1a_copay_ad_bgnd_int1_t2    = 'IHA AD Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_ad_endd_int1_t2    = 'IHA AD Copay End Day Intrvl 1'
	pbp_b1a_copay_ad_amt_int2_t2     = 'IHA AD Copay Amt Interval 2'
	pbp_b1a_copay_ad_bgnd_int2_t2    = 'IHA AD Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_ad_endd_int2_t2    = 'IHA AD Copay End Day Intrvl 2'
	pbp_b1a_copay_ad_amt_int3_t2     = 'IHA AD Copay Amt Interval 3'
	pbp_b1a_copay_ad_bgnd_int3_t2    = 'IHA AD Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_ad_endd_int3_t2    = 'IHA AD Copay End Day Intrvl 3'
	pbp_b1a_copay_ad_intrvl_num_t3   = 'IHA AD Copay Interval Num'
	pbp_b1a_copay_ad_amt_int1_t3     = 'IHA AD Copay Amt Interval 1'
	pbp_b1a_copay_ad_bgnd_int1_t3    = 'IHA AD Copay Bgn Day Intrvl 1'
	pbp_b1a_copay_ad_endd_int1_t3    = 'IHA AD Copay End Day Intrvl 1'
	pbp_b1a_copay_ad_amt_int2_t3     = 'IHA AD Copay Amt Interval 2'
	pbp_b1a_copay_ad_bgnd_int2_t3    = 'IHA AD Copay Bgn Day Intrvl 2'
	pbp_b1a_copay_ad_endd_int2_t3    = 'IHA AD Copay End Day Intrvl 2'
	pbp_b1a_copay_ad_amt_int3_t3     = 'IHA AD Copay Amt Interval 3'
	pbp_b1a_copay_ad_bgnd_int3_t3    = 'IHA AD Copay Bgn Day Intrvl 3'
	pbp_b1a_copay_ad_endd_int3_t3    = 'IHA AD Copay End Day Intrvl 3'
	pbp_b1a_copay_nmcs_struc_yn      = 'IHA NMCS Copay Structure YN'
	pbp_b1a_copay_nmcs_amt           = 'IHA NMCS Copay Amt'
	pbp_b1a_copay_nmcs_intrvl_num    = 'IHA NMCS Copay Interval Num'
	pbp_b1a_copay_nmcs_amt_intrvl1   = 'IHA NMCS Copay Amt Interval 1'
	pbp_b1a_copay_nmcs_bgnd_ntrvl1   = 'IHA NMCS Copay BgnDay Intrvl 1'
	pbp_b1a_copay_nmcs_endd_ntrvl1   = 'IHA NMCS Copay EndDay Intrvl 1'
	pbp_b1a_copay_nmcs_amt_intrvl2   = 'IHA NMCS Copay Amt Interval 2'
	pbp_b1a_copay_nmcs_bgnd_ntrvl2   = 'IHA NMCS Copay BgnDay Intrvl 2'
	pbp_b1a_copay_nmcs_endd_ntrvl2   = 'IHA NMCS Copay EndDay Intrvl 2'
	pbp_b1a_copay_nmcs_amt_intrvl3   = 'IHA NMCS Copay Amt Interval 3'
	pbp_b1a_copay_nmcs_bgnd_ntrvl3   = 'IHA NMCS Copay BgnDay Intrvl 3'
	pbp_b1a_copay_nmcs_endd_ntrvl3   = 'IHA NMCS Copay EndDay Intrvl 3'
	pbp_b1a_copay_up_cstshr_yn       = 'IHA UP Copay Same MCS YN'
	pbp_b1a_copay_up_amt_stay        = 'IHA UP Copay Stay Amt'
	pbp_b1a_copay_up_amt_day         = 'IHA UP Copay Day Amt'
	pbp_b1a_hosp_ben_period          = 'IHA Hospital Ben Period'
	pbp_b1a_hosp_ben_period_oth      = 'IHA Hospital Period Other'
	pbp_b1a_cost_discharge_yn        = 'IHA Costsharing discharge YN'
	pbp_b1a_auth_yn                  = 'IHA Enrollee Auth'
	pbp_b1a_refer_yn                 = 'IHA Referral YN'
	pbp_b1a_bendesc_yn_bonly         = 'IHA(B) Ben Desc YN'
	pbp_b1a_bendesc_amo_iact_bonly   = 'IHA(B) Ben Desc AMO'
	pbp_b1a_bendesc_ulim_bonly       = 'IHA(B) Ben Desc Lim YN'
	pbp_b1a_bendesc_amt_days_bonly   = 'IHA(B) Ben Desc Num'
	pbp_b1a_bendesc_per_bonly        = 'IHA(B) Ben Desc Per'
	pbp_b1a_bendesc_per_bonly_d      = 'IHA(B) Ben Desc Per Desc'
	pbp_b1a_maxplan_yn_bonly         = 'IHA(B) Max Plan YN'
	pbp_b1a_maxplan_amt_bonly        = 'IHA(B) Max Plan Amt'
	pbp_b1a_maxplan_per_bonly        = 'IHA(B) Max Plan Per'
	pbp_b1a_maxplan_per_bonly_d      = 'IHA(B) Max Plan Per Desc'
	pbp_b1a_maxenr_yn_bonly          = 'IHA(B) Max Enr YN'
	pbp_b1a_maxenr_amt_bonly         = 'IHA(B) Max Enr Amt'
	pbp_b1a_maxenr_per_bonly         = 'IHA(B) Max Enr Per'
	pbp_b1a_maxenr_per_bonly_d       = 'IHA(B) Max Enr Per Desc'
	pbp_b1a_coins_yn_bonly           = 'IHA(B) Coinsurance YN'
	pbp_b1a_coins_pct_bonly          = 'IHA(B) Coins Pct'
	pbp_b1a_coins_ps_num_bonly       = 'IHA(B) PS Coins Interval Num'
	pbp_b1a_coins_ps_pct1_bonly      = 'IHA(B) PS Coins Pct Intrvl 1'
	pbp_b1a_coins_ps_bgnd1_bonly     = 'IHA(B) PS Coin Bgn Day Intrv 1'
	pbp_b1a_coins_ps_endd1_bonly     = 'IHA(B) PS Coin End Day Intrv 1'
	pbp_b1a_coins_ps_pct2_bonly      = 'IHA(B) PS Coins Pct Intrvl 2'
	pbp_b1a_coins_ps_bgnd2_bonly     = 'IHA(B) PS Coin Bgn Day Intrv 2'
	pbp_b1a_coins_ps_endd2_bonly     = 'IHA(B) PS Coin End Day Intrv 2'
	pbp_b1a_coins_ps_pct3_bonly      = 'IHA(B) PS Coins Pct Intrvl 3'
	pbp_b1a_coins_ps_bgnd3_bonly     = 'IHA(B) PS Coin Bgn Day Intrv 3'
	pbp_b1a_coins_ps_endd3_bonly     = 'IHA(B) PS Coin End Day Intrv 3'
	pbp_b1a_ded_yn_bonly             = 'IHA(B) Deductible YN'
	pbp_b1a_ded_amt_bonly            = 'IHA(B) Deductible Amt'
	pbp_b1a_copay_yn_bonly           = 'IHA(B) Copayment YN'
	pbp_b1a_copay_amt_ps_bonly       = 'IHA(B) PS Copay Amt'
	pbp_b1a_copay_ps_num_bonly       = 'IHA(B) PS Copay Interval Num'
	pbp_b1a_copay_ps_amt1_bonly      = 'IHA(B) PS Copay Amt Interval 1'
	pbp_b1a_copay_ps_bgnd1_bonly     = 'IHA(B) PS Cpay Beg Day Intrv 1'
	pbp_b1a_copay_ps_endd1_bonly     = 'IHA(B) PS Cpay End Day Intrv 1'
	pbp_b1a_copay_ps_amt2_bonly      = 'IHA(B) PS Copay Amt Interval 2'
	pbp_b1a_copay_ps_bgnd2_bonly     = 'IHA(B) PS Cpay Bgn Day Intrv 2'
	pbp_b1a_copay_ps_endd2_bonly     = 'IHA(B) PS Cpay End Day Intrv 2'
	pbp_b1a_copay_ps_amt3_bonly      = 'IHA(B) PS Copay Amt Interval 3'
	pbp_b1a_copay_ps_bgnd3_bonly     = 'IHA(B) PS Cpay Bgn Day Intrv 3'
	pbp_b1a_copay_ps_endd3_bonly     = 'IHA(B) PS Cpay End Day Intrv 3'
	pbp_b1a_discharge_yn_bonly       = 'IHA(B) Discharge Cost Charge'
	pbp_b1a_auth_yn_bonly            = 'IHA(B) Enrollee Auth'
	pbp_b1a_refer_yn_bonly           = 'IHA(B) Referral YN'
;

run;

proc sort data = pbp_b1a_inpat_hosp out=out.pbp_b1a_inpat_hosp;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b1a_inpat_hosp(obs = 10);
  title 'pbp_b1a_inpat_hosp file ';
run;

proc means data = out.pbp_b1a_inpat_hosp;
  title 'pbp_b1a_inpat_hosp file ';
run;

proc freq data = out.pbp_b1a_inpat_hosp;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b1a_bendesc_yn
	pbp_b1a_bendesc_ad_up_nmcs
	pbp_b1a_bendesc_amo_ad
	pbp_b1a_bendesc_lim_ad
	pbp_b1a_bendesc_amo_nmcs
	pbp_b1a_bendesc_amo_up
	pbp_b1a_maxenr_yn
	pbp_b1a_maxenr_per
	pbp_b1a_cost_vary_tiers_yn
	pbp_b1a_cost_vary_tier_num
	pbp_b1a_cost_vary_low_tier
	pbp_b1a_coins_yn
	pbp_b1a_mc_coins_cstshr_yn_t1
	pbp_b1a_coins_mcs_int_num_t1
	pbp_b1a_mc_coins_cstshr_yn_t2
	pbp_b1a_coins_mcs_int_num_t2
	pbp_b1a_mc_coins_cstshr_yn_t3
	pbp_b1a_coins_mcs_int_num_t3
	pbp_b1a_coins_lrd_int_num_t1
	pbp_b1a_coins_lrd_int_num_t2
	pbp_b1a_coins_lrd_int_num_t3
	pbp_b1a_ad_cost_vary_tiers_yn
	pbp_b1a_ad_cost_vary_tier_num
	pbp_b1a_ad_cost_vary_low_tier
	pbp_b1a_coins_ad_intrvl_num_t1
	pbp_b1a_coins_ad_intrvl_num_t2
	pbp_b1a_coins_ad_intrvl_num_t3
	pbp_b1a_coins_nmcs_struc_yn
	pbp_b1a_coins_nmcs_intrvl_num
	pbp_b1a_coins_up_cstshr_yn
	pbp_b1a_ded_yn
	pbp_b1a_copay_yn
	pbp_b1a_mc_copay_cstshr_yn_t1
	pbp_b1a_copay_mcs_int_num_t1
	pbp_b1a_mc_copay_cstshr_yn_t2
	pbp_b1a_copay_mcs_int_num_t2
	pbp_b1a_mc_copay_cstshr_yn_t3
	pbp_b1a_copay_mcs_int_num_t3
	pbp_b1a_copay_lrd_int_num_t1
	pbp_b1a_copay_lrd_int_num_t2
	pbp_b1a_copay_lrd_int_num_t3
	pbp_b1a_copay_ad_intrvl_num_t1
	pbp_b1a_copay_ad_intrvl_num_t2
	pbp_b1a_copay_ad_intrvl_num_t3
	pbp_b1a_copay_nmcs_struc_yn
	pbp_b1a_copay_nmcs_intrvl_num
	pbp_b1a_copay_up_cstshr_yn
	pbp_b1a_hosp_ben_period
	pbp_b1a_cost_discharge_yn
	pbp_b1a_auth_yn
	pbp_b1a_refer_yn
	pbp_b1a_bendesc_yn_bonly
	pbp_b1a_bendesc_amo_iact_bonly
	pbp_b1a_bendesc_ulim_bonly
	pbp_b1a_bendesc_per_bonly
	pbp_b1a_maxplan_yn_bonly
	pbp_b1a_maxplan_per_bonly
	pbp_b1a_maxenr_yn_bonly
	pbp_b1a_maxenr_per_bonly
	pbp_b1a_coins_yn_bonly
	pbp_b1a_coins_ps_num_bonly
	pbp_b1a_ded_yn_bonly
	pbp_b1a_copay_yn_bonly
	pbp_b1a_copay_ps_num_bonly
	pbp_b1a_discharge_yn_bonly
	pbp_b1a_auth_yn_bonly
	pbp_b1a_refer_yn_bonly
/ missing;
run;

proc contents data = out.pbp_b1a_inpat_hosp;
  title 'pbp_b1a_inpat_hosp data';
run;