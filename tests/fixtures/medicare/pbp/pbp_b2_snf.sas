*pbp_b2_snf.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b2;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b2_bendesc_yn                $1
	pbp_b2_bendesc_ad_nmcs           $2
	pbp_b2_bendesc_amo_ad            $1
	pbp_b2_benedesc_lim_ad           $1
	pbp_b2_bendesc_pr_hosp_yn        $1
	pbp_b2_bendesc_pr_hosp_num       $1
	pbp_b2_maxenr_yn                 $1
	pbp_b2_maxenr_per                $1
	pbp_b2_maxenr_per_d              $4000
	pbp_b2_cost_vary_tiers_yn        $1
	pbp_b2_cost_vary_tier_num        $1
	pbp_b2_cost_vary_low_tier        $1
	pbp_b2_coins_yn                  $1
	pbp_b2_mc_coins_cstshr_yn_t1     $1
	pbp_b2_coins_mcs_int_num_t1      $1
	pbp_b2_mc_coins_cstshr_yn_t2     $1
	pbp_b2_coins_mcs_int_num_t2      $1
	pbp_b2_mc_coins_cstshr_yn_t3     $1
	pbp_b2_coins_mcs_int_num_t3      $1
	pbp_b2_ad_cost_vary_tiers_yn     $1
	pbp_b2_ad_cost_vary_tier_num     $1
	pbp_b2_ad_cost_vary_low_tier     $1
	pbp_b2_coins_ad_intrvl_num_t1    $1
	pbp_b2_coins_ad_intrvl_num_t2    $1
	pbp_b2_coins_ad_intrvl_num_t3    $1
	pbp_b2_ded_yn                    $1
	pbp_b2_copay_yn                  $1
	pbp_b2_mc_copay_cstshr_yn_t1     $1
	pbp_b2_copay_mcs_int_num_t1      $1
	pbp_b2_mc_copay_cstshr_yn_t2     $1
	pbp_b2_copay_mcs_int_num_t2      $1
	pbp_b2_mc_copay_cstshr_yn_t3     $1
	pbp_b2_copay_mcs_int_num_t3      $1
	pbp_b2_copay_ad_intrvl_num_t1    $1
	pbp_b2_copay_ad_intrvl_num_t2    $1
	pbp_b2_copay_ad_intrvl_num_t3    $1
	pbp_b2_hosp_ben_period           $1
	pbp_b2_hosp_ben_period_oth       $4000
	pbp_b2_cost_discharge_yn         $1
	pbp_b2_auth_yn                   $1
	pbp_b2_refer_yn                  $1
	pbp_b2_bendesc_yn_bonly          $1
	pbp_b2_bendesc_amo_bonly         $1
	pbp_b2_bendesc_snf_unlm_bonly    $1
	pbp_b2_bendesc_snf_per_bonly     $1
	pbp_b2_bendesc_snf_per_bonly_d   $4000
	pbp_b2_bendesc_hostay_bonly_yn   $1
	pbp_b2_bende_nmday_prior_bonly   $1
	pbp_b2_maxplan_yn_bonly          $1
	pbp_b2_maxplan_per_bonly         $1
	pbp_b2_maxplan_per_bonly_d       $4000
	pbp_b2_maxenr_yn_bonly           $1
	pbp_b2_maxenr_per_bonly          $1
	pbp_b2_maxenr_per_bonly_d        $4000
	pbp_b2_coins_yn_bonly            $1
	pbp_b2_coins_ps_num_bonly        $1
	pbp_b2_ded_yn_bonly              $1
	pbp_b2_copay_yn_bonly            $1
	pbp_b2_copay_ps_num_bonly        $1
	pbp_b2_auth_yn_bonly             $1
	pbp_b2_refer_yn_bonly            $1
;

