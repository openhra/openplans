*pbp_b1b_inpat_hosp.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b1b;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b1b_bendesc_yn               $1
	pbp_b1b_bendesc_ad_nmcs          $2
	pbp_b1b_bendesc_amo_ad           $1
	pbp_b1b_bendesc_lim_ad           $1
	pbp_b1b_bendesc_amo_nmcs         $1
	pbp_b1b_maxenr_yn                $1
	pbp_b1b_maxenr_type              $1
	pbp_b1b_maxenr_per               $1
	pbp_b1b_maxenr_per_d             $4000
	pbp_b1b_cost_vary_tiers_yn       $1
	pbp_b1b_cost_vary_tier_num       $1
	pbp_b1b_cost_vary_low_tier       $1
	pbp_b1b_coins_yn                 $1
	pbp_b1b_mc_coins_cstshr_yn_t1    $1
	pbp_b1b_coins_mcs_int_num_t1     $1
	pbp_b1b_mc_coins_cstshr_yn_t2    $1
	pbp_b1b_coins_mcs_int_num_t2     $1
	pbp_b1b_mc_coins_cstshr_yn_t3    $1
	pbp_b1b_coins_mcs_int_num_t3     $1
	pbp_b1b_coins_lrd_int_num_t1     $1
	pbp_b1b_coins_lrd_int_num_t2     $1
	pbp_b1b_coins_lrd_int_num_t3     $1
	pbp_b1b_ad_cost_vary_tiers_yn    $1
	pbp_b1b_ad_cost_vary_tier_num    $1
	pbp_b1b_ad_cost_vary_low_tier    $1
	pbp_b1b_coins_ad_intrvl_num_t1   $1
	pbp_b1b_coins_ad_intrvl_num_t2   $1
	pbp_b1b_coins_ad_intrvl_num_t3   $1
	pbp_b1b_coins_nmcs_struc_yn      $1
	pbp_b1b_coins_nmcs_intrvl_num    $1
	pbp_b1b_ded_yn                   $1
	pbp_b1b_copay_yn                 $1
	pbp_b1b_mc_copay_cstshr_yn_t1    $1
	pbp_b1b_copay_mcs_int_num_t1     $1
	pbp_b1b_mc_copay_cstshr_yn_t2    $1
	pbp_b1b_copay_mcs_int_num_t2     $1
	pbp_b1b_mc_copay_cstshr_yn_t3    $1
	pbp_b1b_copay_mcs_int_num_t3     $1
	pbp_b1b_copay_lrd_int_num_t1     $1
	pbp_b1b_copay_lrd_int_num_t2     $1
	pbp_b1b_copay_lrd_int_num_t3     $1
	pbp_b1b_copay_ad_intrvl_num_t1   $1
	pbp_b1b_copay_ad_intrvl_num_t2   $1
	pbp_b1b_copay_ad_intrvl_num_t3   $1
	pbp_b1b_copay_nmcs_struc_yn      $1
	pbp_b1b_copay_nmcs_intrvl_num    $1
	pbp_b1b_hosp_ben_period          $1
	pbp_b1b_hosp_ben_period_oth      $4000
	pbp_b1b_cost_discharge_yn        $1
	pbp_b1b_auth_yn                  $1
	pbp_b1b_refer_yn                 $1
	pbp_b1b_bendesc_yn_bonly         $1
	pbp_b1b_bendesc_amo_bonly        $1
	pbp_b1b_bendesc_lim_bonly        $1
	pbp_b1b_bendesc_per_bonly        $1
	pbp_b1b_bendesc_per_bonly_d      $4000
	pbp_b1b_maxplan_yn_bonly         $1
	pbp_b1b_maxplan_type_bonly       $1
	pbp_b1b_maxplan_per_bonly        $1
	pbp_b1b_maxplan_per_bonly_d      $4000
	pbp_b1b_maxenr_yn_bonly          $1
	pbp_b1b_maxenr_type_bonly        $1
	pbp_b1b_maxenr_per_bonly         $1
	pbp_b1b_maxenr_per_bonly_d       $4000
	pbp_b1b_coins_yn_bonly           $1
	pbp_b1b_coins_ps_num_bonly       $1
	pbp_b1b_ded_yn_bonly             $1
	pbp_b1b_copay_yn_bonly           $1
	pbp_b1b_copay_ps_num_bonly       $1
	pbp_b1b_discharge_yn_bonly       $1
	pbp_b1b_auth_yn_bonly            $1
	pbp_b1b_refer_yn_bonly           $1
;

