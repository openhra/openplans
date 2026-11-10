*pbp_mrx.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_mrx;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	part_d_model_demo                $1
	part_d_enhncd_cvrg_demo          $1
	mrx_form_model_type              $5
	mrx_drug_ben_yn                  $1
	mrx_benefit_type                 $1
	mrx_partd_network_loc            $6
	mrx_ltc_attest_flag              $1
	mrx_first_fill                   $1
	mrx_otc_meds_pay_ump_yn          $1
	mrx_otc_meds_attest_flag         $1
	mrx_formulary_tiers_num          $1
	mrx_tier_form_ex                 $1
	mrx_tier_form_ex_2_yn            $1
	mrx_ae_oon_cstshr_struct         $1
	mrx_ae_cstshr_apply              $1
	mrx_form_model_desc              $4000
	mrx_ae_ooptcs_apply              $1
	mrx_alt_ded_charge               $1
	mrx_alt_ded_type_yn              $1
	mrx_alt_no_ded_tier              $7
	mrx_alt_ded_tier_cstshr_yn       $1
	mrx_alt_gen_cstshr_struct        $1
	mrx_alt_oon_cstshr_struct        $1
	mrx_alt_red_cost_sharing         $1
	mrx_alt_red_cost_sharing_items   $3
	mrx_alt_fulfill_desc             $4000
	mrx_alt_excl_drugs_yn            $1
	mrx_alt_pre_icl_cost_share       $1
	mrx_alt_pre_icl_exclud_only_yn   $1
	mrx_alt_ira_covg_tier            $7
	mrx_alt_cstshr_post_oopt         $1
	mrx_gen_loc_rstd                 $3
	mrx_gen_loc_oon                  $2
	mrx_gen_loc_mostd                $3
	mrx_gen_loc_ltc                  $1
	mrx_tier_extd_days_gen_yn        $1
	mrx_gen_extd_first_fill          $1
	mrx_avg_exp_cost_share_attest    $1
	mrx_snp_zerocost_attest          $1
	mrx_vaccine_attest               $1
	mrx_insulin_attest               $1
;