infile '.\pbp\pbp_b2_snf.txt' delimiter = '09'x
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
	pbp_b2_bendesc_yn
	pbp_b2_bendesc_ad_nmcs
	pbp_b2_bendesc_amo_ad
	pbp_b2_benedesc_lim_ad
	pbp_b2_bendesc_ad
	pbp_b2_bendesc_pr_hosp_yn
	pbp_b2_bendesc_pr_hosp_num
	pbp_b2_maxenr_yn
	pbp_b2_maxenr_amt
	pbp_b2_maxenr_per
	pbp_b2_maxenr_per_d
	pbp_b2_cost_vary_tiers_yn
	pbp_b2_cost_vary_tier_num
	pbp_b2_cost_vary_low_tier
	pbp_b2_coins_yn
	pbp_b2_mc_coins_cstshr_yn_t1
	pbp_b2_coins_mcs_int_num_t1
	pbp_b2_coins_mcs_pct_int1_t1
	pbp_b2_coins_mcs_bgnd_int1_t1
	pbp_b2_coins_mcs_endd_int1_t1
	pbp_b2_coins_mcs_pct_int2_t1
	pbp_b2_coins_mcs_bgnd_int2_t1
	pbp_b2_coins_mcs_endd_int2_t1
	pbp_b2_coins_mcs_pct_int3_t1
	pbp_b2_coins_mcs_bgnd_int3_t1
	pbp_b2_coins_mcs_endd_int3_t1
	pbp_b2_mc_coins_cstshr_yn_t2
	pbp_b2_coins_mcs_int_num_t2
	pbp_b2_coins_mcs_pct_int1_t2
	pbp_b2_coins_mcs_bgnd_int1_t2
	pbp_b2_coins_mcs_endd_int1_t2
	pbp_b2_coins_mcs_pct_int2_t2
	pbp_b2_coins_mcs_bgnd_int2_t2
	pbp_b2_coins_mcs_endd_int2_t2
	pbp_b2_coins_mcs_pct_int3_t2
	pbp_b2_coins_mcs_bgnd_int3_t2
	pbp_b2_coins_mcs_endd_int3_t2
	pbp_b2_mc_coins_cstshr_yn_t3
	pbp_b2_coins_mcs_int_num_t3
	pbp_b2_coins_mcs_pct_int1_t3
	pbp_b2_coins_mcs_bgnd_int1_t3
	pbp_b2_coins_mcs_endd_int1_t3
	pbp_b2_coins_mcs_pct_int2_t3
	pbp_b2_coins_mcs_bgnd_int2_t3
	pbp_b2_coins_mcs_endd_int2_t3
	pbp_b2_coins_mcs_pct_int3_t3
	pbp_b2_coins_mcs_bgnd_int3_t3
	pbp_b2_coins_mcs_endd_int3_t3
	pbp_b2_ad_cost_vary_tiers_yn
	pbp_b2_ad_cost_vary_tier_num
	pbp_b2_ad_cost_vary_low_tier
	pbp_b2_coins_ad_intrvl_num_t1
	pbp_b2_coins_ad_pct_int1_t1
	pbp_b2_coins_ad_bgnd_int1_t1
	pbp_b2_coins_ad_endd_int1_t1
	pbp_b2_coins_ad_pct_int2_t1
	pbp_b2_coins_ad_bgnd_int2_t1
	pbp_b2_coins_ad_endd_int2_t1
	pbp_b2_coins_ad_pct_int3_t1
	pbp_b2_coins_ad_bgnd_int3_t1
	pbp_b2_coins_ad_endd_int3_t1
	pbp_b2_coins_ad_intrvl_num_t2
	pbp_b2_coins_ad_pct_int1_t2
	pbp_b2_coins_ad_bgnd_int1_t2
	pbp_b2_coins_ad_endd_int1_t2
	pbp_b2_coins_ad_pct_int2_t2
	pbp_b2_coins_ad_bgnd_int2_t2
	pbp_b2_coins_ad_endd_int2_t2
	pbp_b2_coins_ad_pct_int3_t2
	pbp_b2_coins_ad_bgnd_int3_t2
	pbp_b2_coins_ad_endd_int3_t2
	pbp_b2_coins_ad_intrvl_num_t3
	pbp_b2_coins_ad_pct_int1_t3
	pbp_b2_coins_ad_bgnd_int1_t3
	pbp_b2_coins_ad_endd_int1_t3
	pbp_b2_coins_ad_pct_int2_t3
	pbp_b2_coins_ad_bgnd_int2_t3
	pbp_b2_coins_ad_endd_int2_t3
	pbp_b2_coins_ad_pct_int3_t3
	pbp_b2_coins_ad_bgnd_int3_t3
	pbp_b2_coins_ad_endd_int3_t3
	pbp_b2_ded_yn
	pbp_b2_copay_yn
	pbp_b2_mc_copay_cstshr_yn_t1
	pbp_b2_copay_mcs_int_num_t1
	pbp_b2_copay_mcs_amt_int1_t1
	pbp_b2_copay_mcs_bgnd_int1_t1
	pbp_b2_copay_mcs_endd_int1_t1
	pbp_b2_copay_mcs_amt_int2_t1
	pbp_b2_copay_mcs_bgnd_int2_t1
	pbp_b2_copay_mcs_endd_int2_t1
	pbp_b2_copay_mcs_amt_int3_t1
	pbp_b2_copay_mcs_bgnd_int3_t1
	pbp_b2_copay_mcs_endd_int3_t1
	pbp_b2_mc_copay_cstshr_yn_t2
	pbp_b2_copay_mcs_int_num_t2
	pbp_b2_copay_mcs_amt_int1_t2
	pbp_b2_copay_mcs_bgnd_int1_t2
	pbp_b2_copay_mcs_endd_int1_t2
	pbp_b2_copay_mcs_amt_int2_t2
	pbp_b2_copay_mcs_bgnd_int2_t2
	pbp_b2_copay_mcs_endd_int2_t2
	pbp_b2_copay_mcs_amt_int3_t2
	pbp_b2_copay_mcs_bgnd_int3_t2
	pbp_b2_copay_mcs_endd_int3_t2
	pbp_b2_mc_copay_cstshr_yn_t3
	pbp_b2_copay_mcs_int_num_t3
	pbp_b2_copay_mcs_amt_int1_t3
	pbp_b2_copay_mcs_bgnd_int1_t3
	pbp_b2_copay_mcs_endd_int1_t3
	pbp_b2_copay_mcs_amt_int2_t3
	pbp_b2_copay_mcs_bgnd_int2_t3
	pbp_b2_copay_mcs_endd_int2_t3
	pbp_b2_copay_mcs_amt_int3_t3
	pbp_b2_copay_mcs_bgnd_int3_t3
	pbp_b2_copay_mcs_endd_int3_t3
	pbp_b2_copay_ad_intrvl_num_t1
	pbp_b2_copay_ad_amt_int1_t1
	pbp_b2_copay_ad_bgnd_int1_t1
	pbp_b2_copay_ad_endd_int1_t1
	pbp_b2_copay_ad_amt_int2_t1
	pbp_b2_copay_ad_bgnd_int2_t1
	pbp_b2_copay_ad_endd_int2_t1
	pbp_b2_copay_ad_amt_int3_t1
	pbp_b2_copay_ad_bgnd_int3_t1
	pbp_b2_copay_ad_endd_int3_t1
	pbp_b2_copay_ad_intrvl_num_t2
	pbp_b2_copay_ad_amt_int1_t2
	pbp_b2_copay_ad_bgnd_int1_t2
	pbp_b2_copay_ad_endd_int1_t2
	pbp_b2_copay_ad_amt_int2_t2
	pbp_b2_copay_ad_bgnd_int2_t2
	pbp_b2_copay_ad_endd_int2_t2
	pbp_b2_copay_ad_amt_int3_t2
	pbp_b2_copay_ad_bgnd_int3_t2
	pbp_b2_copay_ad_endd_int3_t2
	pbp_b2_copay_ad_intrvl_num_t3
	pbp_b2_copay_ad_amt_int1_t3
	pbp_b2_copay_ad_bgnd_int1_t3
	pbp_b2_copay_ad_endd_int1_t3
	pbp_b2_copay_ad_amt_int2_t3
	pbp_b2_copay_ad_bgnd_int2_t3
	pbp_b2_copay_ad_endd_int2_t3
	pbp_b2_copay_ad_amt_int3_t3
	pbp_b2_copay_ad_bgnd_int3_t3
	pbp_b2_copay_ad_endd_int3_t3
	pbp_b2_hosp_ben_period
	pbp_b2_hosp_ben_period_oth
	pbp_b2_cost_discharge_yn
	pbp_b2_auth_yn
	pbp_b2_refer_yn
	pbp_b2_bendesc_yn_bonly
	pbp_b2_bendesc_amo_bonly
	pbp_b2_bendesc_snf_unlm_bonly
	pbp_b2_bende_al_ad_prior_bonly
	pbp_b2_bendesc_snf_per_bonly
	pbp_b2_bendesc_snf_per_bonly_d
	pbp_b2_bendesc_hostay_bonly_yn
	pbp_b2_bende_nmday_prior_bonly
	pbp_b2_maxplan_yn_bonly
	pbp_b2_maxplan_amt_bonly
	pbp_b2_maxplan_per_bonly
	pbp_b2_maxplan_per_bonly_d
	pbp_b2_maxenr_yn_bonly
	pbp_b2_maxenr_amt_bonly
	pbp_b2_maxenr_per_bonly
	pbp_b2_maxenr_per_bonly_d
	pbp_b2_coins_yn_bonly
	pbp_b2_coins_pct_bonly
	pbp_b2_coins_ps_num_bonly
	pbp_b2_coins_ps_pct1_bonly
	pbp_b2_coins_ps_bgnd1_bonly
	pbp_b2_coins_ps_endd1_bonly
	pbp_b2_coins_ps_pct2_bonly
	pbp_b2_coins_ps_bgnd2_bonly
	pbp_b2_coins_ps_endd2_bonly
	pbp_b2_coins_ps_pct3_bonly
	pbp_b2_coins_ps_bgnd3_bonly
	pbp_b2_coins_ps_endd3_bonly
	pbp_b2_ded_yn_bonly
	pbp_b2_ded_amt_bonly
	pbp_b2_copay_yn_bonly
	pbp_b2_copay_ps_amt_bonly
	pbp_b2_copay_ps_num_bonly
	pbp_b2_copay_ps_amt1_bonly
	pbp_b2_copay_ps_bgnd1_bonly
	pbp_b2_copay_ps_endd1_bonly
	pbp_b2_copay_ps_amt2_bonly
	pbp_b2_copay_ps_bgnd2_bonly
	pbp_b2_copay_ps_endd2_bonly
	pbp_b2_copay_ps_amt3_bonly
	pbp_b2_copay_ps_bgnd3_bonly
	pbp_b2_copay_ps_endd3_bonly
	pbp_b2_auth_yn_bonly
	pbp_b2_refer_yn_bonly
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
	pbp_b2_bendesc_yn                = 'SNF Ben Desc MO YN'
	pbp_b2_bendesc_ad_nmcs           = 'SNF (2) Supp Benefits'
	pbp_b2_bendesc_amo_ad            = 'SNF Ben Desc MO AD'
	pbp_b2_benedesc_lim_ad           = 'SNF Ben Desc AD LIM YN'
	pbp_b2_bendesc_ad                = 'SNF Ben Desc AD Num'
	pbp_b2_bendesc_pr_hosp_yn        = 'SNF Ben Desc <3 Day Prior YN'
	pbp_b2_bendesc_pr_hosp_num       = 'SNF Ben Desc Num of Days 0-2'
	pbp_b2_maxenr_yn                 = 'SNF Max Enr YN'
	pbp_b2_maxenr_amt                = 'SNF Max Enr Amt'
	pbp_b2_maxenr_per                = 'SNF Max Enr Per'
	pbp_b2_maxenr_per_d              = 'SNF Max Enr Per Desc'
	pbp_b2_cost_vary_tiers_yn        = 'SNF Cost Tiers Vary YN'
	pbp_b2_cost_vary_tier_num        = 'SNF Cost Sharing Tiers'
	pbp_b2_cost_vary_low_tier        = 'SNF Lowest Cost Tier'
	pbp_b2_coins_yn                  = 'SNF Coinsurance YN'
	pbp_b2_mc_coins_cstshr_yn_t1     = 'SNF Med Def Coins Cost Shrs YN'
	pbp_b2_coins_mcs_int_num_t1      = 'SNF MCS Coins Interval Num'
	pbp_b2_coins_mcs_pct_int1_t1     = 'SNF MCS Coins Pct Interval 1'
	pbp_b2_coins_mcs_bgnd_int1_t1    = 'SNF MCS Coins Bgn Day Intrvl 1'
	pbp_b2_coins_mcs_endd_int1_t1    = 'SNF MCS Coins End Day Intrvl 1'
	pbp_b2_coins_mcs_pct_int2_t1     = 'SNF MCS Coins Pct Interval 2'
	pbp_b2_coins_mcs_bgnd_int2_t1    = 'SNF MCS Coins Bgn Day Intrvl 2'
	pbp_b2_coins_mcs_endd_int2_t1    = 'SNF MCS Coins End Day Intrvl 2'
	pbp_b2_coins_mcs_pct_int3_t1     = 'SNF MCS Coins Pct Interval 3'
	pbp_b2_coins_mcs_bgnd_int3_t1    = 'SNF MCS Coins Bgn Day Intrvl 3'
	pbp_b2_coins_mcs_endd_int3_t1    = 'SNF MCS Coins End Day Intrvl 3'
	pbp_b2_mc_coins_cstshr_yn_t2     = 'SNF Med Def Coins Cost Shrs YN'
	pbp_b2_coins_mcs_int_num_t2      = 'SNF MCS Coins Interval Num'
	pbp_b2_coins_mcs_pct_int1_t2     = 'SNF MCS Coins Pct Interval 1'
	pbp_b2_coins_mcs_bgnd_int1_t2    = 'SNF MCS Coins Bgn Day Intrvl 1'
	pbp_b2_coins_mcs_endd_int1_t2    = 'SNF MCS Coins End Day Intrvl 1'
	pbp_b2_coins_mcs_pct_int2_t2     = 'SNF MCS Coins Pct Interval 2'
	pbp_b2_coins_mcs_bgnd_int2_t2    = 'SNF MCS Coins Bgn Day Intrvl 2'
	pbp_b2_coins_mcs_endd_int2_t2    = 'SNF MCS Coins End Day Intrvl 2'
	pbp_b2_coins_mcs_pct_int3_t2     = 'SNF MCS Coins Pct Interval 3'
	pbp_b2_coins_mcs_bgnd_int3_t2    = 'SNF MCS Coins Bgn Day Intrvl 3'
	pbp_b2_coins_mcs_endd_int3_t2    = 'SNF MCS Coins End Day Intrvl 3'
	pbp_b2_mc_coins_cstshr_yn_t3     = 'SNF MCS Def Coins Cost Shrs YN'
	pbp_b2_coins_mcs_int_num_t3      = 'SNF MCS Coins Interval Num'
	pbp_b2_coins_mcs_pct_int1_t3     = 'SNF MCS Coins Pct Interval 1'
	pbp_b2_coins_mcs_bgnd_int1_t3    = 'SNF MCS Coins Bgn Day Intrvl 1'
	pbp_b2_coins_mcs_endd_int1_t3    = 'SNF MCS Coins End Day Intrvl 1'
	pbp_b2_coins_mcs_pct_int2_t3     = 'SNF MCS Coins Pct Interval 2'
	pbp_b2_coins_mcs_bgnd_int2_t3    = 'SNF MCS Coins Bgn Day Intrvl 2'
	pbp_b2_coins_mcs_endd_int2_t3    = 'SNF MCS Coins End Day Intrvl 2'
	pbp_b2_coins_mcs_pct_int3_t3     = 'SNF MCS Coins Pct Interval 3'
	pbp_b2_coins_mcs_bgnd_int3_t3    = 'SNF MCS Coins Bgn Day Intrvl 3'
	pbp_b2_coins_mcs_endd_int3_t3    = 'SNF MCS Coins End Day Intrvl 3'
	pbp_b2_ad_cost_vary_tiers_yn     = 'SNF AD Cost Shr Tiers Vary YN'
	pbp_b2_ad_cost_vary_tier_num     = 'SNF AD Cost Sharing Tiers'
	pbp_b2_ad_cost_vary_low_tier     = 'SNF AD Lowest Cost Tier'
	pbp_b2_coins_ad_intrvl_num_t1    = 'SNF AD Coins Interval Num'
	pbp_b2_coins_ad_pct_int1_t1      = 'SNF AD Coins Pct Interval 1'
	pbp_b2_coins_ad_bgnd_int1_t1     = 'SNF AD Coins Bgn Day Intrvl 1'
	pbp_b2_coins_ad_endd_int1_t1     = 'SNF AD Coins End Day Intrvl 1'
	pbp_b2_coins_ad_pct_int2_t1      = 'SNF AD Coins Pct Interval 2'
	pbp_b2_coins_ad_bgnd_int2_t1     = 'SNF AD Coins Bgn Day Intrvl 2'
	pbp_b2_coins_ad_endd_int2_t1     = 'SNF AD Coins End Day Intrvl 2'
	pbp_b2_coins_ad_pct_int3_t1      = 'SNF AD Coins Pct Interval 3'
	pbp_b2_coins_ad_bgnd_int3_t1     = 'SNF AD Coins Bgn Day Intrvl 3'
	pbp_b2_coins_ad_endd_int3_t1     = 'SNF AD Coins End Day Intrvl 3'
	pbp_b2_coins_ad_intrvl_num_t2    = 'SNF AD Coins Interval Num'
	pbp_b2_coins_ad_pct_int1_t2      = 'SNF AD Coins Pct Interval 1'
	pbp_b2_coins_ad_bgnd_int1_t2     = 'SNF AD Coins Bgn Day Intrvl 1'
	pbp_b2_coins_ad_endd_int1_t2     = 'SNF AD Coins End Day Intrvl 1'
	pbp_b2_coins_ad_pct_int2_t2      = 'SNF AD Coins Pct Interval 2'
	pbp_b2_coins_ad_bgnd_int2_t2     = 'SNF AD Coins Bgn Day Intrvl 2'
	pbp_b2_coins_ad_endd_int2_t2     = 'SNF AD Coins End Day Intrvl 2'
	pbp_b2_coins_ad_pct_int3_t2      = 'SNF AD Coins Pct Interval 3'
	pbp_b2_coins_ad_bgnd_int3_t2     = 'SNF AD Coins Bgn Day Intrvl 3'
	pbp_b2_coins_ad_endd_int3_t2     = 'SNF AD Coins End Day Intrvl 3'
	pbp_b2_coins_ad_intrvl_num_t3    = 'SNF AD Coins Interval Num'
	pbp_b2_coins_ad_pct_int1_t3      = 'SNF AD Coins Pct Interval 1'
	pbp_b2_coins_ad_bgnd_int1_t3     = 'SNF AD Coins Bgn Day Intrvl 1'
	pbp_b2_coins_ad_endd_int1_t3     = 'SNF AD Coins End Day Intrvl 1'
	pbp_b2_coins_ad_pct_int2_t3      = 'SNF AD Coins Pct Interval 2'
	pbp_b2_coins_ad_bgnd_int2_t3     = 'SNF AD Coins Bgn Day Intrvl 2'
	pbp_b2_coins_ad_endd_int2_t3     = 'SNF AD Coins End Day Intrvl 2'
	pbp_b2_coins_ad_pct_int3_t3      = 'SNF AD Coins Pct Interval 3'
	pbp_b2_coins_ad_bgnd_int3_t3     = 'SNF AD Coins Bgn Day Intrvl 3'
	pbp_b2_coins_ad_endd_int3_t3     = 'SNF AD Coins End Day Intrvl 3'
	pbp_b2_ded_yn                    = 'SNF Deductible YN'
	pbp_b2_copay_yn                  = 'SNF Copayment YN'
	pbp_b2_mc_copay_cstshr_yn_t1     = 'SNF MCS Def Copay Cost Shrs YN'
	pbp_b2_copay_mcs_int_num_t1      = 'SNF MCS Copay Interval Num'
	pbp_b2_copay_mcs_amt_int1_t1     = 'SNF MCS Copay Amt Interval 1'
	pbp_b2_copay_mcs_bgnd_int1_t1    = 'SNF MCS Copay Bgn Day Intrvl 1'
	pbp_b2_copay_mcs_endd_int1_t1    = 'SNF MCS Copay End Day Intrvl 1'
	pbp_b2_copay_mcs_amt_int2_t1     = 'SNF MCS Copay Amt Interval 2'
	pbp_b2_copay_mcs_bgnd_int2_t1    = 'SNF MCS Copay Bgn Day Intrvl 2'
	pbp_b2_copay_mcs_endd_int2_t1    = 'SNF MCS Copay End Day Intrvl 2'
	pbp_b2_copay_mcs_amt_int3_t1     = 'SNF MCS Copay Amt Interval 3'
	pbp_b2_copay_mcs_bgnd_int3_t1    = 'SNF MCS Copay Bgn Day Intrvl 3'
	pbp_b2_copay_mcs_endd_int3_t1    = 'SNF MCS Copay End Day Intrvl 3'
	pbp_b2_mc_copay_cstshr_yn_t2     = 'SNF MCS Def Copay Cost Shrs YN'
	pbp_b2_copay_mcs_int_num_t2      = 'SNF MCS Copay Interval Num'
	pbp_b2_copay_mcs_amt_int1_t2     = 'SNF MCS Copay Amt Interval 1'
	pbp_b2_copay_mcs_bgnd_int1_t2    = 'SNF MCS Copay Bgn Day Intrvl 1'
	pbp_b2_copay_mcs_endd_int1_t2    = 'SNF MCS Copay End Day Intrvl 1'
	pbp_b2_copay_mcs_amt_int2_t2     = 'SNF MCS Copay Amt Interval 2'
	pbp_b2_copay_mcs_bgnd_int2_t2    = 'SNF MCS Copay Bgn Day Intrvl 2'
	pbp_b2_copay_mcs_endd_int2_t2    = 'SNF MCS Copay End Day Intrvl 2'
	pbp_b2_copay_mcs_amt_int3_t2     = 'SNF MCS Copay Amt Interval 3'
	pbp_b2_copay_mcs_bgnd_int3_t2    = 'SNF MCS Copay Bgn Day Intrvl 3'
	pbp_b2_copay_mcs_endd_int3_t2    = 'SNF MCS Copay End Day Intrvl 3'
	pbp_b2_mc_copay_cstshr_yn_t3     = 'SNF MCS Def Copay Cost Shrs YN'
	pbp_b2_copay_mcs_int_num_t3      = 'SNF MCS Copay Interval Num'
	pbp_b2_copay_mcs_amt_int1_t3     = 'SNF MCS Copay Amt Interval 1'
	pbp_b2_copay_mcs_bgnd_int1_t3    = 'SNF MCS Copay Bgn Day Intrvl 1'
	pbp_b2_copay_mcs_endd_int1_t3    = 'SNF MCS Copay End Day Intrvl 1'
	pbp_b2_copay_mcs_amt_int2_t3     = 'SNF MCS Copay Amt Interval 2'
	pbp_b2_copay_mcs_bgnd_int2_t3    = 'SNF MCS Copay Bgn Day Intrvl 2'
	pbp_b2_copay_mcs_endd_int2_t3    = 'SNF MCS Copay End Day Intrvl 2'
	pbp_b2_copay_mcs_amt_int3_t3     = 'SNF MCS Copay Amt Interval 3'
	pbp_b2_copay_mcs_bgnd_int3_t3    = 'SNF MCS Copay Bgn Day Intrvl 3'
	pbp_b2_copay_mcs_endd_int3_t3    = 'SNF MCS Copay End Day Intrvl 3'
	pbp_b2_copay_ad_intrvl_num_t1    = 'SNF AD Copay Interval Num'
	pbp_b2_copay_ad_amt_int1_t1      = 'SNF AD Copay Amt Interval 1'
	pbp_b2_copay_ad_bgnd_int1_t1     = 'SNF AD Copay Bgn Day Intrvl 1'
	pbp_b2_copay_ad_endd_int1_t1     = 'SNF AD Copay End Day Intrvl 1'
	pbp_b2_copay_ad_amt_int2_t1      = 'SNF AD Copay Amt Interval 2'
	pbp_b2_copay_ad_bgnd_int2_t1     = 'SNF AD Copay Bgn Day Intrvl 2'
	pbp_b2_copay_ad_endd_int2_t1     = 'SNF AD Copay End Day Intrvl 2'
	pbp_b2_copay_ad_amt_int3_t1      = 'SNF AD Copay Amt Interval 3'
	pbp_b2_copay_ad_bgnd_int3_t1     = 'SNF AD Copay Bgn Day Intrvl 3'
	pbp_b2_copay_ad_endd_int3_t1     = 'SNF AD Copay End Day Intrvl 3'
	pbp_b2_copay_ad_intrvl_num_t2    = 'SNF AD Copay Interval Num'
	pbp_b2_copay_ad_amt_int1_t2      = 'SNF AD Copay Amt Interval 1'
	pbp_b2_copay_ad_bgnd_int1_t2     = 'SNF AD Copay Bgn Day Intrvl 1'
	pbp_b2_copay_ad_endd_int1_t2     = 'SNF AD Copay End Day Intrvl 1'
	pbp_b2_copay_ad_amt_int2_t2      = 'SNF AD Copay Amt Interval 2'
	pbp_b2_copay_ad_bgnd_int2_t2     = 'SNF AD Copay Bgn Day Intrvl 2'
	pbp_b2_copay_ad_endd_int2_t2     = 'SNF AD Copay End Day Intrvl 2'
	pbp_b2_copay_ad_amt_int3_t2      = 'SNF AD Copay Amt Interval 3'
	pbp_b2_copay_ad_bgnd_int3_t2     = 'SNF AD Copay Bgn Day Intrvl 3'
	pbp_b2_copay_ad_endd_int3_t2     = 'SNF AD Copay End Day Intrvl 3'
	pbp_b2_copay_ad_intrvl_num_t3    = 'SNF AD Copay Interval Num'
	pbp_b2_copay_ad_amt_int1_t3      = 'SNF AD Copay Amt Interval 1'
	pbp_b2_copay_ad_bgnd_int1_t3     = 'SNF AD Copay Bgn Day Intrvl 1'
	pbp_b2_copay_ad_endd_int1_t3     = 'SNF AD Copay End Day Intrvl 1'
	pbp_b2_copay_ad_amt_int2_t3      = 'SNF AD Copay Amt Interval 2'
	pbp_b2_copay_ad_bgnd_int2_t3     = 'SNF AD Copay Bgn Day Intrvl 2'
	pbp_b2_copay_ad_endd_int2_t3     = 'SNF AD Copay End Day Intrvl 2'
	pbp_b2_copay_ad_amt_int3_t3      = 'SNF AD Copay Amt Interval 3'
	pbp_b2_copay_ad_bgnd_int3_t3     = 'SNF AD Copay Bgn Day Intrvl 3'
	pbp_b2_copay_ad_endd_int3_t3     = 'SNF AD Copay End Day Intrvl 3'
	pbp_b2_hosp_ben_period           = 'SNF Ben Period'
	pbp_b2_hosp_ben_period_oth       = 'SNF Ben Period Other'
	pbp_b2_cost_discharge_yn         = 'SNF Costsharing discharge YN'
	pbp_b2_auth_yn                   = 'SNF Auth YN'
	pbp_b2_refer_yn                  = 'SNF Referral YN'
	pbp_b2_bendesc_yn_bonly          = 'SNF(B) Ben Desc YN'
	pbp_b2_bendesc_amo_bonly         = 'SNF(B) Ben Desc AMO'
	pbp_b2_bendesc_snf_unlm_bonly    = 'SNF(B) Ben Desc Unlimited Days'
	pbp_b2_bende_al_ad_prior_bonly   = 'SNF(B) Ben Desc Num of Days'
	pbp_b2_bendesc_snf_per_bonly     = 'SNF(B) Ben Desc Per'
	pbp_b2_bendesc_snf_per_bonly_d   = 'SNF(B) Ben Desc Per Desc'
	pbp_b2_bendesc_hostay_bonly_yn   = 'SNF(B) Ben Desc Hospital Stay'
	pbp_b2_bende_nmday_prior_bonly   = 'SNF(B) BenDesc Num of Days 0-2'
	pbp_b2_maxplan_yn_bonly          = 'SNF(B) Max Plan YN'
	pbp_b2_maxplan_amt_bonly         = 'SNF(B) Max Plan Amt'
	pbp_b2_maxplan_per_bonly         = 'SNF(B) Max Plan Per'
	pbp_b2_maxplan_per_bonly_d       = 'SNF(B) Max Plan Per Desc'
	pbp_b2_maxenr_yn_bonly           = 'SNF(B) Max Enr YN'
	pbp_b2_maxenr_amt_bonly          = 'SNF(B) Max Enr Amt'
	pbp_b2_maxenr_per_bonly          = 'SNF(B) Max Enr Per'
	pbp_b2_maxenr_per_bonly_d        = 'SNF(B) Max Enr Per Desc'
	pbp_b2_coins_yn_bonly            = 'SNF(B) Coinsurance YN'
	pbp_b2_coins_pct_bonly           = 'SNF(B) Coins Pct'
	pbp_b2_coins_ps_num_bonly        = 'SNF(B) PS Coins Interval Num'
	pbp_b2_coins_ps_pct1_bonly       = 'SNF(B) PS Coins Pct Intrvl 1'
	pbp_b2_coins_ps_bgnd1_bonly      = 'SNF(B) PS Coin Bgn Day Intrv 1'
	pbp_b2_coins_ps_endd1_bonly      = 'SNF(B) PS Coin End Day Intrv 1'
	pbp_b2_coins_ps_pct2_bonly       = 'SNF(B) PS Coins Pct Intrvl 2'
	pbp_b2_coins_ps_bgnd2_bonly      = 'SNF(B) PS Coin Bgn Day Intrv 2'
	pbp_b2_coins_ps_endd2_bonly      = 'SNF(B) PS Coin End Day Intrv 2'
	pbp_b2_coins_ps_pct3_bonly       = 'SNF(B) PS Coins Pct Intrvl 3'
	pbp_b2_coins_ps_bgnd3_bonly      = 'SNF(B) PS Coin Bgn Day Intrv 3'
	pbp_b2_coins_ps_endd3_bonly      = 'SNF(B) PS Coin End Day Intrv 3'
	pbp_b2_ded_yn_bonly              = 'SNF(B) Deductible YN'
	pbp_b2_ded_amt_bonly             = 'SNF(B) Deductible Amt'
	pbp_b2_copay_yn_bonly            = 'SNF(B) Copayment YN'
	pbp_b2_copay_ps_amt_bonly        = 'SNF(B) PS Copay Amt'
	pbp_b2_copay_ps_num_bonly        = 'SNF(B) PS Copay Interval Num'
	pbp_b2_copay_ps_amt1_bonly       = 'SNF(B) PS Copay Amt Interval 1'
	pbp_b2_copay_ps_bgnd1_bonly      = 'SNF(B) PS Cpay Bgn Day Intrv 1'
	pbp_b2_copay_ps_endd1_bonly      = 'SNF(B) PS Cpay End Day Intrv 1'
	pbp_b2_copay_ps_amt2_bonly       = 'SNF(B) PS Copay Amt Interval 2'
	pbp_b2_copay_ps_bgnd2_bonly      = 'SNF(B) PS Cpay Bgn Day Intrv 2'
	pbp_b2_copay_ps_endd2_bonly      = 'SNF(B) PS Cpay End Day Intrv 2'
	pbp_b2_copay_ps_amt3_bonly       = 'SNF(B) PS Copay Amt Interval 3'
	pbp_b2_copay_ps_bgnd3_bonly      = 'SNF(B) PS Cpay Bgn Day Intrv 3'
	pbp_b2_copay_ps_endd3_bonly      = 'SNF(B) PS Cpay End Day Intrv 3'
	pbp_b2_auth_yn_bonly             = 'SNF(B) Enrollee Auth'
	pbp_b2_refer_yn_bonly            = 'SNF(B) Referral YN'