infile '.\pbp\pbp_b1b_inpat_hosp.txt' delimiter = '09'x
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
	pbp_b1b_bendesc_yn
	pbp_b1b_bendesc_ad_nmcs
	pbp_b1b_bendesc_amo_ad
	pbp_b1b_bendesc_lim_ad
	pbp_b1b_bendesc_amt_ad
	pbp_b1b_bendesc_amo_nmcs
	pbp_b1b_maxenr_yn
	pbp_b1b_maxenr_type
	pbp_b1b_maxenr_amt
	pbp_b1b_maxenr_per
	pbp_b1b_maxenr_per_d
	pbp_b1b_cost_vary_tiers_yn
	pbp_b1b_cost_vary_tier_num
	pbp_b1b_cost_vary_low_tier
	pbp_b1b_coins_yn
	pbp_b1b_mc_coins_cstshr_yn_t1
	pbp_b1b_coins_mcs_pct_t1
	pbp_b1b_coins_mcs_int_num_t1
	pbp_b1b_coins_mcs_pct_int1_t1
	pbp_b1b_coins_mcs_bgnd_int1_t1
	pbp_b1b_coins_mcs_endd_int1_t1
	pbp_b1b_coins_mcs_pct_int2_t1
	pbp_b1b_coins_mcs_bgnd_int2_t1
	pbp_b1b_coins_mcs_endd_int2_t1
	pbp_b1b_coins_mcs_pct_int3_t1
	pbp_b1b_coins_mcs_bgnd_int3_t1
	pbp_b1b_coins_mcs_endd_int3_t1
	pbp_b1b_mc_coins_cstshr_yn_t2
	pbp_b1b_coins_mcs_pct_t2
	pbp_b1b_coins_mcs_int_num_t2
	pbp_b1b_coins_mcs_pct_int1_t2
	pbp_b1b_coins_mcs_bgnd_int1_t2
	pbp_b1b_coins_mcs_endd_int1_t2
	pbp_b1b_coins_mcs_pct_int2_t2
	pbp_b1b_coins_mcs_bgnd_int2_t2
	pbp_b1b_coins_mcs_endd_int2_t2
	pbp_b1b_coins_mcs_pct_int3_t2
	pbp_b1b_coins_mcs_bgnd_int3_t2
	pbp_b1b_coins_mcs_endd_int3_t2
	pbp_b1b_mc_coins_cstshr_yn_t3
	pbp_b1b_coins_mcs_pct_t3
	pbp_b1b_coins_mcs_int_num_t3
	pbp_b1b_coins_mcs_pct_int1_t3
	pbp_b1b_coins_mcs_bgnd_int1_t3
	pbp_b1b_coins_mcs_endd_int1_t3
	pbp_b1b_coins_mcs_pct_int2_t3
	pbp_b1b_coins_mcs_bgnd_int2_t3
	pbp_b1b_coins_mcs_endd_int2_t3
	pbp_b1b_coins_mcs_pct_int3_t3
	pbp_b1b_coins_mcs_bgnd_int3_t3
	pbp_b1b_coins_mcs_endd_int3_t3
	pbp_b1b_coins_lrd_int_num_t1
	pbp_b1b_coins_lrd_pct_int1_t1
	pbp_b1b_coins_lrd_bgnd_int1_t1
	pbp_b1b_coins_lrd_endd_int1_t1
	pbp_b1b_coins_lrd_pct_int2_t1
	pbp_b1b_coins_lrd_bgnd_int2_t1
	pbp_b1b_coins_lrd_endd_int2_t1
	pbp_b1b_coins_lrd_pct_int3_t1
	pbp_b1b_coins_lrd_bgnd_int3_t1
	pbp_b1b_coins_lrd_endd_int3_t1
	pbp_b1b_coins_lrd_int_num_t2
	pbp_b1b_coins_lrd_pct_int1_t2
	pbp_b1b_coins_lrd_bgnd_int1_t2
	pbp_b1b_coins_lrd_endd_int1_t2
	pbp_b1b_coins_lrd_pct_int2_t2
	pbp_b1b_coins_lrd_bgnd_int2_t2
	pbp_b1b_coins_lrd_endd_int2_t2
	pbp_b1b_coins_lrd_pct_int3_t2
	pbp_b1b_coins_lrd_bgnd_int3_t2
	pbp_b1b_coins_lrd_endd_int3_t2
	pbp_b1b_coins_lrd_int_num_t3
	pbp_b1b_coins_lrd_pct_int1_t3
	pbp_b1b_coins_lrd_bgnd_int1_t3
	pbp_b1b_coins_lrd_endd_int1_t3
	pbp_b1b_coins_lrd_pct_int2_t3
	pbp_b1b_coins_lrd_bgnd_int2_t3
	pbp_b1b_coins_lrd_endd_int2_t3
	pbp_b1b_coins_lrd_pct_int3_t3
	pbp_b1b_coins_lrd_bgnd_int3_t3
	pbp_b1b_coins_lrd_endd_int3_t3
	pbp_b1b_ad_cost_vary_tiers_yn
	pbp_b1b_ad_cost_vary_tier_num
	pbp_b1b_ad_cost_vary_low_tier
	pbp_b1b_coins_ad_intrvl_num_t1
	pbp_b1b_coins_ad_pct_int1_t1
	pbp_b1b_coins_ad_bgnd_int1_t1
	pbp_b1b_coins_ad_endd_int1_t1
	pbp_b1b_coins_ad_pct_int2_t1
	pbp_b1b_coins_ad_bgnd_int2_t1
	pbp_b1b_coins_ad_endd_int2_t1
	pbp_b1b_coins_ad_pct_int3_t1
	pbp_b1b_coins_ad_bgnd_int3_t1
	pbp_b1b_coins_ad_endd_int3_t1
	pbp_b1b_coins_ad_intrvl_num_t2
	pbp_b1b_coins_ad_pct_int1_t2
	pbp_b1b_coins_ad_bgnd_int1_t2
	pbp_b1b_coins_ad_endd_int1_t2
	pbp_b1b_coins_ad_pct_int2_t2
	pbp_b1b_coins_ad_bgnd_int2_t2
	pbp_b1b_coins_ad_endd_int2_t2
	pbp_b1b_coins_ad_pct_int3_t2
	pbp_b1b_coins_ad_bgnd_int3_t2
	pbp_b1b_coins_ad_endd_int3_t2
	pbp_b1b_coins_ad_intrvl_num_t3
	pbp_b1b_coins_ad_pct_int1_t3
	pbp_b1b_coins_ad_bgnd_int1_t3
	pbp_b1b_coins_ad_endd_int1_t3
	pbp_b1b_coins_ad_pct_int2_t3
	pbp_b1b_coins_ad_bgnd_int2_t3
	pbp_b1b_coins_ad_endd_int2_t3
	pbp_b1b_coins_ad_pct_int3_t3
	pbp_b1b_coins_ad_bgnd_int3_t3
	pbp_b1b_coins_ad_endd_int3_t3
	pbp_b1b_coins_nmcs_struc_yn
	pbp_b1b_coins_pct_nmcs
	pbp_b1b_coins_nmcs_intrvl_num
	pbp_b1b_coins_nmcs_pct_intrvl1
	pbp_b1b_coins_nmcs_bgnd_ntrvl1
	pbp_b1b_coins_nmcs_endd_ntrvl1
	pbp_b1b_coins_nmcs_pct_intrvl2
	pbp_b1b_coins_nmcs_bgnd_ntrvl2
	pbp_b1b_coins_nmcs_endd_ntrvl2
	pbp_b1b_coins_nmcs_pct_intrvl3
	pbp_b1b_coins_nmcs_bgnd_ntrvl3
	pbp_b1b_coins_nmcs_endd_ntrvl3
	pbp_b1b_ded_yn
	pbp_b1b_ded_amt_t1
	pbp_b1b_ded_amt_t2
	pbp_b1b_ded_amt_t3
	pbp_b1b_copay_yn
	pbp_b1b_mc_copay_cstshr_yn_t1
	pbp_b1b_copay_mcs_amt_t1
	pbp_b1b_copay_mcs_int_num_t1
	pbp_b1b_copay_mcs_amt_int1_t1
	pbp_b1b_copay_mcs_bgnd_int1_t1
	pbp_b1b_copay_mcs_endd_int1_t1
	pbp_b1b_copay_mcs_amt_int2_t1
	pbp_b1b_copay_mcs_bgnd_int2_t1
	pbp_b1b_copay_mcs_endd_int2_t1
	pbp_b1b_copay_mcs_amt_int3_t1
	pbp_b1b_copay_mcs_bgnd_int3_t1
	pbp_b1b_copay_mcs_endd_int3_t1
	pbp_b1b_mc_copay_cstshr_yn_t2
	pbp_b1b_copay_mcs_amt_t2
	pbp_b1b_copay_mcs_int_num_t2
	pbp_b1b_copay_mcs_amt_int1_t2
	pbp_b1b_copay_mcs_bgnd_int1_t2
	pbp_b1b_copay_mcs_endd_int1_t2
	pbp_b1b_copay_mcs_amt_int2_t2
	pbp_b1b_copay_mcs_bgnd_int2_t2
	pbp_b1b_copay_mcs_endd_int2_t2
	pbp_b1b_copay_mcs_amt_int3_t2
	pbp_b1b_copay_mcs_bgnd_int3_t2
	pbp_b1b_copay_mcs_endd_int3_t2
	pbp_b1b_mc_copay_cstshr_yn_t3
	pbp_b1b_copay_mcs_amt_t3
	pbp_b1b_copay_mcs_int_num_t3
	pbp_b1b_copay_mcs_amt_int1_t3
	pbp_b1b_copay_mcs_bgnd_int1_t3
	pbp_b1b_copay_mcs_endd_int1_t3
	pbp_b1b_copay_mcs_amt_int2_t3
	pbp_b1b_copay_mcs_bgnd_int2_t3
	pbp_b1b_copay_mcs_endd_int2_t3
	pbp_b1b_copay_mcs_amt_int3_t3
	pbp_b1b_copay_mcs_bgnd_int3_t3
	pbp_b1b_copay_mcs_endd_int3_t3
	pbp_b1b_copay_lrd_int_num_t1
	pbp_b1b_copay_lrd_amt_int1_t1
	pbp_b1b_copay_lrd_bgnd_int1_t1
	pbp_b1b_copay_lrd_endd_int1_t1
	pbp_b1b_copay_lrd_amt_int2_t1
	pbp_b1b_copay_lrd_bgnd_int2_t1
	pbp_b1b_copay_lrd_endd_int2_t1
	pbp_b1b_copay_lrd_amt_int3_t1
	pbp_b1b_copay_lrd_bgnd_int3_t1
	pbp_b1b_copay_lrd_endd_int3_t1
	pbp_b1b_copay_lrd_int_num_t2
	pbp_b1b_copay_lrd_amt_int1_t2
	pbp_b1b_copay_lrd_bgnd_int1_t2
	pbp_b1b_copay_lrd_endd_int1_t2
	pbp_b1b_copay_lrd_amt_int2_t2
	pbp_b1b_copay_lrd_bgnd_int2_t2
	pbp_b1b_copay_lrd_endd_int2_t2
	pbp_b1b_copay_lrd_amt_int3_t2
	pbp_b1b_copay_lrd_bgnd_int3_t2
	pbp_b1b_copay_lrd_endd_int3_t2
	pbp_b1b_copay_lrd_int_num_t3
	pbp_b1b_copay_lrd_amt_int1_t3
	pbp_b1b_copay_lrd_bgnd_int1_t3
	pbp_b1b_copay_lrd_endd_int1_t3
	pbp_b1b_copay_lrd_amt_int2_t3
	pbp_b1b_copay_lrd_bgnd_int2_t3
	pbp_b1b_copay_lrd_endd_int2_t3
	pbp_b1b_copay_lrd_amt_int3_t3
	pbp_b1b_copay_lrd_bgnd_int3_t3
	pbp_b1b_copay_lrd_endd_int3_t3
	pbp_b1b_copay_ad_intrvl_num_t1
	pbp_b1b_copay_ad_amt_int1_t1
	pbp_b1b_copay_ad_bgnd_int1_t1
	pbp_b1b_copay_ad_endd_int1_t1
	pbp_b1b_copay_ad_amt_int2_t1
	pbp_b1b_copay_ad_bgnd_int2_t1
	pbp_b1b_copay_ad_endd_int2_t1
	pbp_b1b_copay_ad_amt_int3_t1
	pbp_b1b_copay_ad_bgnd_int3_t1
	pbp_b1b_copay_ad_endd_int3_t1
	pbp_b1b_copay_ad_intrvl_num_t2
	pbp_b1b_copay_ad_amt_int1_t2
	pbp_b1b_copay_ad_bgnd_int1_t2
	pbp_b1b_copay_ad_endd_int1_t2
	pbp_b1b_copay_ad_amt_int2_t2
	pbp_b1b_copay_ad_bgnd_int2_t2
	pbp_b1b_copay_ad_endd_int2_t2
	pbp_b1b_copay_ad_amt_int3_t2
	pbp_b1b_copay_ad_bgnd_int3_t2
	pbp_b1b_copay_ad_endd_int3_t2
	pbp_b1b_copay_ad_intrvl_num_t3
	pbp_b1b_copay_ad_amt_int1_t3
	pbp_b1b_copay_ad_bgnd_int1_t3
	pbp_b1b_copay_ad_endd_int1_t3
	pbp_b1b_copay_ad_amt_int2_t3
	pbp_b1b_copay_ad_bgnd_int2_t3
	pbp_b1b_copay_ad_endd_int2_t3
	pbp_b1b_copay_ad_amt_int3_t3
	pbp_b1b_copay_ad_bgnd_int3_t3
	pbp_b1b_copay_ad_endd_int3_t3
	pbp_b1b_copay_nmcs_struc_yn
	pbp_b1b_copay_nmcs_amt
	pbp_b1b_copay_nmcs_intrvl_num
	pbp_b1b_copay_nmcs_amt_intrvl1
	pbp_b1b_copay_nmcs_bgnd_ntrvl1
	pbp_b1b_copay_nmcs_endd_ntrvl1
	pbp_b1b_copay_nmcs_amt_intrvl2
	pbp_b1b_copay_nmcs_bgnd_ntrvl2
	pbp_b1b_copay_nmcs_endd_ntrvl2
	pbp_b1b_copay_nmcs_amt_intrvl3
	pbp_b1b_copay_nmcs_bgnd_ntrvl3
	pbp_b1b_copay_nmcs_endd_ntrvl3
	pbp_b1b_hosp_ben_period
	pbp_b1b_hosp_ben_period_oth
	pbp_b1b_cost_discharge_yn
	pbp_b1b_auth_yn
	pbp_b1b_refer_yn
	pbp_b1b_bendesc_yn_bonly
	pbp_b1b_bendesc_amo_bonly
	pbp_b1b_bendesc_lim_bonly
	pbp_b1b_bendesc_amt_bonly
	pbp_b1b_bendesc_per_bonly
	pbp_b1b_bendesc_per_bonly_d
	pbp_b1b_maxplan_yn_bonly
	pbp_b1b_maxplan_type_bonly
	pbp_b1b_maxplan_amt_bonly
	pbp_b1b_maxplan_per_bonly
	pbp_b1b_maxplan_per_bonly_d
	pbp_b1b_maxenr_yn_bonly
	pbp_b1b_maxenr_type_bonly
	pbp_b1b_maxenr_amt_bonly
	pbp_b1b_maxenr_per_bonly
	pbp_b1b_maxenr_per_bonly_d
	pbp_b1b_coins_yn_bonly
	pbp_b1b_coins_pct_bonly
	pbp_b1b_coins_ps_num_bonly
	pbp_b1b_coins_ps_pct1_bonly
	pbp_b1b_coins_ps_bgnd1_bonly
	pbp_b1b_coins_ps_endd1_bonly
	pbp_b1b_coins_ps_pct2_bonly
	pbp_b1b_coins_ps_bgnd2_bonly
	pbp_b1b_coins_ps_endd2_bonly
	pbp_b1b_coins_ps_pct3_bonly
	pbp_b1b_coins_ps_bgnd3_bonly
	pbp_b1b_coins_ps_endd3_bonly
	pbp_b1b_ded_yn_bonly
	pbp_b1b_ded_amt_bonly
	pbp_b1b_copay_yn_bonly
	pbp_b1b_copay_amt_ps_bonly
	pbp_b1b_copay_ps_num_bonly
	pbp_b1b_copay_ps_amt1_bonly
	pbp_b1b_copay_ps_bgnd1_bonly
	pbp_b1b_copay_ps_endd1_bonly
	pbp_b1b_copay_ps_amt2_bonly
	pbp_b1b_copay_ps_bgnd2_bonly
	pbp_b1b_copay_ps_endd2_bonly
	pbp_b1b_copay_ps_amt3_bonly
	pbp_b1b_copay_ps_bgnd3_bonly
	pbp_b1b_copay_ps_endd3_bonly
	pbp_b1b_discharge_yn_bonly
	pbp_b1b_auth_yn_bonly
	pbp_b1b_refer_yn_bonly
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
	pbp_b1b_bendesc_yn               = 'IPH Ben Desc YN'
	pbp_b1b_bendesc_ad_nmcs          = 'IHP (1b) Supp Bens AD/NMCS'
	pbp_b1b_bendesc_amo_ad           = 'IHP AD Ben Desc AMO'
	pbp_b1b_bendesc_lim_ad           = 'IHP AD Ben Desc Lim YN'
	pbp_b1b_bendesc_amt_ad           = 'IHP AD Ben Desc Amt'
	pbp_b1b_bendesc_amo_nmcs         = 'IHP NMCS Ben Desc AMO'
	pbp_b1b_maxenr_yn                = 'IHP Max Enr YN'
	pbp_b1b_maxenr_type              = 'IHP Max Enr Type'
	pbp_b1b_maxenr_amt               = 'IHP Max Enr Amt'
	pbp_b1b_maxenr_per               = 'IHP Max Enr Per'
	pbp_b1b_maxenr_per_d             = 'IHP Max Enr Per Desc'
	pbp_b1b_cost_vary_tiers_yn       = 'IHP Cost Share Tiers Vary YN'
	pbp_b1b_cost_vary_tier_num       = 'IHP Cost Sharing Tiers'
	pbp_b1b_cost_vary_low_tier       = 'IHP Cost Share Tier Low Num'
	pbp_b1b_coins_yn                 = 'IHP Coinsurance YN'
	pbp_b1b_mc_coins_cstshr_yn_t1    = 'IHP Med Def Coins Cost Shrs YN'
	pbp_b1b_coins_mcs_pct_t1         = 'IHP MCS Coins Pct'
	pbp_b1b_coins_mcs_int_num_t1     = 'IHP MCS Coins Interval Num'
	pbp_b1b_coins_mcs_pct_int1_t1    = 'IHP MCS Coins Pct Intrvl 1'
	pbp_b1b_coins_mcs_bgnd_int1_t1   = 'IHP MCS Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_mcs_endd_int1_t1   = 'IHP MCS Coins End Day Intrvl 1'
	pbp_b1b_coins_mcs_pct_int2_t1    = 'IHP MCS Coins Pct Intrvl 2'
	pbp_b1b_coins_mcs_bgnd_int2_t1   = 'IHP MCS Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_mcs_endd_int2_t1   = 'IHP MCS Coins End Day Intrvl 2'
	pbp_b1b_coins_mcs_pct_int3_t1    = 'IHP MCS Coins Pct Intrvl 3'
	pbp_b1b_coins_mcs_bgnd_int3_t1   = 'IHP MCS Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_mcs_endd_int3_t1   = 'IHP MCS Coins End Day Intrvl 3'
	pbp_b1b_mc_coins_cstshr_yn_t2    = 'IHP Med Def Coins Cost Shrs YN'
	pbp_b1b_coins_mcs_pct_t2         = 'IHP MCS Coins Pct'
	pbp_b1b_coins_mcs_int_num_t2     = 'IHP MCS Coins Interval Num'
	pbp_b1b_coins_mcs_pct_int1_t2    = 'IHP MCS Coins Pct Intrvl 1'
	pbp_b1b_coins_mcs_bgnd_int1_t2   = 'IHP MCS Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_mcs_endd_int1_t2   = 'IHP MCS Coins End Day Intrvl 1'
	pbp_b1b_coins_mcs_pct_int2_t2    = 'IHP MCS Coins Pct Intrvl 2'
	pbp_b1b_coins_mcs_bgnd_int2_t2   = 'IHP MCS Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_mcs_endd_int2_t2   = 'IHP MCS Coins End Day Intrvl 2'
	pbp_b1b_coins_mcs_pct_int3_t2    = 'IHP MCS Coins Pct Intrvl 3'
	pbp_b1b_coins_mcs_bgnd_int3_t2   = 'IHP MCS Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_mcs_endd_int3_t2   = 'IHP MCS Coins End Day Intrvl 3'
	pbp_b1b_mc_coins_cstshr_yn_t3    = 'IHP Med Def Coins Cost Shrs YN'
	pbp_b1b_coins_mcs_pct_t3         = 'IHP MCS Coins Pct'
	pbp_b1b_coins_mcs_int_num_t3     = 'IHP MCS Coins Interval Num'
	pbp_b1b_coins_mcs_pct_int1_t3    = 'IHP MCS Coins Pct Intrvl 1'
	pbp_b1b_coins_mcs_bgnd_int1_t3   = 'IHP MCS Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_mcs_endd_int1_t3   = 'IHP MCS Coins End Day Intrvl 1'
	pbp_b1b_coins_mcs_pct_int2_t3    = 'IHP MCS Coins Pct Intrvl 2'
	pbp_b1b_coins_mcs_bgnd_int2_t3   = 'IHP MCS Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_mcs_endd_int2_t3   = 'IHP MCS Coins End Day Intrvl 2'
	pbp_b1b_coins_mcs_pct_int3_t3    = 'IHP MCS Coins Pct Intrvl 3'
	pbp_b1b_coins_mcs_bgnd_int3_t3   = 'IHP MCS Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_mcs_endd_int3_t3   = 'IHP MCS Coins End Day Intrvl 3'
	pbp_b1b_coins_lrd_int_num_t1     = 'IHP LRD Coins Interval Num'
	pbp_b1b_coins_lrd_pct_int1_t1    = 'IHP LRD Coins Pct Intrvl 1'
	pbp_b1b_coins_lrd_bgnd_int1_t1   = 'IHP LRD Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_lrd_endd_int1_t1   = 'IHP LRD Coins End Day Intrvl 1'
	pbp_b1b_coins_lrd_pct_int2_t1    = 'IHP LRD Coins Pct Intrvl 2'
	pbp_b1b_coins_lrd_bgnd_int2_t1   = 'IHP LRD Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_lrd_endd_int2_t1   = 'IHP LRD Coins End Day Intrvl 2'
	pbp_b1b_coins_lrd_pct_int3_t1    = 'IHP LRD Coins Pct Intrvl 3'
	pbp_b1b_coins_lrd_bgnd_int3_t1   = 'IHP LRD Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_lrd_endd_int3_t1   = 'IHP LRD Coins End Day Intrvl 3'
	pbp_b1b_coins_lrd_int_num_t2     = 'IHP LRD Coins Interval Num'
	pbp_b1b_coins_lrd_pct_int1_t2    = 'IHP LRD Coins Pct Intrvl 1'
	pbp_b1b_coins_lrd_bgnd_int1_t2   = 'IHP LRD Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_lrd_endd_int1_t2   = 'IHP LRD Coins End Day Intrvl 1'
	pbp_b1b_coins_lrd_pct_int2_t2    = 'IHP LRD Coins Pct Intrvl 2'
	pbp_b1b_coins_lrd_bgnd_int2_t2   = 'IHP LRD Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_lrd_endd_int2_t2   = 'IHP LRD Coins End Day Intrvl 2'
	pbp_b1b_coins_lrd_pct_int3_t2    = 'IHP LRD Coins Pct Intrvl 3'
	pbp_b1b_coins_lrd_bgnd_int3_t2   = 'IHP LRD Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_lrd_endd_int3_t2   = 'IHP LRD Coins End Day Intrvl 3'
	pbp_b1b_coins_lrd_int_num_t3     = 'IHP LRD Coins Interval Num'
	pbp_b1b_coins_lrd_pct_int1_t3    = 'IHP LRD Coins Pct Intrvl 1'
	pbp_b1b_coins_lrd_bgnd_int1_t3   = 'IHP LRD Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_lrd_endd_int1_t3   = 'IHP LRD Coins End Day Intrvl 1'
	pbp_b1b_coins_lrd_pct_int2_t3    = 'IHP LRD Coins Pct Intrvl 2'
	pbp_b1b_coins_lrd_bgnd_int2_t3   = 'IHP LRD Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_lrd_endd_int2_t3   = 'IHP LRD Coins End Day Intrvl 2'
	pbp_b1b_coins_lrd_pct_int3_t3    = 'IHP LRD Coins Pct Intrvl 3'
	pbp_b1b_coins_lrd_bgnd_int3_t3   = 'IHP LRD Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_lrd_endd_int3_t3   = 'IHP LRD Coins End Day Intrvl 3'
	pbp_b1b_ad_cost_vary_tiers_yn    = 'IHP AD Cost Tiers Vary YN'
	pbp_b1b_ad_cost_vary_tier_num    = 'IHP AD Cost Sharing Tiers'
	pbp_b1b_ad_cost_vary_low_tier    = 'IHP AD Lowest Cost Tier'
	pbp_b1b_coins_ad_intrvl_num_t1   = 'IPH AD Coins Interval Num'
	pbp_b1b_coins_ad_pct_int1_t1     = 'IPH AD Coins Pct Intrvl 1'
	pbp_b1b_coins_ad_bgnd_int1_t1    = 'IPH AD Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_ad_endd_int1_t1    = 'IPH AD Coins End Day Intrvl 1'
	pbp_b1b_coins_ad_pct_int2_t1     = 'IPH AD Coins Pct Intrvl 2'
	pbp_b1b_coins_ad_bgnd_int2_t1    = 'IPH AD Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_ad_endd_int2_t1    = 'IPH AD Coins End Day Intrvl 2'
	pbp_b1b_coins_ad_pct_int3_t1     = 'IPH AD Coins Pct Intrvl 3'
	pbp_b1b_coins_ad_bgnd_int3_t1    = 'IPH AD Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_ad_endd_int3_t1    = 'IPH AD Coins End Day Intrvl 3'
	pbp_b1b_coins_ad_intrvl_num_t2   = 'IPH AD Coins Interval Num'
	pbp_b1b_coins_ad_pct_int1_t2     = 'IPH AD Coins Pct Intrvl 1'
	pbp_b1b_coins_ad_bgnd_int1_t2    = 'IPH AD Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_ad_endd_int1_t2    = 'IPH AD Coins End Day Intrvl 1'
	pbp_b1b_coins_ad_pct_int2_t2     = 'IPH AD Coins Pct Intrvl 2'
	pbp_b1b_coins_ad_bgnd_int2_t2    = 'IPH AD Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_ad_endd_int2_t2    = 'IPH AD Coins End Day Intrvl 2'
	pbp_b1b_coins_ad_pct_int3_t2     = 'IPH AD Coins Pct Intrvl 3'
	pbp_b1b_coins_ad_bgnd_int3_t2    = 'IPH AD Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_ad_endd_int3_t2    = 'IPH AD Coins End Day Intrvl 3'
	pbp_b1b_coins_ad_intrvl_num_t3   = 'IPH AD Coins Interval Num'
	pbp_b1b_coins_ad_pct_int1_t3     = 'IPH AD Coins Pct Intrvl 1'
	pbp_b1b_coins_ad_bgnd_int1_t3    = 'IPH AD Coins Bgn Day Intrvl 1'
	pbp_b1b_coins_ad_endd_int1_t3    = 'IPH AD Coins End Day Intrvl 1'
	pbp_b1b_coins_ad_pct_int2_t3     = 'IPH AD Coins Pct Intrvl 2'
	pbp_b1b_coins_ad_bgnd_int2_t3    = 'IPH AD Coins Bgn Day Intrvl 2'
	pbp_b1b_coins_ad_endd_int2_t3    = 'IPH AD Coins End Day Intrvl 2'
	pbp_b1b_coins_ad_pct_int3_t3     = 'IPH AD Coins Pct Intrvl 3'
	pbp_b1b_coins_ad_bgnd_int3_t3    = 'IPH AD Coins Bgn Day Intrvl 3'
	pbp_b1b_coins_ad_endd_int3_t3    = 'IPH AD Coins End Day Intrvl 3'
	pbp_b1b_coins_nmcs_struc_yn      = 'IPH NMCS Coins Structure YN'
	pbp_b1b_coins_pct_nmcs           = 'IPH NMCS Coins Pct'
	pbp_b1b_coins_nmcs_intrvl_num    = 'IPH NMCS Coins Interval Num'
	pbp_b1b_coins_nmcs_pct_intrvl1   = 'IPH NMCS Coins Pct Intrvl 1'
	pbp_b1b_coins_nmcs_bgnd_ntrvl1   = 'IPH NMCS Coins BgnDay Intrvl 1'
	pbp_b1b_coins_nmcs_endd_ntrvl1   = 'IPH NMCS Coins EndDay Intrvl 1'
	pbp_b1b_coins_nmcs_pct_intrvl2   = 'IPH NMCS Coins Pct Intrvl 2'
	pbp_b1b_coins_nmcs_bgnd_ntrvl2   = 'IPH NMCS Coins BgnDay Intrvl 2'
	pbp_b1b_coins_nmcs_endd_ntrvl2   = 'IPH NMCS Coins EndDay Intrvl 2'
	pbp_b1b_coins_nmcs_pct_intrvl3   = 'IPH NMCS Coins Pct Intrvl 3'
	pbp_b1b_coins_nmcs_bgnd_ntrvl3   = 'IPH NMCS Coins BgnDay Intrvl 3'
	pbp_b1b_coins_nmcs_endd_ntrvl3   = 'IPH NMCS Coins EndDay Intrvl 3'
	pbp_b1b_ded_yn                   = 'IPH Deductible YN'
	pbp_b1b_ded_amt_t1               = 'IHP Deductible Amt'
	pbp_b1b_ded_amt_t2               = 'IHP Deductible Amt Tier 2'
	pbp_b1b_ded_amt_t3               = 'IHP Deductible Amt Tier 3'
	pbp_b1b_copay_yn                 = 'IPH Copayment YN'
	pbp_b1b_mc_copay_cstshr_yn_t1    = 'IHP MCS Def Copay Cost Shrs YN'
	pbp_b1b_copay_mcs_amt_t1         = 'IHP MCS Copay Amt'
	pbp_b1b_copay_mcs_int_num_t1     = 'IHP MCS Copay Interval Num'
	pbp_b1b_copay_mcs_amt_int1_t1    = 'IHP MCS Copay Amt Interval 1'
	pbp_b1b_copay_mcs_bgnd_int1_t1   = 'IHP MCS Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_mcs_endd_int1_t1   = 'IHP MCS Copay End Day Intrvl 1'
	pbp_b1b_copay_mcs_amt_int2_t1    = 'IHP MCS Copay Amt Interval 2'
	pbp_b1b_copay_mcs_bgnd_int2_t1   = 'IHP MCS Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_mcs_endd_int2_t1   = 'IHP MCS Copay End Day Intrvl 2'
	pbp_b1b_copay_mcs_amt_int3_t1    = 'IHP MCS Copay Amt Interval 3'
	pbp_b1b_copay_mcs_bgnd_int3_t1   = 'IHP MCS Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_mcs_endd_int3_t1   = 'IHP MCS Copay End Day Intrvl 3'
	pbp_b1b_mc_copay_cstshr_yn_t2    = 'IHP MCS Def Copay Cost Shrs YN'
	pbp_b1b_copay_mcs_amt_t2         = 'IHP MCS Copay Amt'
	pbp_b1b_copay_mcs_int_num_t2     = 'IHP MCS Copay Interval Num'
	pbp_b1b_copay_mcs_amt_int1_t2    = 'IHP MCS Copay Amt Interval 1'
	pbp_b1b_copay_mcs_bgnd_int1_t2   = 'IHP MCS Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_mcs_endd_int1_t2   = 'IHP MCS Copay End Day Intrvl 1'
	pbp_b1b_copay_mcs_amt_int2_t2    = 'IHP MCS Copay Amt Interval 2'
	pbp_b1b_copay_mcs_bgnd_int2_t2   = 'IHP MCS Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_mcs_endd_int2_t2   = 'IHP MCS Copay End Day Intrvl 2'
	pbp_b1b_copay_mcs_amt_int3_t2    = 'IHP MCS Copay Amt Interval 3'
	pbp_b1b_copay_mcs_bgnd_int3_t2   = 'IHP MCS Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_mcs_endd_int3_t2   = 'IHP MCS Copay End Day Intrvl 3'
	pbp_b1b_mc_copay_cstshr_yn_t3    = 'IHP MCS Def Copay Cost Shrs YN'
	pbp_b1b_copay_mcs_amt_t3         = 'IHP MCS Copay Amt'
	pbp_b1b_copay_mcs_int_num_t3     = 'IHP MCS Copay Interval Num'
	pbp_b1b_copay_mcs_amt_int1_t3    = 'IHP MCS Copay Amt Interval 1'
	pbp_b1b_copay_mcs_bgnd_int1_t3   = 'IHP MCS Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_mcs_endd_int1_t3   = 'IHP MCS Copay End Day Intrvl 1'
	pbp_b1b_copay_mcs_amt_int2_t3    = 'IHP MCS Copay Amt Interval 2'
	pbp_b1b_copay_mcs_bgnd_int2_t3   = 'IHP MCS Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_mcs_endd_int2_t3   = 'IHP MCS Copay End Day Intrvl 2'
	pbp_b1b_copay_mcs_amt_int3_t3    = 'IHP MCS Copay Amt Interval 3'
	pbp_b1b_copay_mcs_bgnd_int3_t3   = 'IHP MCS Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_mcs_endd_int3_t3   = 'IHP MCS Copay End Day Intrvl 3'
	pbp_b1b_copay_lrd_int_num_t1     = 'IHP LRD Copay Interval Num'
	pbp_b1b_copay_lrd_amt_int1_t1    = 'IHP LRD Copay Amt Interval 1'
	pbp_b1b_copay_lrd_bgnd_int1_t1   = 'IHP LRD Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_lrd_endd_int1_t1   = 'IHP LRD Copay End Day Intrvl 1'
	pbp_b1b_copay_lrd_amt_int2_t1    = 'IHP LRD Copay Amt Interval 2'
	pbp_b1b_copay_lrd_bgnd_int2_t1   = 'IHP LRD Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_lrd_endd_int2_t1   = 'IHP LRD Copay End Day Intrvl 2'
	pbp_b1b_copay_lrd_amt_int3_t1    = 'IHP LRD Copay Amt Interval 3'
	pbp_b1b_copay_lrd_bgnd_int3_t1   = 'IHP LRD Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_lrd_endd_int3_t1   = 'IHP LRD Copay End Day Intrvl 3'
	pbp_b1b_copay_lrd_int_num_t2     = 'IHP LRD Copay Interval Num'
	pbp_b1b_copay_lrd_amt_int1_t2    = 'IHP LRD Copay Amt Interval 1'
	pbp_b1b_copay_lrd_bgnd_int1_t2   = 'IHP LRD Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_lrd_endd_int1_t2   = 'IHP LRD Copay End Day Intrvl 1'
	pbp_b1b_copay_lrd_amt_int2_t2    = 'IHP LRD Copay Amt Interval 2'
	pbp_b1b_copay_lrd_bgnd_int2_t2   = 'IHP LRD Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_lrd_endd_int2_t2   = 'IHP LRD Copay End Day Intrvl 2'
	pbp_b1b_copay_lrd_amt_int3_t2    = 'IHP LRD Copay Amt Interval 3'
	pbp_b1b_copay_lrd_bgnd_int3_t2   = 'IHP LRD Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_lrd_endd_int3_t2   = 'IHP LRD Copay End Day Intrvl 3'
	pbp_b1b_copay_lrd_int_num_t3     = 'IHP LRD Copay Interval Num'
	pbp_b1b_copay_lrd_amt_int1_t3    = 'IHP LRD Copay Amt Interval 1'
	pbp_b1b_copay_lrd_bgnd_int1_t3   = 'IHP LRD Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_lrd_endd_int1_t3   = 'IHP LRD Copay End Day Intrvl 1'
	pbp_b1b_copay_lrd_amt_int2_t3    = 'IHP LRD Copay Amt Interval 2'
	pbp_b1b_copay_lrd_bgnd_int2_t3   = 'IHP LRD Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_lrd_endd_int2_t3   = 'IHP LRD Copay End Day Intrvl 2'
	pbp_b1b_copay_lrd_amt_int3_t3    = 'IHP LRD Copay Amt Interval 3'
	pbp_b1b_copay_lrd_bgnd_int3_t3   = 'IHP LRD Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_lrd_endd_int3_t3   = 'IHP LRD Copay End Day Intrvl 3'
	pbp_b1b_copay_ad_intrvl_num_t1   = 'IPH AD Copay Interval Num'
	pbp_b1b_copay_ad_amt_int1_t1     = 'IPH AD Copay Amt Interval 1'
	pbp_b1b_copay_ad_bgnd_int1_t1    = 'IPH AD Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_ad_endd_int1_t1    = 'IPH AD Copay End Day Intrvl 1'
	pbp_b1b_copay_ad_amt_int2_t1     = 'IPH AD Copay Amt Interval 2'
	pbp_b1b_copay_ad_bgnd_int2_t1    = 'IPH AD Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_ad_endd_int2_t1    = 'IPH AD Copay End Day Intrvl 2'
	pbp_b1b_copay_ad_amt_int3_t1     = 'IPH AD Copay Amt Interval 3'
	pbp_b1b_copay_ad_bgnd_int3_t1    = 'IPH AD Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_ad_endd_int3_t1    = 'IPH AD Copay End Day Intrvl 3'
	pbp_b1b_copay_ad_intrvl_num_t2   = 'IPH AD Copay Interval Num'
	pbp_b1b_copay_ad_amt_int1_t2     = 'IPH AD Copay Amt Interval 1'
	pbp_b1b_copay_ad_bgnd_int1_t2    = 'IPH AD Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_ad_endd_int1_t2    = 'IPH AD Copay End Day Intrvl 1'
	pbp_b1b_copay_ad_amt_int2_t2     = 'IPH AD Copay Amt Interval 2'
	pbp_b1b_copay_ad_bgnd_int2_t2    = 'IPH AD Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_ad_endd_int2_t2    = 'IPH AD Copay End Day Intrvl 2'
	pbp_b1b_copay_ad_amt_int3_t2     = 'IPH AD Copay Amt Interval 3'
	pbp_b1b_copay_ad_bgnd_int3_t2    = 'IPH AD Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_ad_endd_int3_t2    = 'IPH AD Copay End Day Intrvl 3'
	pbp_b1b_copay_ad_intrvl_num_t3   = 'IPH AD Copay Interval Num'
	pbp_b1b_copay_ad_amt_int1_t3     = 'IPH AD Copay Amt Interval 1'
	pbp_b1b_copay_ad_bgnd_int1_t3    = 'IPH AD Copay Bgn Day Intrvl 1'
	pbp_b1b_copay_ad_endd_int1_t3    = 'IPH AD Copay End Day Intrvl 1'
	pbp_b1b_copay_ad_amt_int2_t3     = 'IPH AD Copay Amt Interval 2'
	pbp_b1b_copay_ad_bgnd_int2_t3    = 'IPH AD Copay Bgn Day Intrvl 2'
	pbp_b1b_copay_ad_endd_int2_t3    = 'IPH AD Copay End Day Intrvl 2'
	pbp_b1b_copay_ad_amt_int3_t3     = 'IPH AD Copay Amt Interval 3'
	pbp_b1b_copay_ad_bgnd_int3_t3    = 'IPH AD Copay Bgn Day Intrvl 3'
	pbp_b1b_copay_ad_endd_int3_t3    = 'IPH AD Copay End Day Intrvl 3'
	pbp_b1b_copay_nmcs_struc_yn      = 'IPH NMCS Copay Structure YN'
	pbp_b1b_copay_nmcs_amt           = 'IPH NMCS Copay Amt'
	pbp_b1b_copay_nmcs_intrvl_num    = 'IPH NMCS Copay Interval Num'
	pbp_b1b_copay_nmcs_amt_intrvl1   = 'IPH NMCS Copay Amt Interval 1'
	pbp_b1b_copay_nmcs_bgnd_ntrvl1   = 'IPH NMCS Copay BgnDay Intrvl 1'
	pbp_b1b_copay_nmcs_endd_ntrvl1   = 'IPH NMCS Copay EndDay Intrvl 1'
	pbp_b1b_copay_nmcs_amt_intrvl2   = 'IPH NMCS Copay Amt Interval 2'
	pbp_b1b_copay_nmcs_bgnd_ntrvl2   = 'IPH NMCS Copay BgnDay Intrvl 2'
	pbp_b1b_copay_nmcs_endd_ntrvl2   = 'IPH NMCS Copay EndDay Intrvl 2'
	pbp_b1b_copay_nmcs_amt_intrvl3   = 'IPH NMCS Copay Amt Interval 3'
	pbp_b1b_copay_nmcs_bgnd_ntrvl3   = 'IPH NMCS Copay BgnDay Intrvl 3'
	pbp_b1b_copay_nmcs_endd_ntrvl3   = 'IPH NMCS Copay EndDay Intrvl 3'
	pbp_b1b_hosp_ben_period          = 'IPH Hospital Ben Period'
	pbp_b1b_hosp_ben_period_oth      = 'IPH Hospital Ben Period Other'
	pbp_b1b_cost_discharge_yn        = 'IHP Costsharing discharge YN'
	pbp_b1b_auth_yn                  = 'IPH Enrollee Auth'
	pbp_b1b_refer_yn                 = 'IPH Referral YN'
	pbp_b1b_bendesc_yn_bonly         = 'IPH(B) Ben Desc YN'
	pbp_b1b_bendesc_amo_bonly        = 'IPH(B) Ben Desc AMO'
	pbp_b1b_bendesc_lim_bonly        = 'IPH(B) Ben Desc Lim YN'
	pbp_b1b_bendesc_amt_bonly        = 'IPH(B) Ben Desc Amt'
	pbp_b1b_bendesc_per_bonly        = 'IPH(B) Ben Desc Per'
	pbp_b1b_bendesc_per_bonly_d      = 'IPH(B) Ben Desc Per Desc'
	pbp_b1b_maxplan_yn_bonly         = 'IPH(B) Max Plan YN'
	pbp_b1b_maxplan_type_bonly       = 'IPH(B) Max Plan Type'
	pbp_b1b_maxplan_amt_bonly        = 'IPH(B) Max Plan Amt'
	pbp_b1b_maxplan_per_bonly        = 'IPH(B) Max Plan Per'
	pbp_b1b_maxplan_per_bonly_d      = 'IPH(B) Max Plan Per Desc'
	pbp_b1b_maxenr_yn_bonly          = 'IPH(B) Max Enr YN'
	pbp_b1b_maxenr_type_bonly        = 'IPH(B) Max Enr Type'
	pbp_b1b_maxenr_amt_bonly         = 'IPH(B) Max Enr Amt'
	pbp_b1b_maxenr_per_bonly         = 'IPH(B) Max Enr Per'
	pbp_b1b_maxenr_per_bonly_d       = 'IPH(B) Max Enr Per Desc'
	pbp_b1b_coins_yn_bonly           = 'IPH(B) Coinsurance YN'
	pbp_b1b_coins_pct_bonly          = 'IPH(B) PS Coins Pct'
	pbp_b1b_coins_ps_num_bonly       = 'IPH(B) PS Coins Interval Num'
	pbp_b1b_coins_ps_pct1_bonly      = 'IPH(B) PS Coins Pct Intrvl 1'
	pbp_b1b_coins_ps_bgnd1_bonly     = 'IPH(B) PS Coin Bgn Day Intrv 1'
	pbp_b1b_coins_ps_endd1_bonly     = 'IPH(B) PS Coin End Day Intrv 1'
	pbp_b1b_coins_ps_pct2_bonly      = 'IPH(B) PS Coins Pct Intrvl 2'
	pbp_b1b_coins_ps_bgnd2_bonly     = 'IPH(B) PS Coin Bgn Day Intrv 2'
	pbp_b1b_coins_ps_endd2_bonly     = 'IPH(B) PS Coin End Day Intrv 2'
	pbp_b1b_coins_ps_pct3_bonly      = 'IPH(B) PS Coins Pct Intrvl 3'
	pbp_b1b_coins_ps_bgnd3_bonly     = 'IPH(B) PS Coin Bgn Day Intrv 3'
	pbp_b1b_coins_ps_endd3_bonly     = 'IPH(B) PS Coin End Day Intrv 3'
	pbp_b1b_ded_yn_bonly             = 'IPH(B) Deductible YN'
	pbp_b1b_ded_amt_bonly            = 'IPH(B) Deductible Amt'
	pbp_b1b_copay_yn_bonly           = 'IPH(B) Copayment YN'
	pbp_b1b_copay_amt_ps_bonly       = 'IPH(B) PS Copay Amt'
	pbp_b1b_copay_ps_num_bonly       = 'IPH(B) PS Copay Interval Num'
	pbp_b1b_copay_ps_amt1_bonly      = 'IPH(B) PS Copay Amt Interval 1'
	pbp_b1b_copay_ps_bgnd1_bonly     = 'IPH(B) PS Cpay Bgn Day Intrv 1'
	pbp_b1b_copay_ps_endd1_bonly     = 'IPH(B) PS Cpay End Day Intrv 1'
	pbp_b1b_copay_ps_amt2_bonly      = 'IPH(B) PS Copay Amt Interval 2'
	pbp_b1b_copay_ps_bgnd2_bonly     = 'IPH(B) PS Cpay Bgn Day Intrv 2'
	pbp_b1b_copay_ps_endd2_bonly     = 'IPH(B) PS Cpay End Day Intrv 2'
	pbp_b1b_copay_ps_amt3_bonly      = 'IPH(B) PS Copay Amt Interval 3'
	pbp_b1b_copay_ps_bgnd3_bonly     = 'IPH(B) PS Cpay Bgn Day Intrv 3'
	pbp_b1b_copay_ps_endd3_bonly     = 'IPH(B) PS Cpay End Day Intrv 3'
	pbp_b1b_discharge_yn_bonly       = 'IPH(B)Cost On Discharge YN'
	pbp_b1b_auth_yn_bonly            = 'IPH(B) Enrollee Auth'
	pbp_b1b_refer_yn_bonly           = 'IPH(B) Referral YN'