infile '.\pbp\pbp_mrx.txt' delimiter = '09'x
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
	mrx_form_model_type
	mrx_drug_ben_yn
	mrx_benefit_type
	mrx_partd_network_loc
	mrx_ltc_attest_flag
	mrx_first_fill
	mrx_otc_meds_pay_ump_yn
	mrx_otc_meds_attest_flag
	mrx_formulary_tiers_num
	mrx_tier_form_ex
	mrx_tier_form_ex_2_yn
	mrx_tier_form_ex_2
	mrx_ae_oon_cstshr_struct
	mrx_ae_cstshr_apply
	mrx_form_model_desc
	mrx_ae_ooptcs_apply
	mrx_alt_ded_charge
	mrx_alt_ded_amount
	mrx_alt_ded_type_yn
	mrx_alt_no_ded_tier
	mrx_alt_ded_tier_cstshr_yn
	mrx_alt_gen_cstshr_struct
	mrx_alt_gen_coins_pct
	mrx_alt_gen_copay_amt
	mrx_alt_oon_cstshr_struct
	mrx_alt_red_cost_sharing
	mrx_alt_red_cost_sharing_items
	mrx_alt_fulfill_desc
	mrx_alt_excl_drugs_yn
	mrx_alt_pre_icl_cost_share
	mrx_alt_pre_icl_exclud_only_yn
	mrx_alt_ira_covg_tier
	mrx_alt_cstshr_post_oopt
	mrx_gen_loc_rstd
	mrx_gen_rstd_1m
	mrx_gen_rstd_2m
	mrx_gen_rstd_3m
	mrx_gen_loc_oon
	mrx_gen_oon_1m
	mrx_gen_oon_os
	mrx_gen_loc_mostd
	mrx_gen_mostd_1m
	mrx_gen_mostd_2m
	mrx_gen_mostd_3m
	mrx_gen_loc_ltc
	mrx_gen_ltc_1m
	mrx_tier_extd_days_gen_yn
	mrx_gen_extd_first_fill
	mrx_gen_ira_rstd_copay_1m
	mrx_gen_ira_rstd_copay_2m
	mrx_gen_ira_rstd_copay_3m
	mrx_gen_ira_mostd_copay_1m
	mrx_gen_ira_mostd_copay_2m
	mrx_gen_ira_mostd_copay_3m
	mrx_gen_ira_oonp_copay_1m
	mrx_gen_ira_oonp_copay_othnum
	mrx_gen_ira_ltcp_copay_1m
	mrx_gen_ira_rstd_coins_1m
	mrx_gen_ira_rstd_coins_2m
	mrx_gen_ira_rstd_coins_3m
	mrx_gen_ira_mostd_coins_1m
	mrx_gen_ira_mostd_coins_2m
	mrx_gen_ira_mostd_coins_3m
	mrx_gen_ira_oonp_coins_1m
	mrx_gen_ira_oonp_coins_othnum
	mrx_gen_ira_ltcp_coins_1m
	mrx_avg_exp_cost_share_attest
	mrx_snp_zerocost_attest
	mrx_vaccine_attest
	mrx_insulin_attest
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
	mrx_form_model_type              = 'MRX Tier Model'
	mrx_drug_ben_yn                  = 'MRx Drug Benefit YN'
	mrx_benefit_type                 = 'MRx Drug Benefit Type'
	mrx_partd_network_loc            = 'MRx PartD Network Location'
	mrx_ltc_attest_flag              = 'MRx LTC Attest Flag'
	mrx_first_fill                   = 'MRx First Fill'
	mrx_otc_meds_pay_ump_yn          = 'MRx OTC Util Mngmt Program'
	mrx_otc_meds_attest_flag         = 'MRx OTC Med Attest Flag'
	mrx_formulary_tiers_num          = 'MRx Formulary Tiers Num'
	mrx_tier_form_ex                 = 'MRx Form Exception Tier'
	mrx_tier_form_ex_2_yn            = 'MRx 2nd Exception Tier YN'
	mrx_tier_form_ex_2               = 'MRx 2nd Exception Tier #'
	mrx_ae_oon_cstshr_struct         = 'MRx AE Cstshr Structure'
	mrx_ae_cstshr_apply              = 'MRx AE Cstshr Pre-Intl Cov Lmt'
	mrx_form_model_desc              = 'MRx Tier Label Description'
	mrx_ae_ooptcs_apply              = 'MRx AE OOP Threshold Applct'
	mrx_alt_ded_charge               = 'MRx Alt BA Deduct Charged YN'
	mrx_alt_ded_amount               = 'MRx Alt Deductible Amount'
	mrx_alt_ded_type_yn              = 'MRx Alt BA Ded Tier YN'
	mrx_alt_no_ded_tier              = 'MRx Alt Non-Deductible Tiers'
	mrx_alt_ded_tier_cstshr_yn       = 'MRx Alt Tier Deduct Cost Share'
	mrx_alt_gen_cstshr_struct        = 'MRx Alt BA Cstshr Structure'
	mrx_alt_gen_coins_pct            = 'MRx Alt Coins Pct'
	mrx_alt_gen_copay_amt            = 'MRx Alt Copay Amt'
	mrx_alt_oon_cstshr_struct        = 'MRx Alt BA OON Cstshr Struct'
	mrx_alt_red_cost_sharing         = 'MRx Alt Red Cost Sharing'
	mrx_alt_red_cost_sharing_items   = 'MRx Alt Red Cost Sharing Items'
	mrx_alt_fulfill_desc             = 'MRx Fulfill Description'
	mrx_alt_excl_drugs_yn            = 'MRx Alt Excluded supp drugs'
	mrx_alt_pre_icl_cost_share       = 'MRx Alt Cstshr Pre-Int Cov Lmt'
	mrx_alt_pre_icl_exclud_only_yn   = 'MRx Pre ICP Exclud drug only'
	mrx_alt_ira_covg_tier            = 'MRx IRA Insulin Tier Cov'
	mrx_alt_cstshr_post_oopt         = 'MRx Alt Cstshr Post OOPT'
	mrx_gen_loc_rstd                 = 'MRx DS INP Location'
	mrx_gen_rstd_1m                  = 'MRx DS IN 1M Supply Days'
	mrx_gen_rstd_2m                  = 'MRx DS IN 2M Supply Days'
	mrx_gen_rstd_3m                  = 'MRx DS IN 3M Supply Days'
	mrx_gen_loc_oon                  = 'MRx DS Out-of-Network Loc'
	mrx_gen_oon_1m                   = 'MRx DS OONP 1M Supply Days'
	mrx_gen_oon_os                   = 'MRx DS OONP Oth Supply Days'
	mrx_gen_loc_mostd                = 'MRx DS MO Pharmacy Locations'
	mrx_gen_mostd_1m                 = 'MRx DS MO 1M Supply Days'
	mrx_gen_mostd_2m                 = 'MRx DS MO 2M Supply Days'
	mrx_gen_mostd_3m                 = 'MRx DS MO 3M Supply Days'
	mrx_gen_loc_ltc                  = 'MRx DS LTC Phar 1M Location'
	mrx_gen_ltc_1m                   = 'MRx DS LTC 1M Day Supply'
	mrx_tier_extd_days_gen_yn        = 'MRx DS Tier Extend Day Supply'
	mrx_gen_extd_first_fill          = 'MRX DS Extend First Fill'
	mrx_gen_ira_rstd_copay_1m        = 'MRX DS Insulin Ret Copay 1M'
	mrx_gen_ira_rstd_copay_2m        = 'MRX DS Insulin Ret Copay 2M'
	mrx_gen_ira_rstd_copay_3m        = 'MRX DS Insulin Ret Copay 3M'
	mrx_gen_ira_mostd_copay_1m       = 'MRX DS Insulin MO Copay 1M'
	mrx_gen_ira_mostd_copay_2m       = 'MRX DS Insulin MO Copay 2M'
	mrx_gen_ira_mostd_copay_3m       = 'MRX DS Insulin MO Copay 3M'
	mrx_gen_ira_oonp_copay_1m        = 'MRX DS Insulin OONP Copay 1M'
	mrx_gen_ira_oonp_copay_othnum    = 'MRX DS Insulin OONP Copay Oth'
	mrx_gen_ira_ltcp_copay_1m        = 'MRX DS Insulin LTCP Copay 1M'
	mrx_gen_ira_rstd_coins_1m        = 'MRX DS Insulin Ret Coins 1M'
	mrx_gen_ira_rstd_coins_2m        = 'MRX DS Insulin Ret Coins 2M'
	mrx_gen_ira_rstd_coins_3m        = 'MRX DS Insulin Ret Coins 3M'
	mrx_gen_ira_mostd_coins_1m       = 'MRX DS Insulin MO Coins 1M'
	mrx_gen_ira_mostd_coins_2m       = 'MRX DS Insulin MO Coins 2M'
	mrx_gen_ira_mostd_coins_3m       = 'MRX DS Insulin MO Coins 3M'
	mrx_gen_ira_oonp_coins_1m        = 'MRX DS Insulin OONP Coins 1M'
	mrx_gen_ira_oonp_coins_othnum    = 'MRX DS Insulin OONP Coins Oth'
	mrx_gen_ira_ltcp_coins_1m        = 'MRX DS Insulin LTCP Coins 1M'
	mrx_avg_exp_cost_share_attest    = 'MRX Avg Exp Cost Attest'
	mrx_snp_zerocost_attest          = 'MRX SNP Zero Cost Attest'
	mrx_vaccine_attest               = 'MRX Vaccine Attest'
	mrx_insulin_attest               = 'MRX Insulin Attest'
