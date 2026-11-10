*pbp_mrx_tier.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_mrx_tier;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	part_d_model_demo                $1
	part_d_enhncd_cvrg_demo          $1
	mrx_tier_label_list              $250
	mrx_tier_benefit_type            $1
	mrx_tier_drug_type               $2
	mrx_tier_includes                $1
	mrx_tier_cstshr_struct_type      $1
	mrx_tier_id                      $1
	mrx_tier_type_id                 $1
	mrx_tier_locat_rstd              $3
	mrx_tier_locat_rsplt             $3
	mrx_tier_locat_oon               $2
	mrx_tier_locat_mostd             $3
	mrx_tier_locat_mosplt            $3
	mrx_tier_locat_ltc               $1
	mrx_tier_extd_days_yn            $1
	mrx_tier_extd_first_fill         $1
	mrx_tier_form_model_desc         $4000
;

infile '.\pbp\pbp_mrx_tier.txt' delimiter = '09'x
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
	part_d_model_demo
	part_d_enhncd_cvrg_demo
	mrx_tier_label_list
	mrx_tier_benefit_type
	mrx_tier_drug_type
	mrx_tier_includes
	mrx_tier_cstshr_struct_type
	mrx_tier_id
	mrx_tier_type_id
	mrx_tier_locat_rstd
	mrx_tier_locat_rsplt
	mrx_tier_locat_oon
	mrx_tier_locat_mostd
	mrx_tier_locat_mosplt
	mrx_tier_locat_ltc
	mrx_tier_rstd_1m_num
	mrx_tier_rstd_2m_num
	mrx_tier_rstd_3m_num
	mrx_tier_rsplt_1m_num
	mrx_tier_rsplt_2m_num
	mrx_tier_rsplt_3m_num
	mrx_tier_extd_days_yn
	mrx_tier_extd_first_fill
	mrx_tier_mostd_1m_num
	mrx_tier_mostd_2m_num
	mrx_tier_mostd_3m_num
	mrx_tier_mosplt_1m_num
	mrx_tier_mosplt_2m_num
	mrx_tier_mosplt_3m_num
	mrx_tier_oonp_1m_num
	mrx_tier_oonp_othnumn
	mrx_tier_ltcp_1m
	mrx_tier_rstd_copay_1m
	mrx_tier_rstd_copay_2m
	mrx_tier_rstd_copay_3m
	mrx_tier_rstd_coins_avg_1m
	mrx_tier_rstd_coins_1m
	mrx_tier_rstd_coins_2m
	mrx_tier_rstd_coins_3m
	mrx_tier_rsstd_copay_1m
	mrx_tier_rsstd_copay_2m
	mrx_tier_rsstd_copay_3m
	mrx_tier_rsstd_coins_avg_1m
	mrx_tier_rsstd_coins_1m
	mrx_tier_rsstd_coins_2m
	mrx_tier_rsstd_coins_3m
	mrx_tier_rspfd_copay_1m
	mrx_tier_rspfd_copay_2m
	mrx_tier_rspfd_copay_3m
	mrx_tier_rspfd_coins_avg_1m
	mrx_tier_rspfd_coins_1m
	mrx_tier_rspfd_coins_2m
	mrx_tier_rspfd_coins_3m
	mrx_tier_mostd_copay_1m
	mrx_tier_mostd_copay_2m
	mrx_tier_mostd_copay_3m
	mrx_tier_mostd_coins_1m
	mrx_tier_mostd_coins_2m
	mrx_tier_mostd_coins_3m
	mrx_tier_mosstd_copay_1m
	mrx_tier_mosstd_copay_2m
	mrx_tier_mosstd_copay_3m
	mrx_tier_mosstd_coins_1m
	mrx_tier_mosstd_coins_2m
	mrx_tier_mosstd_coins_3m
	mrx_tier_mospfd_copay_1m
	mrx_tier_mospfd_copay_2m
	mrx_tier_mospfd_copay_3m
	mrx_tier_mospfd_coins_1m
	mrx_tier_mospfd_coins_2m
	mrx_tier_mospfd_coins_3m
	mrx_tier_oonp_copay_1m
	mrx_tier_oonp_copay_othnum
	mrx_tier_oonp_coins_1m
	mrx_tier_oonp_coins_othnum
	mrx_tier_ltcp_copay_1m
	mrx_tier_ltcp_coins_1m
	mrx_tier_rstd_copay_daily
	mrx_tier_rsstd_copay_daily
	mrx_tier_rspfd_copay_daily
	mrx_tier_mostd_copay_daily
	mrx_tier_mosstd_copay_daily
	mrx_tier_mospfd_copay_daily
	mrx_tier_ltcp_copay_daily
	mrx_tier_form_model_desc
	mrx_tier_ira_rstd_copay_1m
	mrx_tier_ira_rstd_copay_2m
	mrx_tier_ira_rstd_copay_3m
	mrx_tier_ira_rspfd_copay_1m
	mrx_tier_ira_rspfd_copay_2m
	mrx_tier_ira_rspfd_copay_3m
	mrx_tier_ira_mostd_copay_1m
	mrx_tier_ira_mostd_copay_2m
	mrx_tier_ira_mostd_copay_3m
	mrx_tier_ira_mopfd_copay_1m
	mrx_tier_ira_mopfd_copay_2m
	mrx_tier_ira_mopfd_copay_3m
	mrx_tier_ira_oonp_copay_1m
	mrx_tier_ira_oonp_copay_othnum
	mrx_tier_ira_ltcp_copay_1m
	mrx_tier_ira_rstd_coins_1m
	mrx_tier_ira_rstd_coins_2m
	mrx_tier_ira_rstd_coins_3m
	mrx_tier_ira_rspfd_coins_1m
	mrx_tier_ira_rspfd_coins_2m
	mrx_tier_ira_rspfd_coins_3m
	mrx_tier_ira_mostd_coins_1m
	mrx_tier_ira_mostd_coins_2m
	mrx_tier_ira_mostd_coins_3m
	mrx_tier_ira_mopfd_coins_1m
	mrx_tier_ira_mopfd_coins_2m
	mrx_tier_ira_mopfd_coins_3m
	mrx_tier_ira_oonp_coins_1m
	mrx_tier_ira_oonp_coins_othnum
	mrx_tier_ira_ltcp_coins_1m
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
	part_d_model_demo                = 'Part D Model Demo'
	part_d_enhncd_cvrg_demo          = 'Part D Senior Savings Model'
	mrx_tier_label_list              = 'MRx Tier Label Description'
	mrx_tier_benefit_type            = 'MRx Drug Benefit Type - Tier'
	mrx_tier_drug_type               = 'MRx Tier Drug Types'
	mrx_tier_includes                = 'MRx Tier Includes'
	mrx_tier_cstshr_struct_type      = 'MRx Cost Share Tier Struct'
	mrx_tier_id                      = 'MRx Tier ID'
	mrx_tier_type_id                 = 'MRx Tier Type ID'
	mrx_tier_locat_rstd              = 'MRx Std Retail Cost-Share Loc'
	mrx_tier_locat_rsplt             = 'MRx Std/Pref Retail Cost Loc'
	mrx_tier_locat_oon               = 'MRx Out-of-Network Loc'
	mrx_tier_locat_mostd             = 'MRx MO Std Pharmacy Locations'
	mrx_tier_locat_mosplt            = 'MRx MO Std/Pref Pharm Locat'
	mrx_tier_locat_ltc               = 'MRx LTC Pharmacy Locations'
	mrx_tier_rstd_1m_num             = 'MRx Tier INP 1M Supply Days'
	mrx_tier_rstd_2m_num             = 'MRx Tier INP 2M Supply Days'
	mrx_tier_rstd_3m_num             = 'MRx Tier INP 3M Supply Days'
	mrx_tier_rsplt_1m_num            = 'MRx Tier INPP 1M Supply Days'
	mrx_tier_rsplt_2m_num            = 'MRx Tier INPP 2M Supply Days'
	mrx_tier_rsplt_3m_num            = 'MRx Tier INPP 3M Supply Days'
	mrx_tier_extd_days_yn            = 'MRx Tier Extended Day Supply'
	mrx_tier_extd_first_fill         = 'MRX Extend First Fill'
	mrx_tier_mostd_1m_num            = 'MRx Tier MO 1M Supply Days'
	mrx_tier_mostd_2m_num            = 'MRx Tier MO 2M Supply Days'
	mrx_tier_mostd_3m_num            = 'MRx Tier MO 3M Supply Days'
	mrx_tier_mosplt_1m_num           = 'MRx Tier MOPP 1M Supply Days'
	mrx_tier_mosplt_2m_num           = 'MRx Tier MOPP 2M Supply Days'
	mrx_tier_mosplt_3m_num           = 'MRx Tier MOPP 3M Supply Days'
	mrx_tier_oonp_1m_num             = 'MRx Tier OONP 1M Supply Days'
	mrx_tier_oonp_othnumn            = 'MRx Tier OONP Oth Supply Days'
	mrx_tier_ltcp_1m                 = 'MRx LTC Tier 1M Num Days'
	mrx_tier_rstd_copay_1m           = 'MRx Tier INP Copay 1M'
	mrx_tier_rstd_copay_2m           = 'MRx Tier INP Copay 2M'
	mrx_tier_rstd_copay_3m           = 'MRx Tier INP Copay 3M'
	mrx_tier_rstd_coins_avg_1m       = 'MRx INP Avg Expect 1M Coins'
	mrx_tier_rstd_coins_1m           = 'MRx Tier INP Coins 1M'
	mrx_tier_rstd_coins_2m           = 'MRx Tier INP Coins 2M'
	mrx_tier_rstd_coins_3m           = 'MRx Tier INP Coins 3M'
	mrx_tier_rsstd_copay_1m          = 'MRx Tier INNPP Copay 1M'
	mrx_tier_rsstd_copay_2m          = 'MRx Tier INNPP Copay 2M'
	mrx_tier_rsstd_copay_3m          = 'MRx Tier INNPP Copay 3M'
	mrx_tier_rsstd_coins_avg_1m      = 'MRx INNPP Avg Expect 1M Coins'
	mrx_tier_rsstd_coins_1m          = 'MRx Tier INNPP Coins 1M'
	mrx_tier_rsstd_coins_2m          = 'MRx Tier INNPP Coins 2M'
	mrx_tier_rsstd_coins_3m          = 'MRx Tier INNPP Coins 3M'
	mrx_tier_rspfd_copay_1m          = 'MRx Tier INPP Copay 1M'
	mrx_tier_rspfd_copay_2m          = 'MRx Tier INPP Copay 2M'
	mrx_tier_rspfd_copay_3m          = 'MRx Tier INPP Copay 3M'
	mrx_tier_rspfd_coins_avg_1m      = 'MRx INPP Avg Expect 1M Coins'
	mrx_tier_rspfd_coins_1m          = 'MRx Tier INPP Coins 1M'
	mrx_tier_rspfd_coins_2m          = 'MRx Tier INPP Coins 2M'
	mrx_tier_rspfd_coins_3m          = 'MRx Tier INPP Coins 3M'
	mrx_tier_mostd_copay_1m          = 'MRx Tier MO Copay 1M'
	mrx_tier_mostd_copay_2m          = 'MRx Tier MO Copay 2M'
	mrx_tier_mostd_copay_3m          = 'MRx Tier MO Copay 3M'
	mrx_tier_mostd_coins_1m          = 'MRx Tier MO Coins 1M'
	mrx_tier_mostd_coins_2m          = 'MRx Tier MO Coins 2M'
	mrx_tier_mostd_coins_3m          = 'MRx Tier MO Coins 3M'
	mrx_tier_mosstd_copay_1m         = 'MRx Tier MONPP Copay 1M'
	mrx_tier_mosstd_copay_2m         = 'MRx Tier MONPP Copay 2M'
	mrx_tier_mosstd_copay_3m         = 'MRx Tier MONPP Copay 3M'
	mrx_tier_mosstd_coins_1m         = 'MRx Tier MONPP Coins 1M'
	mrx_tier_mosstd_coins_2m         = 'MRx Tier MONPP Coins 2M'
	mrx_tier_mosstd_coins_3m         = 'MRx Tier MONPP Coins 3M'
	mrx_tier_mospfd_copay_1m         = 'MRx Tier MOPP Copay 1M'
	mrx_tier_mospfd_copay_2m         = 'MRx Tier MOPP Copay 2M'
	mrx_tier_mospfd_copay_3m         = 'MRx Tier MOPP Copay 3M'
	mrx_tier_mospfd_coins_1m         = 'MRx Tier MOPP Coins 1M'
	mrx_tier_mospfd_coins_2m         = 'MRx Tier MOPP Coins 2M'
	mrx_tier_mospfd_coins_3m         = 'MRx Tier MOPP Coins 3M'
	mrx_tier_oonp_copay_1m           = 'MRx Tier OONP Copay 1M'
	mrx_tier_oonp_copay_othnum       = 'MRx Tier OONP Copay Oth'
	mrx_tier_oonp_coins_1m           = 'MRx Tier OONP Coins 1M'
	mrx_tier_oonp_coins_othnum       = 'MRx Tier OONP Coins Oth'
	mrx_tier_ltcp_copay_1m           = 'MRx LTCP Brand Copay 1M'
	mrx_tier_ltcp_coins_1m           = 'MRx LTC Pharmacy Coins 1M'
	mrx_tier_rstd_copay_daily        = 'MRx INP Daily Copay'
	mrx_tier_rsstd_copay_daily       = 'MRx INNPP Daily Copay'
	mrx_tier_rspfd_copay_daily       = 'MRx INPP Daily Copay'
	mrx_tier_mostd_copay_daily       = 'MRx MO Daily Copay'
	mrx_tier_mosstd_copay_daily      = 'MRx MONPP Daily Copay'
	mrx_tier_mospfd_copay_daily      = 'MRx MOPP Daily Copay'
	mrx_tier_ltcp_copay_daily        = 'MRx LTCP Brand Daily Copay'
	mrx_tier_form_model_desc         = 'MRx Tier Label Description'
	mrx_tier_ira_rstd_copay_1m       = 'Insulin Tier Ret Copay 1M'
	mrx_tier_ira_rstd_copay_2m       = 'Insulin Tier Ret Copay 2M'
	mrx_tier_ira_rstd_copay_3m       = 'Insulin Tier Ret Copay 3M'
	mrx_tier_ira_rspfd_copay_1m      = 'Insulin Tier RetP Copay 1M'
	mrx_tier_ira_rspfd_copay_2m      = 'Insulin Tier RetP Copay 2M'
	mrx_tier_ira_rspfd_copay_3m      = 'Insulin Tier RetP Copay 3M'
	mrx_tier_ira_mostd_copay_1m      = 'Insulin Tier MO Copay 1M'
	mrx_tier_ira_mostd_copay_2m      = 'Insulin Tier MO Copay 2M'
	mrx_tier_ira_mostd_copay_3m      = 'Insulin Tier MO Copay 3M'
	mrx_tier_ira_mopfd_copay_1m      = 'Insulin Tier MOPP Copay 1M'
	mrx_tier_ira_mopfd_copay_2m      = 'Insulin Tier MOPP Copay 2M'
	mrx_tier_ira_mopfd_copay_3m      = 'Insulin Tier MOPP Copay 3M'
	mrx_tier_ira_oonp_copay_1m       = 'Insulin Tier OONP Copay 1M'
	mrx_tier_ira_oonp_copay_othnum   = 'Insulin Tier OONP Copay Oth'
	mrx_tier_ira_ltcp_copay_1m       = 'Insulin Tier LTCP Copay 1M'
	mrx_tier_ira_rstd_coins_1m       = 'Insulin Tier Ret Coins 1M'
	mrx_tier_ira_rstd_coins_2m       = 'Insulin Tier Ret Coins 2M'
	mrx_tier_ira_rstd_coins_3m       = 'Insulin Tier Ret Coins 3M'
	mrx_tier_ira_rspfd_coins_1m      = 'Insulin Tier RetP Coins 1M'
	mrx_tier_ira_rspfd_coins_2m      = 'Insulin Tier RetP Coins 2M'
	mrx_tier_ira_rspfd_coins_3m      = 'Insulin Tier RetP Coins 3M'
	mrx_tier_ira_mostd_coins_1m      = 'Insulin Tier MO Coins 1M'
	mrx_tier_ira_mostd_coins_2m      = 'Insulin Tier MO Coins 2M'
	mrx_tier_ira_mostd_coins_3m      = 'Insulin Tier MO Coins 3M'
	mrx_tier_ira_mopfd_coins_1m      = 'Insulin Tier MOPP Coins 1M'
	mrx_tier_ira_mopfd_coins_2m      = 'Insulin Tier MOPP Coins 2M'
	mrx_tier_ira_mopfd_coins_3m      = 'Insulin Tier MOPP Coins 3M'
	mrx_tier_ira_oonp_coins_1m       = 'Insulin Tier OONP Coins 1M'
	mrx_tier_ira_oonp_coins_othnum   = 'Insulin Tier OONP Coins Oth'
	mrx_tier_ira_ltcp_coins_1m       = 'Insulin Tier LTCP Coins 1M'
;

run;

proc sort data = pbp_mrx_tier out=out.pbp_mrx_tier;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_mrx_tier(obs = 10);
  title 'pbp_mrx_tier file ';
run;

proc means data = out.pbp_mrx_tier;
  title 'pbp_mrx_tier file ';
run;

proc freq data = out.pbp_mrx_tier;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	part_d_model_demo
	part_d_enhncd_cvrg_demo
	mrx_tier_benefit_type
	mrx_tier_drug_type
	mrx_tier_includes
	mrx_tier_cstshr_struct_type
	mrx_tier_id
	mrx_tier_type_id
	mrx_tier_locat_rstd
	mrx_tier_locat_rsplt
	mrx_tier_locat_oon
	mrx_tier_locat_mostd
	mrx_tier_locat_mosplt
	mrx_tier_locat_ltc
	mrx_tier_extd_days_yn
	mrx_tier_extd_first_fill
/ missing;
run;

proc contents data = out.pbp_mrx_tier;
  title 'pbp_mrx_tier data';
run;