;

run;

proc sort data = pbp_b2 out=out.pbp_b2;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b2(obs = 10);
  title 'pbp_b2_snf file ';
run;

proc means data = out.pbp_b2;
  title 'pbp_b2_snf file ';
run;

proc freq data = out.pbp_b2;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b2_bendesc_yn
	pbp_b2_bendesc_ad_nmcs
	pbp_b2_bendesc_amo_ad
	pbp_b2_benedesc_lim_ad
	pbp_b2_bendesc_pr_hosp_yn
	pbp_b2_bendesc_pr_hosp_num
	pbp_b2_maxenr_yn
	pbp_b2_maxenr_per
	pbp_b2_cost_vary_tiers_yn
	pbp_b2_cost_vary_tier_num
	pbp_b2_cost_vary_low_tier
	pbp_b2_coins_yn
	pbp_b2_mc_coins_cstshr_yn_t1
	pbp_b2_coins_mcs_int_num_t1
	pbp_b2_mc_coins_cstshr_yn_t2
	pbp_b2_coins_mcs_int_num_t2
	pbp_b2_mc_coins_cstshr_yn_t3
	pbp_b2_coins_mcs_int_num_t3
	pbp_b2_ad_cost_vary_tiers_yn
	pbp_b2_ad_cost_vary_tier_num
	pbp_b2_ad_cost_vary_low_tier
	pbp_b2_coins_ad_intrvl_num_t1
	pbp_b2_coins_ad_intrvl_num_t2
	pbp_b2_coins_ad_intrvl_num_t3
	pbp_b2_ded_yn
	pbp_b2_copay_yn
	pbp_b2_mc_copay_cstshr_yn_t1
	pbp_b2_copay_mcs_int_num_t1
	pbp_b2_mc_copay_cstshr_yn_t2
	pbp_b2_copay_mcs_int_num_t2
	pbp_b2_mc_copay_cstshr_yn_t3
	pbp_b2_copay_mcs_int_num_t3
	pbp_b2_copay_ad_intrvl_num_t1
	pbp_b2_copay_ad_intrvl_num_t2
	pbp_b2_copay_ad_intrvl_num_t3
	pbp_b2_hosp_ben_period
	pbp_b2_cost_discharge_yn
	pbp_b2_auth_yn
	pbp_b2_refer_yn
	pbp_b2_bendesc_yn_bonly
	pbp_b2_bendesc_amo_bonly
	pbp_b2_bendesc_snf_unlm_bonly
	pbp_b2_bendesc_snf_per_bonly
	pbp_b2_bendesc_hostay_bonly_yn
	pbp_b2_bende_nmday_prior_bonly
	pbp_b2_maxplan_yn_bonly
	pbp_b2_maxplan_per_bonly
	pbp_b2_maxenr_yn_bonly
	pbp_b2_maxenr_per_bonly
	pbp_b2_coins_yn_bonly
	pbp_b2_coins_ps_num_bonly
	pbp_b2_ded_yn_bonly
	pbp_b2_copay_yn_bonly
	pbp_b2_copay_ps_num_bonly
	pbp_b2_auth_yn_bonly
	pbp_b2_refer_yn_bonly
/ missing;
run;

proc contents data = out.pbp_b2;
  title 'pbp_b2 data';
run;