;

run;

proc sort data = pbp_mrx out=out.pbp_mrx;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_mrx(obs = 10);
  title 'pbp_mrx file ';
run;

proc means data = out.pbp_mrx;
  title 'pbp_mrx file ';
run;

proc freq data = out.pbp_mrx;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	part_d_model_demo
	part_d_enhncd_cvrg_demo
	mrx_form_model_type
	mrx_drug_ben_yn
	mrx_benefit_type
	mrx_ltc_attest_flag
	mrx_first_fill
	mrx_otc_meds_pay_ump_yn
	mrx_otc_meds_attest_flag
	mrx_formulary_tiers_num
	mrx_tier_form_ex
	mrx_tier_form_ex_2_yn
	mrx_ae_oon_cstshr_struct
	mrx_ae_cstshr_apply
	mrx_form_model_desc
	mrx_ae_ooptcs_apply
	mrx_alt_ded_charge
	mrx_alt_ded_type_yn
	mrx_alt_ded_tier_cstshr_yn
	mrx_alt_gen_cstshr_struct
	mrx_alt_oon_cstshr_struct
	mrx_alt_red_cost_sharing
	mrx_alt_red_cost_sharing_items
	mrx_alt_fulfill_desc
	mrx_alt_excl_drugs_yn
	mrx_alt_pre_icl_cost_share
	mrx_alt_pre_icl_exclud_only_yn
	mrx_alt_cstshr_post_oopt
	mrx_gen_loc_rstd
	mrx_gen_loc_oon
	mrx_gen_loc_mostd
	mrx_gen_loc_ltc
	mrx_tier_extd_days_gen_yn
	mrx_gen_extd_first_fill
	mrx_avg_exp_cost_share_attest
	mrx_snp_zerocost_attest
	mrx_vaccine_attest
	mrx_insulin_attest
/ missing;
run;

proc contents data = out.pbp_mrx;
  title 'pbp_mrx data';
run;