;

run;

proc sort data = pbp_b1b out=out.pbp_b1b;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b1b(obs = 10);
  title 'pbp_b1b_inpat_hosp file ';
run;

proc means data = out.pbp_b1b;
  title 'pbp_b1b_inpat_hosp file ';
run;

proc freq data = out.pbp_b1b;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b1b_bendesc_yn
	pbp_b1b_bendesc_ad_nmcs
	pbp_b1b_bendesc_amo_ad
	pbp_b1b_bendesc_lim_ad
	pbp_b1b_bendesc_amo_nmcs
	pbp_b1b_maxenr_yn
	pbp_b1b_maxenr_type
	pbp_b1b_maxenr_per
	pbp_b1b_cost_vary_tiers_yn
	pbp_b1b_cost_vary_tier_num
	pbp_b1b_cost_vary_low_tier
	pbp_b1b_coins_yn
	pbp_b1b_mc_coins_cstshr_yn_t1
	pbp_b1b_coins_mcs_int_num_t1
	pbp_b1b_mc_coins_cstshr_yn_t2
	pbp_b1b_coins_mcs_int_num_t2
	pbp_b1b_mc_coins_cstshr_yn_t3
	pbp_b1b_coins_mcs_int_num_t3
	pbp_b1b_coins_lrd_int_num_t1
	pbp_b1b_coins_lrd_int_num_t2
	pbp_b1b_coins_lrd_int_num_t3
	pbp_b1b_ad_cost_vary_tiers_yn
	pbp_b1b_ad_cost_vary_tier_num
	pbp_b1b_ad_cost_vary_low_tier
	pbp_b1b_coins_ad_intrvl_num_t1
	pbp_b1b_coins_ad_intrvl_num_t2
	pbp_b1b_coins_ad_intrvl_num_t3
	pbp_b1b_coins_nmcs_struc_yn
	pbp_b1b_coins_nmcs_intrvl_num
	pbp_b1b_ded_yn
	pbp_b1b_copay_yn
	pbp_b1b_mc_copay_cstshr_yn_t1
	pbp_b1b_copay_mcs_int_num_t1
	pbp_b1b_mc_copay_cstshr_yn_t2
	pbp_b1b_copay_mcs_int_num_t2
	pbp_b1b_mc_copay_cstshr_yn_t3
	pbp_b1b_copay_mcs_int_num_t3
	pbp_b1b_copay_lrd_int_num_t1
	pbp_b1b_copay_lrd_int_num_t2
	pbp_b1b_copay_lrd_int_num_t3
	pbp_b1b_copay_ad_intrvl_num_t1
	pbp_b1b_copay_ad_intrvl_num_t2
	pbp_b1b_copay_ad_intrvl_num_t3
	pbp_b1b_copay_nmcs_struc_yn
	pbp_b1b_copay_nmcs_intrvl_num
	pbp_b1b_hosp_ben_period
	pbp_b1b_cost_discharge_yn
	pbp_b1b_auth_yn
	pbp_b1b_refer_yn
	pbp_b1b_bendesc_yn_bonly
	pbp_b1b_bendesc_amo_bonly
	pbp_b1b_bendesc_lim_bonly
	pbp_b1b_bendesc_per_bonly
	pbp_b1b_maxplan_yn_bonly
	pbp_b1b_maxplan_type_bonly
	pbp_b1b_maxplan_per_bonly
	pbp_b1b_maxenr_yn_bonly
	pbp_b1b_maxenr_type_bonly
	pbp_b1b_maxenr_per_bonly
	pbp_b1b_coins_yn_bonly
	pbp_b1b_coins_ps_num_bonly
	pbp_b1b_ded_yn_bonly
	pbp_b1b_copay_yn_bonly
	pbp_b1b_copay_ps_num_bonly
	pbp_b1b_discharge_yn_bonly
	pbp_b1b_auth_yn_bonly
	pbp_b1b_refer_yn_bonly
/ missing;
run;

proc contents data = out.pbp_b1b;
  title 'pbp_b1b data';
run;