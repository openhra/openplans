*pbp_Section_D.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_Section_D;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_d_ann_deduct_yn              $1
	pbp_d_ann_deduct_amt_type        $1
	pbp_d_ann_deduct_comb_type       $1
	pbp_d_ann_deduct_14a_yn          $1
	pbp_d_ann_deduct_bens            $3
	pbp_d_ann_deduct_inn_mc_yn       $1
	pbp_d_ann_deduct_inn_mc_cats     $4000
	pbp_d_ann_deduct_inn_nmc_yn      $1
	pbp_d_ann_deduct_inn_nmc_cats    $4000
	pbp_d_ann_deduct_oon_nmc_yn      $1
	pbp_d_ann_deduct_oon_nmc_cats    $4000
	pbp_d_diff_deduct_yn             $1
	pbp_d_diff_deduct_cats           $4000
	pbp_d_nmc_deduct_yn              $1
	pbp_d_nmc_deduct_cats            $4000
	pbp_d_inn_deduct_yn              $1
	pbp_d_inn_deduct_partb_yn        $1
	pbp_d_inn_deduct_bens            $2
	pbp_d_inn_deduct_m_yn            $1
	pbp_d_inn_deduct_m_cats          $4000
	pbp_d_inn_deduct_nm_yn           $1
	pbp_d_inn_deduct_nm_cats         $4000
	pbp_d_comb_deduct_yn             $1
	pbp_d_comb_deduct_partb_yn       $1
	pbp_d_comb_deduct_bens           $4
	pbp_d_comb_deduct_inn_m_yn       $1
	pbp_d_comb_deduct_inn_m_cats     $4000
	pbp_d_comb_deduct_inn_nm_yn      $1
	pbp_d_comb_deduct_inn_nm_cats    $4000
	pbp_d_comb_deduct_oon_m_yn       $1
	pbp_d_comb_deduct_oon_m_cats     $4000
	pbp_d_comb_deduct_oon_nm_yn      $1
	pbp_d_comb_deduct_oon_nm_cats    $4000
	pbp_d_oon_deduct_yn              $1
	pbp_d_oon_deduct_partb_yn        $1
	pbp_d_oon_deduct_bens            $2
	pbp_d_oon_deduct_m_yn            $1
	pbp_d_oon_deduct_m_cats          $4000
	pbp_d_oon_deduct_nm_yn           $1
	pbp_d_oon_deduct_nm_cats         $4000
	pbp_d_non_deduct_yn              $1
	pbp_d_non_deduct_partb_yn        $1
	pbp_d_non_deduct_bens            $2
	pbp_d_non_deduct_m_yn            $1
	pbp_d_non_deduct_m_cats          $4000
	pbp_d_non_deduct_nm_yn           $1
	pbp_d_non_deduct_nm_cats         $4000
	pbp_d_out_pocket_amt_yn          $1
	pbp_d_out_pocket_amt_type        $1
	pbp_d_inn_max_enr_oopc_bens      $2
	pbp_d_inn_max_enr_m_yn           $1
	pbp_d_inn_max_enr_m_cat_ex       $4000
	pbp_d_inn_max_enr_nm_yn          $1
	pbp_d_inn_max_enr_nm_cat_ex      $4000
	pbp_d_comb_max_enr_amt_yn        $1
	pbp_d_comb_max_enr_amt_type      $1
	pbp_d_comb_max_enr_oopc_bens     $4
	pbp_d_comb_max_enr_inn_m_yn      $1
	pbp_d_comb_max_enr_inn_mcat_ex   $4000
	pbp_d_comb_max_enr_inn_nm_yn     $1
	pbp_d_comb_max_enr_inn_nmcatex   $4000
	pbp_d_comb_max_enr_oon_m_yn      $1
	pbp_d_comb_max_enr_oon_mcat_ex   $4000
	pbp_d_comb_max_enr_oon_nm_yn     $1
	pbp_d_comb_max_enr_oon_nmcatex   $4000
	pbp_d_oon_max_enr_oopc_yn        $1
	pbp_d_oon_max_enr_oopc_bens      $2
	pbp_d_oon_max_enr_m_yn           $1
	pbp_d_oon_max_enr_m_cat_ex       $4000
	pbp_d_oon_max_enr_nm_yn          $1
	pbp_d_oon_max_enr_nm_cat_ex      $4000
	pbp_d_maxenr_oopc_yn             $1
	pbp_d_maxenr_oopc_type           $1
	pbp_d_maxenr_oopc_bens           $2
	pbp_d_maxenr_oopc_m_cats_yn      $1
	pbp_d_maxenr_oopc_m_cats         $4000
	pbp_d_maxenr_oopc_nm_cats_yn     $1
	pbp_d_maxenr_oopc_nm_cats        $4000
	pbp_d_mco_pay_reduct_yn          $1
	pbp_d_balbill_yn                 $1
	pbp_d_balbill_prov_cats          $4000
	pbp_d_rics_yn                    $1
	pbp_d_rics_cnt                   $1
	pbp_d_rics_grp_name_1            $4000
	pbp_d_rics_cats_ehc_1            $2
	pbp_d_rics_mc_cats_1             $4000
	pbp_d_rics_nmc_cats_1            $4000
	pbp_d_rics_period_1              $1
	pbp_d_rics_period_d_1            $4000
	pbp_d_rics_comb_shr_yn_1         $1
	pbp_d_rics_comb_pkg_num_1        $4000
	pbp_d_rics_app_ded_yn_1          $1
	pbp_d_rics_mod_1                 $3
	pbp_d_rics_mod_1_d               $4000
	pbp_d_rics_grp_name_2            $4000
	pbp_d_rics_cats_ehc_2            $2
	pbp_d_rics_mc_cats_2             $4000
	pbp_d_rics_nmc_cats_2            $4000
	pbp_d_rics_period_2              $1
	pbp_d_rics_period_d_2            $4000
	pbp_d_rics_comb_shr_yn_2         $1
	pbp_d_rics_comb_pkg_num_2        $4000
	pbp_d_rics_app_ded_yn_2          $1
	pbp_d_rics_mod_2                 $3
	pbp_d_rics_mod_2_d               $4000
	pbp_d_rics_grp_name_3            $4000
	pbp_d_rics_cats_ehc_3            $2
	pbp_d_rics_mc_cats_3             $4000
	pbp_d_rics_nmc_cats_3            $4000
	pbp_d_rics_period_3              $1
	pbp_d_rics_period_d_3            $4000
	pbp_d_rics_comb_shr_yn_3         $1
	pbp_d_rics_comb_pkg_num_3        $4000
	pbp_d_rics_app_ded_yn_3          $1
	pbp_d_rics_mod_3                 $3
	pbp_d_rics_mod_3_d               $4000
	pbp_d_rics_grp_name_4            $4000
	pbp_d_rics_cats_ehc_4            $2
	pbp_d_rics_mc_cats_4             $4000
	pbp_d_rics_nmc_cats_4            $4000
	pbp_d_rics_period_4              $1
	pbp_d_rics_period_d_4            $4000
	pbp_d_rics_comb_shr_yn_4         $1
	pbp_d_rics_comb_pkg_num_4        $4000
	pbp_d_rics_app_ded_yn_4          $1
	pbp_d_rics_mod_4                 $3
	pbp_d_rics_mod_4_d               $4000
	pbp_d_rics_grp_name_5            $4000
	pbp_d_rics_cats_ehc_5            $2
	pbp_d_rics_mc_cats_5             $4000
	pbp_d_rics_nmc_cats_5            $4000
	pbp_d_rics_period_5              $1
	pbp_d_rics_period_d_5            $4000
	pbp_d_rics_comb_shr_yn_5         $1
	pbp_d_rics_comb_pkg_num_5        $4000
	pbp_d_rics_app_ded_yn_5          $1
	pbp_d_rics_mod_5                 $3
	pbp_d_rics_mod_5_d               $4000
	pbp_d_combo_supp_ben_yn          $1
	pbp_d_combo_num_grps             $1
	pbp_d_combo_grp_name_1           $4000
	pbp_d_combo_nmc_cats_1           $4000
	pbp_d_combo_mode_1               $5
	pbp_d_combo_mode_other_1         $4000
	pbp_d_combo_enrollee_lim_yn_1    $1
	pbp_d_combo_max_plan_ben_yn_1    $1
	pbp_d_combo_max_plan_period_1    $1
	pbp_d_combo_max_plan_prd_d_1     $4000
	pbp_d_combo_share_visit_yn_1     $1
	pbp_d_combo_shr_vst_period_1     $1
	pbp_d_combo_grp_name_2           $4000
	pbp_d_combo_nmc_cats_2           $4000
	pbp_d_combo_mode_2               $5
	pbp_d_combo_mode_other_2         $4000
	pbp_d_combo_enrollee_lim_yn_2    $1
	pbp_d_combo_max_plan_ben_yn_2    $1
	pbp_d_combo_max_plan_period_2    $1
	pbp_d_combo_max_plan_prd_d_2     $4000
	pbp_d_combo_share_visit_yn_2     $1
	pbp_d_combo_shr_vst_period_2     $1
	pbp_d_combo_grp_name_3           $4000
	pbp_d_combo_nmc_cats_3           $4000
	pbp_d_combo_mode_3               $5
	pbp_d_combo_mode_other_3         $4000
	pbp_d_combo_enrollee_lim_yn_3    $1
	pbp_d_combo_max_plan_ben_yn_3    $1
	pbp_d_combo_max_plan_period_3    $1
	pbp_d_combo_max_plan_prd_d_3     $4000
	pbp_d_combo_share_visit_yn_3     $1
	pbp_d_combo_shr_vst_period_3     $1
	pbp_d_combo_grp_name_4           $4000
	pbp_d_combo_nmc_cats_4           $4000
	pbp_d_combo_mode_4               $5
	pbp_d_combo_mode_other_4         $4000
	pbp_d_combo_enrollee_lim_yn_4    $1
	pbp_d_combo_max_plan_ben_yn_4    $1
	pbp_d_combo_max_plan_period_4    $1
	pbp_d_combo_max_plan_prd_d_4     $4000
	pbp_d_combo_share_visit_yn_4     $1
	pbp_d_combo_shr_vst_period_4     $1
	pbp_d_combo_grp_name_5           $4000
	pbp_d_combo_nmc_cats_5           $4000
	pbp_d_combo_mode_5               $5
	pbp_d_combo_mode_other_5         $4000
	pbp_d_combo_enrollee_lim_yn_5    $1
	pbp_d_combo_max_plan_ben_yn_5    $1
	pbp_d_combo_max_plan_period_5    $1
	pbp_d_combo_max_plan_prd_d_5     $4000
	pbp_d_combo_share_visit_yn_5     $1
	pbp_d_combo_shr_vst_period_5     $1
;

infile '.\pbp\pbp_Section_D.txt' delimiter = '09'x
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
	pbp_d_ann_deduct_yn
	pbp_d_ann_deduct_amt_type
	pbp_d_ann_deduct_amt
	pbp_d_ann_deduct_comb_type
	pbp_d_ann_deduct_14a_yn
	pbp_d_ann_deduct_bens
	pbp_d_ann_deduct_inn_mc_yn
	pbp_d_ann_deduct_inn_mc_cats
	pbp_d_ann_deduct_inn_nmc_yn
	pbp_d_ann_deduct_inn_nmc_cats
	pbp_d_ann_deduct_oon_nmc_yn
	pbp_d_ann_deduct_oon_nmc_cats
	pbp_d_diff_deduct_yn
	pbp_d_diff_deduct_cats
	pbp_d_diff_deduct_1a_t1_amt
	pbp_d_diff_deduct_1a_t2_amt
	pbp_d_diff_deduct_1a_t3_amt
	pbp_d_diff_deduct_1a_b_amt
	pbp_d_diff_deduct_1a1_amt
	pbp_d_diff_deduct_1a1_t2_amt
	pbp_d_diff_deduct_1a1_t3_amt
	pbp_d_diff_deduct_1a2_amt
	pbp_d_diff_deduct_1a3_amt
	pbp_d_diff_deduct_1b_t1_amt
	pbp_d_diff_deduct_1b_t2_amt
	pbp_d_diff_deduct_1b_t3_amt
	pbp_d_diff_deduct_1b_b_amt
	pbp_d_diff_deduct_1b1_amt
	pbp_d_diff_deduct_1b1_t2_amt
	pbp_d_diff_deduct_1b1_t3_amt
	pbp_d_diff_deduct_1b2_amt
	pbp_d_diff_deduct_2_t1_amt
	pbp_d_diff_deduct_2_t2_amt
	pbp_d_diff_deduct_2_t3_amt
	pbp_d_diff_deduct_2_b_amt
	pbp_d_diff_deduct_2_1_amt
	pbp_d_diff_deduct_2_1_t2_amt
	pbp_d_diff_deduct_2_1_t3_amt
	pbp_d_diff_deduct_3_1_amt
	pbp_d_diff_deduct_3_2_amt
	pbp_d_diff_deduct_3_3_amt
	pbp_d_diff_deduct_3_4_amt
	pbp_d_diff_deduct_3_1_nmc_amt
	pbp_d_diff_deduct_3_2_nmc_amt
	pbp_d_diff_deduct_3_3_nmc_amt
	pbp_d_diff_deduct_3_4_nmc_amt
	pbp_d_diff_deduct_4a_amt
	pbp_d_diff_deduct_4b_amt
	pbp_d_diff_deduct_4c1_amt
	pbp_d_diff_deduct_4c2_amt
	pbp_d_diff_deduct_4c3_amt
	pbp_d_diff_deduct_5_amt
	pbp_d_diff_deduct_5b_amt
	pbp_d_diff_deduct_6_amt
	pbp_d_diff_deduct_7a_amt
	pbp_d_diff_deduct_7b_amt
	pbp_d_diff_deduct_7b1_amt
	pbp_d_diff_deduct_7b2_amt
	pbp_d_diff_deduct_7c_amt
	pbp_d_diff_deduct_7d_amt
	pbp_d_diff_deduct_7e1_amt
	pbp_d_diff_deduct_7e2_amt
	pbp_d_diff_deduct_7f_amt
	pbp_d_diff_deduct_7f_nmc_amt
	pbp_d_diff_deduct_7g_amt
	pbp_d_diff_deduct_7h1_amt
	pbp_d_diff_deduct_7h2_amt
	pbp_d_diff_deduct_7i_amt
	pbp_d_diff_deduct_7j_amt
	pbp_d_diff_deduct_7k_amt
	pbp_d_diff_deduct_8a1_amt
	pbp_d_diff_deduct_8a2_amt
	pbp_d_diff_deduct_8b1_amt
	pbp_d_diff_deduct_8b2_amt
	pbp_d_diff_deduct_8b3_amt
	pbp_d_diff_deduct_9a1_amt
	pbp_d_diff_deduct_9a2_amt
	pbp_d_diff_deduct_9b_amt
	pbp_d_diff_deduct_9c1_amt
	pbp_d_diff_deduct_9c2_amt
	pbp_d_diff_deduct_9d_amt
	pbp_d_diff_deduct_10a1_amt
	pbp_d_diff_deduct_10a2_amt
	pbp_d_diff_deduct_10b1_amt
	pbp_d_diff_deduct_10b2_amt
	pbp_d_diff_deduct_11a_amt
	pbp_d_diff_deduct_11b1_amt
	pbp_d_diff_deduct_11b2_amt
	pbp_d_diff_deduct_11c1_amt
	pbp_d_diff_deduct_11c2_amt
	pbp_d_diff_deduct_12_amt
	pbp_d_diff_deduct_13a_amt
	pbp_d_diff_deduct_13b_amt
	pbp_d_diff_deduct_13c_amt
	pbp_d_diff_deduct_13d_amt
	pbp_d_diff_deduct_13e_amt
	pbp_d_diff_deduct_13f_amt
	pbp_d_diff_deduct_13g_amt
	pbp_d_diff_deduct_14a_amt
	pbp_d_diff_deduct_14b_amt
	pbp_d_diff_deduct_14c1_amt
	pbp_d_diff_deduct_14c2_amt
	pbp_d_diff_deduct_14c3_amt
	pbp_d_diff_deduct_14c4_amt
	pbp_d_diff_deduct_14c5_amt
	pbp_d_diff_deduct_14c6_amt
	pbp_d_diff_deduct_14c7_amt
	pbp_d_diff_deduct_14c8_amt
	pbp_d_diff_deduct_14c9_amt
	pbp_d_diff_deduct_14c10_amt
	pbp_d_diff_deduct_14c11_amt
	pbp_d_diff_deduct_14c12_amt
	pbp_d_diff_deduct_14c13_amt
	pbp_d_diff_deduct_14c14_amt
	pbp_d_diff_deduct_14c15_amt
	pbp_d_diff_deduct_14c16_amt
	pbp_d_diff_deduct_14c17_amt
	pbp_d_diff_deduct_14c18_amt
	pbp_d_diff_deduct_14c19_amt
	pbp_d_diff_deduct_14c20_amt
	pbp_d_diff_deduct_14c21_amt
	pbp_d_diff_deduct_14c22_amt
	pbp_d_diff_deduct_14d_amt
	pbp_d_diff_deduct_14e1_amt
	pbp_d_diff_deduct_14e2_amt
	pbp_d_diff_deduct_14e4_amt
	pbp_d_diff_deduct_14e5_amt
	pbp_d_diff_deduct_15_1_amt
	pbp_d_diff_deduct_15_2_amt
	pbp_d_diff_deduct_15_3_amt
	pbp_d_diff_deduct_15_nmc_amt
	pbp_d_diff_deduct_16a_n_amt
	pbp_d_diff_deduct_16b1_n_amt
	pbp_d_diff_deduct_16b2_n_amt
	pbp_d_diff_deduct_16b3_n_amt
	pbp_d_diff_deduct_16b4_n_amt
	pbp_d_diff_deduct_16b5_n_amt
	pbp_d_diff_deduct_16b6_n_amt
	pbp_d_diff_deduct_16c1_n_amt
	pbp_d_diff_deduct_16c2_n_amt
	pbp_d_diff_deduct_16c3_n_amt
	pbp_d_diff_deduct_16c4_n_amt
	pbp_d_diff_deduct_16c5_n_amt
	pbp_d_diff_deduct_16c6_n_amt
	pbp_d_diff_deduct_16c7_n_amt
	pbp_d_diff_deduct_16c8_n_amt
	pbp_d_diff_deduct_16c9_n_amt
	pbp_d_diff_deduct_16c10_n_amt
	pbp_d_diff_deduct_17a_amt
	pbp_d_diff_deduct_17a1_amt
	pbp_d_diff_deduct_17a2_amt
	pbp_d_diff_deduct_17b_amt
	pbp_d_diff_deduct_17b1_amt
	pbp_d_diff_deduct_17b2_amt
	pbp_d_diff_deduct_17b3_amt
	pbp_d_diff_deduct_17b4_amt
	pbp_d_diff_deduct_17b5_amt
	pbp_d_diff_deduct_18a_amt
	pbp_d_diff_deduct_18a1_amt
	pbp_d_diff_deduct_18a2_amt
	pbp_d_diff_deduct_18b1_amt
	pbp_d_diff_deduct_18b2_amt
	pbp_d_diff_deduct_18b3_amt
	pbp_d_diff_deduct_18b4_amt
	pbp_d_diff_deduct_18c_amt
	pbp_d_diff_deduct_20_amt
	pbp_d_nmc_deduct_yn
	pbp_d_nmc_deduct_cats
	pbp_d_deduct_iha_amt
	pbp_d_mand_deduct_1a1_amt
	pbp_d_mand_deduct_1a2_amt
	pbp_d_mand_deduct_1a3_amt
	pbp_d_deduct_ihp_amt
	pbp_d_mand_deduct_1b1_amt
	pbp_d_mand_deduct_1b2_amt
	pbp_d_deduct_snf_amt
	pbp_d_mand_deduct_2_1_amt
	pbp_d_mand_deduct_3_1_amt
	pbp_d_mand_deduct_3_2_amt
	pbp_d_mand_deduct_3_3_amt
	pbp_d_mand_deduct_3_4_amt
	pbp_d_mand_deduct_4c1_amt
	pbp_d_mand_deduct_4c2_amt
	pbp_d_mand_deduct_4c3_amt
	pbp_d_mand_deduct_7b1_amt
	pbp_d_mand_deduct_7b2_amt
	pbp_d_deduct_pod_amt
	pbp_d_mand_deduct_10b1_amt
	pbp_d_mand_deduct_10b2_amt
	pbp_d_deduct_acupunc_amt
	pbp_d_deduct_otc_amt
	pbp_d_deduct_meal_amt
	pbp_d_deduct_other1_amt
	pbp_d_deduct_other2_amt
	pbp_d_deduct_other3_amt
	pbp_d_deduct_dsnp_his_amt
	pbp_d_deduct_ape_amt
	pbp_d_mand_deduct_14c1_amt
	pbp_d_mand_deduct_14c2_amt
	pbp_d_mand_deduct_14c3_amt
	pbp_d_mand_deduct_14c4_amt
	pbp_d_mand_deduct_14c5_amt
	pbp_d_mand_deduct_14c6_amt
	pbp_d_mand_deduct_14c7_amt
	pbp_d_mand_deduct_14c8_amt
	pbp_d_mand_deduct_14c9_amt
	pbp_d_mand_deduct_14c10_amt
	pbp_d_mand_deduct_14c11_amt
	pbp_d_mand_deduct_14c12_amt
	pbp_d_mand_deduct_14c13_amt
	pbp_d_mand_deduct_14c14_amt
	pbp_d_mand_deduct_14c15_amt
	pbp_d_mand_deduct_14c16_amt
	pbp_d_mand_deduct_14c17_amt
	pbp_d_mand_deduct_14c18_amt
	pbp_d_mand_deduct_14c19_amt
	pbp_d_mand_deduct_14c20_amt
	pbp_d_mand_deduct_14c21_amt
	pbp_d_mand_deduct_14c22_amt
	pbp_d_mand_deduct_15_1_amt
	pbp_d_mand_deduct_16b1_n_amt
	pbp_d_mand_deduct_16b2_n_amt
	pbp_d_mand_deduct_16b3_n_amt
	pbp_d_mand_deduct_16b4_n_amt
	pbp_d_mand_deduct_16b5_n_amt
	pbp_d_mand_deduct_16b6_n_amt
	pbp_d_mand_deduct_16c1_n_amt
	pbp_d_mand_deduct_16c2_n_amt
	pbp_d_mand_deduct_16c3_n_amt
	pbp_d_mand_deduct_16c4_n_amt
	pbp_d_mand_deduct_16c5_n_amt
	pbp_d_mand_deduct_16c6_n_amt
	pbp_d_mand_deduct_16c7_n_amt
	pbp_d_mand_deduct_16c8_n_amt
	pbp_d_mand_deduct_16c9_n_amt
	pbp_d_mand_deduct_16c10_n_amt
	pbp_d_mand_deduct_17a1_amt
	pbp_d_mand_deduct_17a2_amt
	pbp_d_mand_deduct_17b1_amt
	pbp_d_mand_deduct_17b2_amt
	pbp_d_mand_deduct_17b3_amt
	pbp_d_mand_deduct_17b4_amt
	pbp_d_mand_deduct_17b5_amt
	pbp_d_mand_deduct_18a1_amt
	pbp_d_mand_deduct_18a2_amt
	pbp_d_mand_deduct_18b1_amt
	pbp_d_mand_deduct_18b2_amt
	pbp_d_mand_deduct_18b3_amt
	pbp_d_mand_deduct_18b4_amt
	pbp_d_mand_deduct_18c_amt
	pbp_d_inn_deduct_yn
	pbp_d_inn_deduct_partb_yn
	pbp_d_inn_deduct_amt
	pbp_d_inn_deduct_bens
	pbp_d_inn_deduct_m_yn
	pbp_d_inn_deduct_m_cats
	pbp_d_inn_deduct_nm_yn
	pbp_d_inn_deduct_nm_cats
	pbp_d_comb_deduct_yn
	pbp_d_comb_deduct_partb_yn
	pbp_d_comb_deduct_amt
	pbp_d_comb_deduct_bens
	pbp_d_comb_deduct_inn_m_yn
	pbp_d_comb_deduct_inn_m_cats
	pbp_d_comb_deduct_inn_nm_yn
	pbp_d_comb_deduct_inn_nm_cats
	pbp_d_comb_deduct_oon_m_yn
	pbp_d_comb_deduct_oon_m_cats
	pbp_d_comb_deduct_oon_nm_yn
	pbp_d_comb_deduct_oon_nm_cats
	pbp_d_oon_deduct_yn
	pbp_d_oon_deduct_partb_yn
	pbp_d_oon_deduct_amt
	pbp_d_oon_deduct_bens
	pbp_d_oon_deduct_m_yn
	pbp_d_oon_deduct_m_cats
	pbp_d_oon_deduct_nm_yn
	pbp_d_oon_deduct_nm_cats
	pbp_d_non_deduct_yn
	pbp_d_non_deduct_partb_yn
	pbp_d_non_deduct_amt
	pbp_d_non_deduct_bens
	pbp_d_non_deduct_m_yn
	pbp_d_non_deduct_m_cats
	pbp_d_non_deduct_nm_yn
	pbp_d_non_deduct_nm_cats
	pbp_d_out_pocket_amt_yn
	pbp_d_out_pocket_amt_type
	pbp_d_out_pocket_amt
	pbp_d_inn_max_enr_oopc_bens
	pbp_d_inn_max_enr_m_yn
	pbp_d_inn_max_enr_m_cat_ex
	pbp_d_inn_max_enr_nm_yn
	pbp_d_inn_max_enr_nm_cat_ex
	pbp_d_comb_max_enr_amt_yn
	pbp_d_comb_max_enr_amt_type
	pbp_d_comb_max_enr_amt
	pbp_d_comb_max_enr_oopc_bens
	pbp_d_comb_max_enr_inn_m_yn
	pbp_d_comb_max_enr_inn_mcat_ex
	pbp_d_comb_max_enr_inn_nm_yn
	pbp_d_comb_max_enr_inn_nmcatex
	pbp_d_comb_max_enr_oon_m_yn
	pbp_d_comb_max_enr_oon_mcat_ex
	pbp_d_comb_max_enr_oon_nm_yn
	pbp_d_comb_max_enr_oon_nmcatex
	pbp_d_oon_max_enr_oopc_yn
	pbp_d_oon_max_enr_oopc_amt
	pbp_d_oon_max_enr_oopc_bens
	pbp_d_oon_max_enr_m_yn
	pbp_d_oon_max_enr_m_cat_ex
	pbp_d_oon_max_enr_nm_yn
	pbp_d_oon_max_enr_nm_cat_ex
	pbp_d_maxenr_oopc_yn
	pbp_d_maxenr_oopc_type
	pbp_d_maxenr_oopc_amt
	pbp_d_maxenr_oopc_bens
	pbp_d_maxenr_oopc_m_cats_yn
	pbp_d_maxenr_oopc_m_cats
	pbp_d_maxenr_oopc_nm_cats_yn
	pbp_d_maxenr_oopc_nm_cats
	pbp_d_mplusc_premium
	pbp_d_mplusc_bonly_premium
	pbp_d_mco_pay_reduct_yn
	pbp_d_mco_pay_reduct_amt
	pbp_d_balbill_yn
	pbp_d_balbill_prov_cats
	pbp_d_balbill_min_pct
	pbp_d_balbill_max_pct
	pbp_d_msa_ded_amt
	pbp_d_msa_annual_amt
	pbp_d_rics_yn
	pbp_d_rics_cnt
	pbp_d_rics_grp_name_1
	pbp_d_rics_cats_ehc_1
	pbp_d_rics_mc_cats_1
	pbp_d_rics_nmc_cats_1
	pbp_d_rics_max_bene_amt_1
	pbp_d_rics_period_1
	pbp_d_rics_period_d_1
	pbp_d_rics_comb_shr_yn_1
	pbp_d_rics_comb_pkg_num_1
	pbp_d_rics_app_ded_yn_1
	pbp_d_rics_mod_1
	pbp_d_rics_mod_1_d
	pbp_d_rics_grp_name_2
	pbp_d_rics_cats_ehc_2
	pbp_d_rics_mc_cats_2
	pbp_d_rics_nmc_cats_2
	pbp_d_rics_max_bene_amt_2
	pbp_d_rics_period_2
	pbp_d_rics_period_d_2
	pbp_d_rics_comb_shr_yn_2
	pbp_d_rics_comb_pkg_num_2
	pbp_d_rics_app_ded_yn_2
	pbp_d_rics_mod_2
	pbp_d_rics_mod_2_d
	pbp_d_rics_grp_name_3
	pbp_d_rics_cats_ehc_3
	pbp_d_rics_mc_cats_3
	pbp_d_rics_nmc_cats_3
	pbp_d_rics_max_bene_amt_3
	pbp_d_rics_period_3
	pbp_d_rics_period_d_3
	pbp_d_rics_comb_shr_yn_3
	pbp_d_rics_comb_pkg_num_3
	pbp_d_rics_app_ded_yn_3
	pbp_d_rics_mod_3
	pbp_d_rics_mod_3_d
	pbp_d_rics_grp_name_4
	pbp_d_rics_cats_ehc_4
	pbp_d_rics_mc_cats_4
	pbp_d_rics_nmc_cats_4
	pbp_d_rics_max_bene_amt_4
	pbp_d_rics_period_4
	pbp_d_rics_period_d_4
	pbp_d_rics_comb_shr_yn_4
	pbp_d_rics_comb_pkg_num_4
	pbp_d_rics_app_ded_yn_4
	pbp_d_rics_mod_4
	pbp_d_rics_mod_4_d
	pbp_d_rics_grp_name_5
	pbp_d_rics_cats_ehc_5
	pbp_d_rics_mc_cats_5
	pbp_d_rics_nmc_cats_5
	pbp_d_rics_max_bene_amt_5
	pbp_d_rics_period_5
	pbp_d_rics_period_d_5
	pbp_d_rics_comb_shr_yn_5
	pbp_d_rics_comb_pkg_num_5
	pbp_d_rics_app_ded_yn_5
	pbp_d_rics_mod_5
	pbp_d_rics_mod_5_d
	pbp_d_combo_supp_ben_yn
	pbp_d_combo_num_grps
	pbp_d_combo_grp_name_1
	pbp_d_combo_nmc_cats_1
	pbp_d_combo_mode_1
	pbp_d_combo_mode_other_1
	pbp_d_combo_enrollee_lim_yn_1
	pbp_d_combo_max_plan_ben_yn_1
	pbp_d_combo_max_plan_ben_amt_1
	pbp_d_combo_max_plan_period_1
	pbp_d_combo_max_plan_prd_d_1
	pbp_d_combo_share_visit_yn_1
	pbp_d_combo_share_visit_amt_1
	pbp_d_combo_shr_vst_period_1
	pbp_d_combo_grp_name_2
	pbp_d_combo_nmc_cats_2
	pbp_d_combo_mode_2
	pbp_d_combo_mode_other_2
	pbp_d_combo_enrollee_lim_yn_2
	pbp_d_combo_max_plan_ben_yn_2
	pbp_d_combo_max_plan_ben_amt_2
	pbp_d_combo_max_plan_period_2
	pbp_d_combo_max_plan_prd_d_2
	pbp_d_combo_share_visit_yn_2
	pbp_d_combo_share_visit_amt_2
	pbp_d_combo_shr_vst_period_2
	pbp_d_combo_grp_name_3
	pbp_d_combo_nmc_cats_3
	pbp_d_combo_mode_3
	pbp_d_combo_mode_other_3
	pbp_d_combo_enrollee_lim_yn_3
	pbp_d_combo_max_plan_ben_yn_3
	pbp_d_combo_max_plan_ben_amt_3
	pbp_d_combo_max_plan_period_3
	pbp_d_combo_max_plan_prd_d_3
	pbp_d_combo_share_visit_yn_3
	pbp_d_combo_share_visit_amt_3
	pbp_d_combo_shr_vst_period_3
	pbp_d_combo_grp_name_4
	pbp_d_combo_nmc_cats_4
	pbp_d_combo_mode_4
	pbp_d_combo_mode_other_4
	pbp_d_combo_enrollee_lim_yn_4
	pbp_d_combo_max_plan_ben_yn_4
	pbp_d_combo_max_plan_ben_amt_4
	pbp_d_combo_max_plan_period_4
	pbp_d_combo_max_plan_prd_d_4
	pbp_d_combo_share_visit_yn_4
	pbp_d_combo_share_visit_amt_4
	pbp_d_combo_shr_vst_period_4
	pbp_d_combo_grp_name_5
	pbp_d_combo_nmc_cats_5
	pbp_d_combo_mode_5
	pbp_d_combo_mode_other_5
	pbp_d_combo_enrollee_lim_yn_5
	pbp_d_combo_max_plan_ben_yn_5
	pbp_d_combo_max_plan_ben_amt_5
	pbp_d_combo_max_plan_period_5
	pbp_d_combo_max_plan_prd_d_5
	pbp_d_combo_share_visit_yn_5
	pbp_d_combo_share_visit_amt_5
	pbp_d_combo_shr_vst_period_5
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
	pbp_d_ann_deduct_yn              = 'Deductible YN?'
	pbp_d_ann_deduct_amt_type        = 'Deduct Amt Type'
	pbp_d_ann_deduct_amt             = 'Deduct Amt'
	pbp_d_ann_deduct_comb_type       = 'Deduct Annual Combined AB Type'
	pbp_d_ann_deduct_14a_yn          = 'Deduct 14a Y/N'
	pbp_d_ann_deduct_bens            = 'Deduct Ben Cats'
	pbp_d_ann_deduct_inn_mc_yn       = 'Deduct Annual INN MC YN'
	pbp_d_ann_deduct_inn_mc_cats     = 'Deduct INN MC Cats'
	pbp_d_ann_deduct_inn_nmc_yn      = 'DeductAnnual INN NMC YN'
	pbp_d_ann_deduct_inn_nmc_cats    = 'Deduct INN NMC Cats'
	pbp_d_ann_deduct_oon_nmc_yn      = 'Deduct Annual Deduct OON NMC'
	pbp_d_ann_deduct_oon_nmc_cats    = 'Deduct OON NMC Cats'
	pbp_d_diff_deduct_yn             = 'Differential Deduct YN'
	pbp_d_diff_deduct_cats           = 'Differential Deduct Serv Cats'
	pbp_d_diff_deduct_1a_t1_amt      = 'Differential Deduct Amt 1a T1'
	pbp_d_diff_deduct_1a_t2_amt      = 'Differential Deduct Amt 1a T2'
	pbp_d_diff_deduct_1a_t3_amt      = 'Differential Deduct Amt 1a T3'
	pbp_d_diff_deduct_1a_b_amt       = 'Differential Deduct Amt 1a-B'
	pbp_d_diff_deduct_1a1_amt        = 'Differential Ded Amt 1A1 T1'
	pbp_d_diff_deduct_1a1_t2_amt     = 'Differential Ded Amt 1A1 T2'
	pbp_d_diff_deduct_1a1_t3_amt     = 'Differential Ded Amt 1A1 T3'
	pbp_d_diff_deduct_1a2_amt        = 'Differential Deduct Amt 1A2'
	pbp_d_diff_deduct_1a3_amt        = 'Differential Deduct Amt 1A3'
	pbp_d_diff_deduct_1b_t1_amt      = 'Differential Deduct Amt 1b T1'
	pbp_d_diff_deduct_1b_t2_amt      = 'Differential Deduct Amt 1b T2'
	pbp_d_diff_deduct_1b_t3_amt      = 'Differential Deduct Amt 1b T3'
	pbp_d_diff_deduct_1b_b_amt       = 'Differential Deduct Amt 1b-B'
	pbp_d_diff_deduct_1b1_amt        = 'Differential Ded Amt 1B1 T1'
	pbp_d_diff_deduct_1b1_t2_amt     = 'Differential Ded Amt 1B1 T2'
	pbp_d_diff_deduct_1b1_t3_amt     = 'Differential Ded Amt 1B1 T3'
	pbp_d_diff_deduct_1b2_amt        = 'Differential Deduct Amt 1B2'
	pbp_d_diff_deduct_2_t1_amt       = 'Differential Deduct Amt 2 T1'
	pbp_d_diff_deduct_2_t2_amt       = 'Differential Deduct Amt 2 T2'
	pbp_d_diff_deduct_2_t3_amt       = 'Differential Deduct Amt 2 T3'
	pbp_d_diff_deduct_2_b_amt        = 'Differential Deduct Amt 2-B'
	pbp_d_diff_deduct_2_1_amt        = 'Differential Ded Amt 2_1 T1'
	pbp_d_diff_deduct_2_1_t2_amt     = 'Differential Ded Amt 2_1 T2'
	pbp_d_diff_deduct_2_1_t3_amt     = 'Differential Ded Amt 2_1 T3'
	pbp_d_diff_deduct_3_1_amt        = 'Differential Deduct Amt 3_1'
	pbp_d_diff_deduct_3_2_amt        = 'Differential Deduct Amt 3_2'
	pbp_d_diff_deduct_3_3_amt        = 'Differential Deduct Amt 3_3'
	pbp_d_diff_deduct_3_4_amt        = 'Differential Deduct Amt 3_4'
	pbp_d_diff_deduct_3_1_nmc_amt    = 'Differential Deduct 3-1 NMC'
	pbp_d_diff_deduct_3_2_nmc_amt    = 'Differential Deduct 3-2 NMC'
	pbp_d_diff_deduct_3_3_nmc_amt    = 'Differential Deduct 3-3 NMC'
	pbp_d_diff_deduct_3_4_nmc_amt    = 'Differential Deduct 3-4 NMC'
	pbp_d_diff_deduct_4a_amt         = 'Differential Deduct Amt 4A'
	pbp_d_diff_deduct_4b_amt         = 'Differential Deduct Amt 4B'
	pbp_d_diff_deduct_4c1_amt        = 'Differential Deduct Amt 4C1'
	pbp_d_diff_deduct_4c2_amt        = 'Differential Deduct Amt 4C2'
	pbp_d_diff_deduct_4c3_amt        = 'Differential Deduct Amt 4C3'
	pbp_d_diff_deduct_5_amt          = 'Differential Deduct Amt 5a'
	pbp_d_diff_deduct_5b_amt         = 'Differential Deduct Amt 5b'
	pbp_d_diff_deduct_6_amt          = 'Differential Deduct Amt 6'
	pbp_d_diff_deduct_7a_amt         = 'Differential DeductAmt 7a'
	pbp_d_diff_deduct_7b_amt         = 'Differential Deduct Amt 7b'
	pbp_d_diff_deduct_7b1_amt        = 'Differential Deduct Amt 7B1'
	pbp_d_diff_deduct_7b2_amt        = 'Differential Deduct Amt 7B2'
	pbp_d_diff_deduct_7c_amt         = 'Differential Deduct Amt 7c'
	pbp_d_diff_deduct_7d_amt         = 'Differential Deduct Amt 7d'
	pbp_d_diff_deduct_7e1_amt        = 'Differential Deduct Amt 7E1'
	pbp_d_diff_deduct_7e2_amt        = 'Differential Deduct Amt 7E2'
	pbp_d_diff_deduct_7f_amt         = 'Differential Deduct Amt 7f'
	pbp_d_diff_deduct_7f_nmc_amt     = 'Differential Deduct Amt 7F NMC'
	pbp_d_diff_deduct_7g_amt         = 'Differential Deduct Amt 7g'
	pbp_d_diff_deduct_7h1_amt        = 'Differential Deduct Amt 7H1'
	pbp_d_diff_deduct_7h2_amt        = 'Differential Deduct Amt 7H2'
	pbp_d_diff_deduct_7i_amt         = 'Differential Deduct Amt 2'
	pbp_d_diff_deduct_7j_amt         = 'Differential Deduct Amt 7j'
	pbp_d_diff_deduct_7k_amt         = 'Differential Deduct Amt 7k'
	pbp_d_diff_deduct_8a1_amt        = 'Differential Deduct Amt 8A1'
	pbp_d_diff_deduct_8a2_amt        = 'Differential Deduct Amt 8A2'
	pbp_d_diff_deduct_8b1_amt        = 'Differential Deduct Amt 8B1'
	pbp_d_diff_deduct_8b2_amt        = 'Differential Deduct Amt 8B2'
	pbp_d_diff_deduct_8b3_amt        = 'Differential Deduct Amt 8B3'
	pbp_d_diff_deduct_9a1_amt        = 'Differential Deduct Amt 9a1'
	pbp_d_diff_deduct_9a2_amt        = 'Differential Deduct Amt 9a2'
	pbp_d_diff_deduct_9b_amt         = 'Differential Deduct Amt 9b'
	pbp_d_diff_deduct_9c1_amt        = 'Differential Deduct Amt 9C1'
	pbp_d_diff_deduct_9c2_amt        = 'Differential Deduct Amt 9C2'
	pbp_d_diff_deduct_9d_amt         = 'Differential Deduct Amt 9d'
	pbp_d_diff_deduct_10a1_amt       = 'Differential Deduct Amt 10a1'
	pbp_d_diff_deduct_10a2_amt       = 'Differential Deduct Amt 10a2'
	pbp_d_diff_deduct_10b1_amt       = 'Differential Deduct Amt 10B1'
	pbp_d_diff_deduct_10b2_amt       = 'Differential Deduct Amt 10B2'
	pbp_d_diff_deduct_11a_amt        = 'Differential Deduct Amt 11a'
	pbp_d_diff_deduct_11b1_amt       = 'Differential Deduct Amt 11B1'
	pbp_d_diff_deduct_11b2_amt       = 'Differential Deduct Amt 11B2'
	pbp_d_diff_deduct_11c1_amt       = 'Differential Deduct Amt 11C1'
	pbp_d_diff_deduct_11c2_amt       = 'Differential Deduct Amt 11C2'
	pbp_d_diff_deduct_12_amt         = 'Differential Deduct Amt 12'
	pbp_d_diff_deduct_13a_amt        = 'Differential Deduct Amt 131'
	pbp_d_diff_deduct_13b_amt        = 'Differential Deduct Amt 13b'
	pbp_d_diff_deduct_13c_amt        = 'Differential Deduct Amt 13c'
	pbp_d_diff_deduct_13d_amt        = 'Differential Deduct Amt 13d'
	pbp_d_diff_deduct_13e_amt        = 'Differential Deduct Amt 13e'
	pbp_d_diff_deduct_13f_amt        = 'Differential Deduct Amt 13f'
	pbp_d_diff_deduct_13g_amt        = 'Differential Deduct Amt 13g'
	pbp_d_diff_deduct_14a_amt        = 'Differential Deduct Amt 14A'
	pbp_d_diff_deduct_14b_amt        = 'Differential Deduct Amt 14b'
	pbp_d_diff_deduct_14c1_amt       = 'Differential Deduct Amt 14C1'
	pbp_d_diff_deduct_14c2_amt       = 'Differential Deduct Amt 14C2'
	pbp_d_diff_deduct_14c3_amt       = 'Differential Deduct Amt 14C3'
	pbp_d_diff_deduct_14c4_amt       = 'Differential Deduct Amt 14C4'
	pbp_d_diff_deduct_14c5_amt       = 'Differential Deduct Amt 14C5'
	pbp_d_diff_deduct_14c6_amt       = 'Differential Deduct Amt 14C6'
	pbp_d_diff_deduct_14c7_amt       = 'Differential Deduct Amt 14C7'
	pbp_d_diff_deduct_14c8_amt       = 'Differential Deduct Amt 14C8'
	pbp_d_diff_deduct_14c9_amt       = 'Differential Deduct Amt 14C9'
	pbp_d_diff_deduct_14c10_amt      = 'Differential Deduct Amt 14C10'
	pbp_d_diff_deduct_14c11_amt      = 'Differential Deduct Amt 14C11'
	pbp_d_diff_deduct_14c12_amt      = 'Differential Deduct Amt 14C12'
	pbp_d_diff_deduct_14c13_amt      = 'Differential Deduct Amt 14C13'
	pbp_d_diff_deduct_14c14_amt      = 'Differential Deduct Amt 14C14'
	pbp_d_diff_deduct_14c15_amt      = 'Differential Deduct Amt 14C15'
	pbp_d_diff_deduct_14c16_amt      = 'Differential Deduct Amt 14C16'
	pbp_d_diff_deduct_14c17_amt      = 'Differential Deduct Amt 14C17'
	pbp_d_diff_deduct_14c18_amt      = 'Differential Deduct Amt 14C18'
	pbp_d_diff_deduct_14c19_amt      = 'Differential Deduct Amt 14C19'
	pbp_d_diff_deduct_14c20_amt      = 'Differential Deduct Amt 14C20'
	pbp_d_diff_deduct_14c21_amt      = 'Differential Deduct Amt 14C21'
	pbp_d_diff_deduct_14c22_amt      = 'Differential Deduct Amt 14C22'
	pbp_d_diff_deduct_14d_amt        = 'Differential Deduct Amt 14d'
	pbp_d_diff_deduct_14e1_amt       = 'Differential Deduct 14e glauc'
	pbp_d_diff_deduct_14e2_amt       = 'Differential Deduct 14e diab'
	pbp_d_diff_deduct_14e4_amt       = 'Differential Deduct 14e dre'
	pbp_d_diff_deduct_14e5_amt       = 'Differential Deduct 14e ekg'
	pbp_d_diff_deduct_15_1_amt       = 'Differential Deduct Amt 15_1'
	pbp_d_diff_deduct_15_2_amt       = 'Differential Deduct Amt 15_2'
	pbp_d_diff_deduct_15_3_amt       = 'Differential Deduct Amt 15_3'
	pbp_d_diff_deduct_15_nmc_amt     = 'Differential Deduct Amt 15 NMC'
	pbp_d_diff_deduct_16a_n_amt      = 'Differential Deduct Amt 16A'
	pbp_d_diff_deduct_16b1_n_amt     = 'Differential Deduct Amt 16B1'
	pbp_d_diff_deduct_16b2_n_amt     = 'Differential Deduct Amt 16B2'
	pbp_d_diff_deduct_16b3_n_amt     = 'Differential Deduct Amt 16B3'
	pbp_d_diff_deduct_16b4_n_amt     = 'Differential Deduct Amt 16B4'
	pbp_d_diff_deduct_16b5_n_amt     = 'Differential Deduct Amt 16B5'
	pbp_d_diff_deduct_16b6_n_amt     = 'Differential Deduct Amt 16B6'
	pbp_d_diff_deduct_16c1_n_amt     = 'Differential Deduct Amt 16C1'
	pbp_d_diff_deduct_16c2_n_amt     = 'Differential Deduct Amt 16C2'
	pbp_d_diff_deduct_16c3_n_amt     = 'Differential Deduct Amt 16C3'
	pbp_d_diff_deduct_16c4_n_amt     = 'Differential Deduct Amt 16C4'
	pbp_d_diff_deduct_16c5_n_amt     = 'Differential Deduct Amt 16C5'
	pbp_d_diff_deduct_16c6_n_amt     = 'Differential Deduct Amt 16C6'
	pbp_d_diff_deduct_16c7_n_amt     = 'Differential Deduct Amt 16C7'
	pbp_d_diff_deduct_16c8_n_amt     = 'Differential Deduct Amt 16C8'
	pbp_d_diff_deduct_16c9_n_amt     = 'Differential Deduct Amt 16C9'
	pbp_d_diff_deduct_16c10_n_amt    = 'Differential Deduct Amt 16C10'
	pbp_d_diff_deduct_17a_amt        = 'Differential Deduct Amt 17a'
	pbp_d_diff_deduct_17a1_amt       = 'Differential Deduct Amt 17A1'
	pbp_d_diff_deduct_17a2_amt       = 'Differential Deduct Amt 17A2'
	pbp_d_diff_deduct_17b_amt        = 'Differential Deduct Amt 17b'
	pbp_d_diff_deduct_17b1_amt       = 'Differential Deduct Amt 17B1'
	pbp_d_diff_deduct_17b2_amt       = 'Differential Deduct Amt 17B2'
	pbp_d_diff_deduct_17b3_amt       = 'Differential Deduct Amt 17B3'
	pbp_d_diff_deduct_17b4_amt       = 'Differential Deduct Amt 17B4'
	pbp_d_diff_deduct_17b5_amt       = 'Differential Deduct Amt 17B5'
	pbp_d_diff_deduct_18a_amt        = 'Differential Deduct Amt 18a'
	pbp_d_diff_deduct_18a1_amt       = 'Differential Deduct Amt 18A1'
	pbp_d_diff_deduct_18a2_amt       = 'Differential Deduct Amt 18A2'
	pbp_d_diff_deduct_18b1_amt       = 'Differential Deduct Amt 18B1'
	pbp_d_diff_deduct_18b2_amt       = 'Differential Deduct Amt 18B2'
	pbp_d_diff_deduct_18b3_amt       = 'Differential Deduct Amt 18B3'
	pbp_d_diff_deduct_18b4_amt       = 'Differential Deduct Amt 18B4'
	pbp_d_diff_deduct_18c_amt        = 'Differential Deduct Amt 18C'
	pbp_d_diff_deduct_20_amt         = 'Differential Deduct Amt 20'
	pbp_d_nmc_deduct_yn              = 'Mandatory enhanced deduct YN'
	pbp_d_nmc_deduct_cats            = 'Mand NMC Deductible Categories'
	pbp_d_deduct_iha_amt             = 'Mand IHA B-only Deduct'
	pbp_d_mand_deduct_1a1_amt        = 'Mand Deductible Amt 1A11'
	pbp_d_mand_deduct_1a2_amt        = 'Mand Deductible Amt 1A2'
	pbp_d_mand_deduct_1a3_amt        = 'Mand Deductible Amt 1A3'
	pbp_d_deduct_ihp_amt             = 'Mand IHP B-only Deduct'
	pbp_d_mand_deduct_1b1_amt        = 'Mand Deductible Amt 1B1'
	pbp_d_mand_deduct_1b2_amt        = 'Mand Deductible Amt 1B2'
	pbp_d_deduct_snf_amt             = 'Mand SNF B-only Deduct'
	pbp_d_mand_deduct_2_1_amt        = 'Mand Deductible Amt 2_1'
	pbp_d_mand_deduct_3_1_amt        = 'Mand Deductible Amt 3_1'
	pbp_d_mand_deduct_3_2_amt        = 'Mand Deductible Amt 3_2'
	pbp_d_mand_deduct_3_3_amt        = 'Mand Deductible Amt 3_3'
	pbp_d_mand_deduct_3_4_amt        = 'Mand Deductible Amt 3_4'
	pbp_d_mand_deduct_4c1_amt        = 'Mand Deductible Amt 4C1'
	pbp_d_mand_deduct_4c2_amt        = 'Mand Deductible Amt 4C2'
	pbp_d_mand_deduct_4c3_amt        = 'Mand Deductible Amt 4C3'
	pbp_d_mand_deduct_7b1_amt        = 'Mand Deductible Amt 7B1'
	pbp_d_mand_deduct_7b2_amt        = 'Mand Deductible Amt 7B2'
	pbp_d_deduct_pod_amt             = 'Mand POD Deduct'
	pbp_d_mand_deduct_10b1_amt       = 'Mand Deductible Amt 10B1'
	pbp_d_mand_deduct_10b2_amt       = 'Mand Deductible Amt 10B2'
	pbp_d_deduct_acupunc_amt         = 'Mand ACUPUNC Deduct amt'
	pbp_d_deduct_otc_amt             = 'Mand OTC Deduct amt'
	pbp_d_deduct_meal_amt            = 'Mand MEAL Deduct amt'
	pbp_d_deduct_other1_amt          = 'Mand OTHER1 Deduct amt'
	pbp_d_deduct_other2_amt          = 'Mand OTHER2 Deduct amt'
	pbp_d_deduct_other3_amt          = 'Mand OTHER3 Deduct amt'
	pbp_d_deduct_dsnp_his_amt        = 'Mand DSNP HIS Deduct amt'
	pbp_d_deduct_ape_amt             = 'Mand APE Deduct amt'
	pbp_d_mand_deduct_14c1_amt       = 'Mand Deductible Amt 14C1'
	pbp_d_mand_deduct_14c2_amt       = 'Mand Deductible Amt 14C2'
	pbp_d_mand_deduct_14c3_amt       = 'Mand Deductible Amt 14C3'
	pbp_d_mand_deduct_14c4_amt       = 'Mand Deductible Amt 14C4'
	pbp_d_mand_deduct_14c5_amt       = 'Mand Deductible Amt 14C5'
	pbp_d_mand_deduct_14c6_amt       = 'Mand Deductible Amt 14C6'
	pbp_d_mand_deduct_14c7_amt       = 'Mand Deductible Amt 14C7'
	pbp_d_mand_deduct_14c8_amt       = 'Mand Deductible Amt 14C8'
	pbp_d_mand_deduct_14c9_amt       = 'Mand Deductible Amt 14C9'
	pbp_d_mand_deduct_14c10_amt      = 'Mand Deductible Amt 14C10'
	pbp_d_mand_deduct_14c11_amt      = 'Mand Deductible Amt 14C11'
	pbp_d_mand_deduct_14c12_amt      = 'Mand Deductible Amt 14C12'
	pbp_d_mand_deduct_14c13_amt      = 'Mand Deductible Amt 14C13'
	pbp_d_mand_deduct_14c14_amt      = 'Mand Deductible Amt 14C14'
	pbp_d_mand_deduct_14c15_amt      = 'Mand Deductible Amt 14C15'
	pbp_d_mand_deduct_14c16_amt      = 'Mand Deductible Amt 14C16'
	pbp_d_mand_deduct_14c17_amt      = 'Mand Deductible Amt 14C17'
	pbp_d_mand_deduct_14c18_amt      = 'Mand Deductible Amt 14C18'
	pbp_d_mand_deduct_14c19_amt      = 'Mand Deductible Amt 14C19'
	pbp_d_mand_deduct_14c20_amt      = 'Mand Deductible Amt 14C20'
	pbp_d_mand_deduct_14c21_amt      = 'Mand Deductible Amt 14C21'
	pbp_d_mand_deduct_14c22_amt      = 'Mand Deductible Amt 14C22'
	pbp_d_mand_deduct_15_1_amt       = 'Mand Deductible Amt 15 NMC'
	pbp_d_mand_deduct_16b1_n_amt     = 'Mand Deductible Amt 16B1'
	pbp_d_mand_deduct_16b2_n_amt     = 'Mand Deductible Amt 16B2'
	pbp_d_mand_deduct_16b3_n_amt     = 'Mand Deductible Amt 16B3'
	pbp_d_mand_deduct_16b4_n_amt     = 'Mand Deductible Amt 16B4'
	pbp_d_mand_deduct_16b5_n_amt     = 'Mand Deductible Amt 16B5'
	pbp_d_mand_deduct_16b6_n_amt     = 'Mand Deductible Amt 16B6'
	pbp_d_mand_deduct_16c1_n_amt     = 'Mand Deductible Amt 16C1'
	pbp_d_mand_deduct_16c2_n_amt     = 'Mand Deductible Amt 16C2'
	pbp_d_mand_deduct_16c3_n_amt     = 'Mand Deductible Amt 16C3'
	pbp_d_mand_deduct_16c4_n_amt     = 'Mand Deductible Amt 16C4'
	pbp_d_mand_deduct_16c5_n_amt     = 'Mand Deductible Amt 16C5'
	pbp_d_mand_deduct_16c6_n_amt     = 'Mand Deductible Amt 16C6'
	pbp_d_mand_deduct_16c7_n_amt     = 'Mand Deductible Amt 16C7'
	pbp_d_mand_deduct_16c8_n_amt     = 'Mand Deductible Amt 16C8'
	pbp_d_mand_deduct_16c9_n_amt     = 'Mand Deductible Amt 16C9'
	pbp_d_mand_deduct_16c10_n_amt    = 'Mand Deductible Amt 16C10'
	pbp_d_mand_deduct_17a1_amt       = 'Mand Deductible Amt 17A1'
	pbp_d_mand_deduct_17a2_amt       = 'Mand Deductible Amt 17A2'
	pbp_d_mand_deduct_17b1_amt       = 'Mand Deductible Amt 17B1'
	pbp_d_mand_deduct_17b2_amt       = 'Mand Deductible Amt 17B2'
	pbp_d_mand_deduct_17b3_amt       = 'Mand Deductible Amt 17B3'
	pbp_d_mand_deduct_17b4_amt       = 'Mand Deductible Amt 17B4'
	pbp_d_mand_deduct_17b5_amt       = 'Mand Deductible Amt 17B5'
	pbp_d_mand_deduct_18a1_amt       = 'Mand Deductible Amt 18A1'
	pbp_d_mand_deduct_18a2_amt       = 'Mand Deductible Amt 18A2'
	pbp_d_mand_deduct_18b1_amt       = 'Mand Deductible Amt 18B1'
	pbp_d_mand_deduct_18b2_amt       = 'Mand Deductible Amt 18B2'
	pbp_d_mand_deduct_18b3_amt       = 'Mand Deductible Amt 18B3'
	pbp_d_mand_deduct_18b4_amt       = 'Mand Deductible Amt 18B4'
	pbp_d_mand_deduct_18c_amt        = 'Mand Deductible Amt 18C'
	pbp_d_inn_deduct_yn              = 'In-Ntwk Plan Deductible YN'
	pbp_d_inn_deduct_partb_yn        = 'In-Ntwk Ded Mdcr PartB YN'
	pbp_d_inn_deduct_amt             = 'In-Ntwk Ded Amt'
	pbp_d_inn_deduct_bens            = 'In-Ntwk Ded benefit'
	pbp_d_inn_deduct_m_yn            = 'In-Ntwk Ded All Inn Mdcr YN'
	pbp_d_inn_deduct_m_cats          = 'In-Ntwk Ded Serv Cats Med-Cov'
	pbp_d_inn_deduct_nm_yn           = 'In-Ntwk Ded All Inn NM YN'
	pbp_d_inn_deduct_nm_cats         = 'In-Ntwk Ded Cats Non Med-Cov'
	pbp_d_comb_deduct_yn             = 'Comb Ded YN'
	pbp_d_comb_deduct_partb_yn       = 'Comb Ded Mdcr PartB YN'
	pbp_d_comb_deduct_amt            = 'Comb Ded Amt'
	pbp_d_comb_deduct_bens           = 'Comb Ded benefit'
	pbp_d_comb_deduct_inn_m_yn       = 'Comb Ded All Inn Mdcr YN'
	pbp_d_comb_deduct_inn_m_cats     = 'Comb Ded Serv Cats Med-Cov'
	pbp_d_comb_deduct_inn_nm_yn      = 'Comb Ded All Inn NM YN'
	pbp_d_comb_deduct_inn_nm_cats    = 'Comb Ded Serv Cats Non Med-Cov'
	pbp_d_comb_deduct_oon_m_yn       = 'Comb Ded All OON Mdcr YN'
	pbp_d_comb_deduct_oon_m_cats     = 'Comb Ded OON Serv Cats Med-Cov'
	pbp_d_comb_deduct_oon_nm_yn      = 'Comb Ded All OON NM YN'
	pbp_d_comb_deduct_oon_nm_cats    = 'Comb Ded OON Cats Non Med-Cov'
	pbp_d_oon_deduct_yn              = 'OON Ded YN'
	pbp_d_oon_deduct_partb_yn        = 'OON Ded Mdcr PartB YN'
	pbp_d_oon_deduct_amt             = 'OON Ded Amt'
	pbp_d_oon_deduct_bens            = 'OON Ded benefit'
	pbp_d_oon_deduct_m_yn            = 'OON Ded All OON Mdcr YN'
	pbp_d_oon_deduct_m_cats          = 'OON Ded Serv Cats Med-Cov'
	pbp_d_oon_deduct_nm_yn           = 'OON Ded All OON NM YN'
	pbp_d_oon_deduct_nm_cats         = 'OON Ded Srev Cats Non Med-Cov'
	pbp_d_non_deduct_yn              = 'NON Ded YN'
	pbp_d_non_deduct_partb_yn        = 'NON Ded In-Net Mdcr PartB YN'
	pbp_d_non_deduct_amt             = 'NON Ded Amt'
	pbp_d_non_deduct_bens            = 'NON Ded In Net Ded benefit'
	pbp_d_non_deduct_m_yn            = 'NON Ded All Inn Mdcr YN'
	pbp_d_non_deduct_m_cats          = 'NON Ded Serv Cats Med-Cov'
	pbp_d_non_deduct_nm_yn           = 'NON Ded All Inn NM YN'
	pbp_d_non_deduct_nm_cats         = 'NON Ded Serv Cats Non Med-Cov'
	pbp_d_out_pocket_amt_yn          = 'In-Ntwk Max Enr Amt YN'
	pbp_d_out_pocket_amt_type        = 'In-Ntwk Max Enr Amt Type'
	pbp_d_out_pocket_amt             = 'In-Ntwk Max Enr Amt'
	pbp_d_inn_max_enr_oopc_bens      = 'In-Ntwk Max Enr In Net benefit'
	pbp_d_inn_max_enr_m_yn           = 'In-Ntwk Max Enr In-Net OOP'
	pbp_d_inn_max_enr_m_cat_ex       = 'In-Ntwk Max Enr Inn Inn M Cats'
	pbp_d_inn_max_enr_nm_yn          = 'In-Ntwk Max Enr In-Net Non'
	pbp_d_inn_max_enr_nm_cat_ex      = 'In-Ntwk Max Enr Serv Cats'
	pbp_d_comb_max_enr_amt_yn        = 'Comb Max Enrolee OON YN?'
	pbp_d_comb_max_enr_amt_type      = 'Comb Max Enr Amt TYPE'
	pbp_d_comb_max_enr_amt           = 'Comb Max Enr Amt'
	pbp_d_comb_max_enr_oopc_bens     = 'Comb Max Enr benefit'
	pbp_d_comb_max_enr_inn_m_yn      = 'Comb Max Enr In-Net'
	pbp_d_comb_max_enr_inn_mcat_ex   = 'Comb Max Enr INN M Cats'
	pbp_d_comb_max_enr_inn_nm_yn     = 'Comb Max Enr  OOPC In-Net Non'
	pbp_d_comb_max_enr_inn_nmcatex   = 'Comb Max Enr Serv Cats'
	pbp_d_comb_max_enr_oon_m_yn      = 'Comb Max Enr Out-Net'
	pbp_d_comb_max_enr_oon_mcat_ex   = 'Comb Max Enr OON M Cats'
	pbp_d_comb_max_enr_oon_nm_yn     = 'Comb Max Enr Out-Net Non'
	pbp_d_comb_max_enr_oon_nmcatex   = 'Comb Max Enr OON NM Cats'
	pbp_d_oon_max_enr_oopc_yn        = 'OON Max Enr Amt YN'
	pbp_d_oon_max_enr_oopc_amt       = 'OON Max Enr Amt'
	pbp_d_oon_max_enr_oopc_bens      = 'OON Max Enr benefit'
	pbp_d_oon_max_enr_m_yn           = 'OON Max Enr YN'
	pbp_d_oon_max_enr_m_cat_ex       = 'OON Max Enr Med-Cov Cats'
	pbp_d_oon_max_enr_nm_yn          = 'OON Max Enr OOPC Non Med-Cov'
	pbp_d_oon_max_enr_nm_cat_ex      = 'OON Max Enr Non Med-Cov Cats'
	pbp_d_maxenr_oopc_yn             = 'NON Max Enr Amt YN'
	pbp_d_maxenr_oopc_type           = 'NON OOPC Max Enr Amt Type'
	pbp_d_maxenr_oopc_amt            = 'NON OOPC Max Enr Amt'
	pbp_d_maxenr_oopc_bens           = 'NON OOPC Max Non Net PFFS Ben'
	pbp_d_maxenr_oopc_m_cats_yn      = 'NON OOPC Max Enr All MC YN'
	pbp_d_maxenr_oopc_m_cats         = 'NON OOPC Max Enr MC Serv Cats'
	pbp_d_maxenr_oopc_nm_cats_yn     = 'NON OOPC Max Enr NM YN'
	pbp_d_maxenr_oopc_nm_cats        = 'NON OOPC Max NM Serv Cats'
	pbp_d_mplusc_premium             = 'Premium Indicate Plan Amt (AB)'
	pbp_d_mplusc_bonly_premium       = 'Premium Indicate Plan Amt (B)'
	pbp_d_mco_pay_reduct_yn          = 'Premium MA Reduce Part B YN'
	pbp_d_mco_pay_reduct_amt         = 'Premium Part B Reduction Amt'
	pbp_d_balbill_yn                 = 'Balance Bill YN'
	pbp_d_balbill_prov_cats          = 'Balance Bill Serv Cats Pln Ded'
	pbp_d_balbill_min_pct            = 'Balance Bill Min'
	pbp_d_balbill_max_pct            = 'Balance Bill Max'
	pbp_d_msa_ded_amt                = 'MSA Ded Amt'
	pbp_d_msa_annual_amt             = 'MSA Annual Deposit Amt'
	pbp_d_rics_yn                    = 'D RICS Reduce Cst Shr YN'
	pbp_d_rics_cnt                   = 'D RICS Number Groups'
	pbp_d_rics_grp_name_1            = 'D RICS Grp 1 Name'
	pbp_d_rics_cats_ehc_1            = 'D RICS Grp 1 Bene Type 1'
	pbp_d_rics_mc_cats_1             = 'D RICS Grp 1 Medicare Cats'
	pbp_d_rics_nmc_cats_1            = 'D RICS Grp 1 NMC Cats'
	pbp_d_rics_max_bene_amt_1        = 'D RICS Grp 1 Max Bene Amt'
	pbp_d_rics_period_1              = 'D RICS Grp 1 Periodicity'
	pbp_d_rics_period_d_1            = 'D RICS Grp 1 Period desc'
	pbp_d_rics_comb_shr_yn_1         = 'D RICS Grp 1 Comb Share Pkg YN'
	pbp_d_rics_comb_pkg_num_1        = 'D RICS Grp 1 Comb Share Pkg #'
	pbp_d_rics_app_ded_yn_1          = 'D RICS Grp 1 Deduct Applies YN'
	pbp_d_rics_mod_1                 = 'D RICS Grp 1 Deliver Mode'
	pbp_d_rics_mod_1_d               = 'D RICS Grp 1 Deliver Mode Desc'
	pbp_d_rics_grp_name_2            = 'D RICS Grp 2 Name'
	pbp_d_rics_cats_ehc_2            = 'D RICS Grp 2 Bene Type 2'
	pbp_d_rics_mc_cats_2             = 'D RICS Grp 2 Medicare Cats'
	pbp_d_rics_nmc_cats_2            = 'D RICS Grp 2 NMC Cats'
	pbp_d_rics_max_bene_amt_2        = 'D RICS Grp 2 Max Bene Amt'
	pbp_d_rics_period_2              = 'D RICS Grp 2 Periodicity'
	pbp_d_rics_period_d_2            = 'D RICS Grp 2 Period desc'
	pbp_d_rics_comb_shr_yn_2         = 'D RICS Grp 2 Comb Share Pkg YN'
	pbp_d_rics_comb_pkg_num_2        = 'D RICS Grp 2 Comb Share Pkg #'
	pbp_d_rics_app_ded_yn_2          = 'D RICS Grp 2 Deduct Applies YN'
	pbp_d_rics_mod_2                 = 'D RICS Grp 2 Deliver Mode'
	pbp_d_rics_mod_2_d               = 'D RICS Grp 2 Deliver Mode Desc'
	pbp_d_rics_grp_name_3            = 'D RICS Grp 3 Name'
	pbp_d_rics_cats_ehc_3            = 'D RICS Grp 3 Bene Type 3'
	pbp_d_rics_mc_cats_3             = 'D RICS Grp 3 Medicare Cats'
	pbp_d_rics_nmc_cats_3            = 'D RICS Grp 3 NMC Cats'
	pbp_d_rics_max_bene_amt_3        = 'D RICS Grp 3 Max Bene Amt'
	pbp_d_rics_period_3              = 'D RICS Grp 3 Periodicity'
	pbp_d_rics_period_d_3            = 'D RICS Grp 3 Period desc'
	pbp_d_rics_comb_shr_yn_3         = 'D RICS Grp 3 Comb Share Pkg YN'
	pbp_d_rics_comb_pkg_num_3        = 'D RICS Grp 3 Comb Share Pkg #'
	pbp_d_rics_app_ded_yn_3          = 'D RICS Grp 3 Deduct Applies YN'
	pbp_d_rics_mod_3                 = 'D RICS Grp 3 Deliver Mode'
	pbp_d_rics_mod_3_d               = 'D RICS Grp 3 Deliver Mode Desc'
	pbp_d_rics_grp_name_4            = 'D RICS Grp 4 Name'
	pbp_d_rics_cats_ehc_4            = 'D RICS Grp 4 Bene Type 4'
	pbp_d_rics_mc_cats_4             = 'D RICS Grp 4 Medicare Cats'
	pbp_d_rics_nmc_cats_4            = 'D RICS Grp 4 NMC Cats'
	pbp_d_rics_max_bene_amt_4        = 'D RICS Grp 4 Max Bene Amt'
	pbp_d_rics_period_4              = 'D RICS Grp 4 Periodicity'
	pbp_d_rics_period_d_4            = 'D RICS Grp 4 Period desc'
	pbp_d_rics_comb_shr_yn_4         = 'D RICS Grp 4 Comb Share Pkg YN'
	pbp_d_rics_comb_pkg_num_4        = 'D RICS Grp 4 Comb Share Pkg #'
	pbp_d_rics_app_ded_yn_4          = 'D RICS Grp 4 Deduct Applies YN'
	pbp_d_rics_mod_4                 = 'D RICS Grp 4 Deliver Mode'
	pbp_d_rics_mod_4_d               = 'D RICS Grp 4 Deliver Mode Desc'
	pbp_d_rics_grp_name_5            = 'D RICS Grp 5 Name'
	pbp_d_rics_cats_ehc_5            = 'D RICS Grp 5 Bene Type 5'
	pbp_d_rics_mc_cats_5             = 'D RICS Grp 5 Medicare Cats'
	pbp_d_rics_nmc_cats_5            = 'D RICS Grp 5 NMC Cats'
	pbp_d_rics_max_bene_amt_5        = 'D RICS Grp 5 Max Bene Amt'
	pbp_d_rics_period_5              = 'D RICS Grp 5 Periodicity'
	pbp_d_rics_period_d_5            = 'D RICS Grp 5 Period desc'
	pbp_d_rics_comb_shr_yn_5         = 'D RICS Grp 5 Comb Share Pkg YN'
	pbp_d_rics_comb_pkg_num_5        = 'D RICS Grp 5 Comb Share Pkg #'
	pbp_d_rics_app_ded_yn_5          = 'D RICS Grp 5 Deduct Applies YN'
	pbp_d_rics_mod_5                 = 'D RICS Grp 5 Deliver Mode'
	pbp_d_rics_mod_5_d               = 'D RICS Grp 5 Deliver Mode Desc'
	pbp_d_combo_supp_ben_yn          = 'Combined Bene Offered YN'
	pbp_d_combo_num_grps             = 'Combined Bene Num Groups'
	pbp_d_combo_grp_name_1           = 'Comb Grp 1 Name'
	pbp_d_combo_nmc_cats_1           = 'Comb Grp 1 NMC Category'
	pbp_d_combo_mode_1               = 'Comb Grp 1 Deliver Mode'
	pbp_d_combo_mode_other_1         = 'Comb Grp 1 Mode Other'
	pbp_d_combo_enrollee_lim_yn_1    = 'Comb Grp 1 Enrollee Limit'
	pbp_d_combo_max_plan_ben_yn_1    = 'Comb Grp 1 Max Bene YN'
	pbp_d_combo_max_plan_ben_amt_1   = 'Comb Grp 1 Max Bene Amt'
	pbp_d_combo_max_plan_period_1    = 'Comb Grp 1 Max Bene Period'
	pbp_d_combo_max_plan_prd_d_1     = 'Comb Grp 1 Max Period Desc'
	pbp_d_combo_share_visit_yn_1     = 'Comb Grp 1 Share Visit/Trip'
	pbp_d_combo_share_visit_amt_1    = 'Comb Grp 1 Share Visit/Trip #'
	pbp_d_combo_shr_vst_period_1     = 'Comb Grp 1 Shr Visit/Trip Perd'
	pbp_d_combo_grp_name_2           = 'Comb Grp 2 Name'
	pbp_d_combo_nmc_cats_2           = 'Comb Grp 2 NMC Category'
	pbp_d_combo_mode_2               = 'Comb Grp 2 Deliver Mode'
	pbp_d_combo_mode_other_2         = 'Comb Grp 2 Mode Other'
	pbp_d_combo_enrollee_lim_yn_2    = 'Comb Grp 2 Enrollee Limit'
	pbp_d_combo_max_plan_ben_yn_2    = 'Comb Grp 2 Max Bene YN'
	pbp_d_combo_max_plan_ben_amt_2   = 'Comb Grp 2 Max Bene Amt'
	pbp_d_combo_max_plan_period_2    = 'Comb Grp 2 Max Bene Period'
	pbp_d_combo_max_plan_prd_d_2     = 'Comb Grp 2 Max Period Desc'
	pbp_d_combo_share_visit_yn_2     = 'Comb Grp 2 Share Visit YN'
	pbp_d_combo_share_visit_amt_2    = 'Comb Grp 2 Share Visit #'
	pbp_d_combo_shr_vst_period_2     = 'Comb Grp 2 Share Visit Period'
	pbp_d_combo_grp_name_3           = 'Comb Grp 3 Name'
	pbp_d_combo_nmc_cats_3           = 'Comb Grp 3 NMC Category'
	pbp_d_combo_mode_3               = 'Comb Grp 3 Deliver Mode'
	pbp_d_combo_mode_other_3         = 'Comb Grp 3 Mode Other'
	pbp_d_combo_enrollee_lim_yn_3    = 'Comb Grp 3 Enrollee Limit'
	pbp_d_combo_max_plan_ben_yn_3    = 'Comb Grp 3 Max Bene YN'
	pbp_d_combo_max_plan_ben_amt_3   = 'Comb Grp 3 Max Bene Amt'
	pbp_d_combo_max_plan_period_3    = 'Comb Grp 3 Max Bene Period'
	pbp_d_combo_max_plan_prd_d_3     = 'Comb Grp 3 Max Period Desc'
	pbp_d_combo_share_visit_yn_3     = 'Comb Grp 3 Share Visit YN'
	pbp_d_combo_share_visit_amt_3    = 'Comb Grp 3 Share Visit #'
	pbp_d_combo_shr_vst_period_3     = 'Comb Grp 3 Share Visit Period'
	pbp_d_combo_grp_name_4           = 'Comb Grp 4 Name'
	pbp_d_combo_nmc_cats_4           = 'Comb Grp 4 NMC Category'
	pbp_d_combo_mode_4               = 'Comb Grp 4 Deliver Mode'
	pbp_d_combo_mode_other_4         = 'Comb Grp 4 Mode Other'
	pbp_d_combo_enrollee_lim_yn_4    = 'Comb Grp 4 Enrollee Limit'
	pbp_d_combo_max_plan_ben_yn_4    = 'Comb Grp 4 Max Bene YN'
	pbp_d_combo_max_plan_ben_amt_4   = 'Comb Grp 4 Max Bene Amt'
	pbp_d_combo_max_plan_period_4    = 'Comb Grp 4 Max Bene Period'
	pbp_d_combo_max_plan_prd_d_4     = 'Comb Grp 4 Max Period Desc'
	pbp_d_combo_share_visit_yn_4     = 'Comb Grp 4 Share Visit YN'
	pbp_d_combo_share_visit_amt_4    = 'Comb Grp 4 Share Visit #'
	pbp_d_combo_shr_vst_period_4     = 'Comb Grp 4 Share Visit Period'
	pbp_d_combo_grp_name_5           = 'Comb Grp 5 Name'
	pbp_d_combo_nmc_cats_5           = 'Comb Grp 5 NMC Category'
	pbp_d_combo_mode_5               = 'Comb Grp 5 Deliver Mode'
	pbp_d_combo_mode_other_5         = 'Comb Grp 5 Mode Other'
	pbp_d_combo_enrollee_lim_yn_5    = 'Comb Grp 5 Enrollee Limit'
	pbp_d_combo_max_plan_ben_yn_5    = 'Comb Grp 5 Max Bene YN'
	pbp_d_combo_max_plan_ben_amt_5   = 'Comb Grp 5 Max Bene Amt'
	pbp_d_combo_max_plan_period_5    = 'Comb Grp 5 Max Bene Period'
	pbp_d_combo_max_plan_prd_d_5     = 'Comb Grp 5 Max Period Desc'
	pbp_d_combo_share_visit_yn_5     = 'Comb Grp 5 Share Visit YN'
	pbp_d_combo_share_visit_amt_5    = 'Comb Grp 5 Share Visit #'
	pbp_d_combo_shr_vst_period_5     = 'Comb Grp 5 Share Visit Period'
;

run;

proc sort data = pbp_Section_D out=out.pbp_Section_D;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_Section_D(obs = 10);
  title 'pbp_Section_D file ';
run;

proc means data = out.pbp_Section_D;
  title 'pbp_Section_D file ';
run;

proc freq data = out.pbp_Section_D;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_d_ann_deduct_yn
	pbp_d_ann_deduct_amt_type
	pbp_d_ann_deduct_comb_type
	pbp_d_ann_deduct_14a_yn
	pbp_d_ann_deduct_bens
	pbp_d_ann_deduct_inn_mc_yn
	pbp_d_ann_deduct_inn_nmc_yn
	pbp_d_ann_deduct_oon_nmc_yn
	pbp_d_diff_deduct_yn
	pbp_d_nmc_deduct_yn
	pbp_d_inn_deduct_yn
	pbp_d_inn_deduct_partb_yn
	pbp_d_inn_deduct_bens
	pbp_d_inn_deduct_m_yn
	pbp_d_inn_deduct_nm_yn
	pbp_d_comb_deduct_yn
	pbp_d_comb_deduct_partb_yn
	pbp_d_comb_deduct_bens
	pbp_d_comb_deduct_inn_m_yn
	pbp_d_comb_deduct_inn_nm_yn
	pbp_d_comb_deduct_oon_m_yn
	pbp_d_comb_deduct_oon_nm_yn
	pbp_d_oon_deduct_yn
	pbp_d_oon_deduct_partb_yn
	pbp_d_oon_deduct_bens
	pbp_d_oon_deduct_m_yn
	pbp_d_oon_deduct_nm_yn
	pbp_d_non_deduct_yn
	pbp_d_non_deduct_partb_yn
	pbp_d_non_deduct_bens
	pbp_d_non_deduct_m_yn
	pbp_d_non_deduct_nm_yn
	pbp_d_out_pocket_amt_yn
	pbp_d_out_pocket_amt_type
	pbp_d_inn_max_enr_oopc_bens
	pbp_d_inn_max_enr_m_yn
	pbp_d_inn_max_enr_nm_yn
	pbp_d_comb_max_enr_amt_yn
	pbp_d_comb_max_enr_amt_type
	pbp_d_comb_max_enr_oopc_bens
	pbp_d_comb_max_enr_inn_m_yn
	pbp_d_comb_max_enr_inn_nm_yn
	pbp_d_comb_max_enr_oon_m_yn
	pbp_d_comb_max_enr_oon_nm_yn
	pbp_d_oon_max_enr_oopc_yn
	pbp_d_oon_max_enr_oopc_bens
	pbp_d_oon_max_enr_m_yn
	pbp_d_oon_max_enr_nm_yn
	pbp_d_maxenr_oopc_yn
	pbp_d_maxenr_oopc_type
	pbp_d_maxenr_oopc_bens
	pbp_d_maxenr_oopc_m_cats_yn
	pbp_d_maxenr_oopc_nm_cats_yn
	pbp_d_mco_pay_reduct_yn
	pbp_d_balbill_yn
	pbp_d_rics_yn
	pbp_d_rics_cnt
	pbp_d_rics_cats_ehc_1
	pbp_d_rics_period_1
	pbp_d_rics_comb_shr_yn_1
	pbp_d_rics_app_ded_yn_1
	pbp_d_rics_mod_1
	pbp_d_rics_cats_ehc_2
	pbp_d_rics_period_2
	pbp_d_rics_comb_shr_yn_2
	pbp_d_rics_app_ded_yn_2
	pbp_d_rics_mod_2
	pbp_d_rics_cats_ehc_3
	pbp_d_rics_period_3
	pbp_d_rics_comb_shr_yn_3
	pbp_d_rics_app_ded_yn_3
	pbp_d_rics_mod_3
	pbp_d_rics_cats_ehc_4
	pbp_d_rics_period_4
	pbp_d_rics_comb_shr_yn_4
	pbp_d_rics_app_ded_yn_4
	pbp_d_rics_mod_4
	pbp_d_rics_cats_ehc_5
	pbp_d_rics_period_5
	pbp_d_rics_comb_shr_yn_5
	pbp_d_rics_app_ded_yn_5
	pbp_d_rics_mod_5
	pbp_d_combo_supp_ben_yn
	pbp_d_combo_num_grps
	pbp_d_combo_mode_1
	pbp_d_combo_enrollee_lim_yn_1
	pbp_d_combo_max_plan_ben_yn_1
	pbp_d_combo_max_plan_period_1
	pbp_d_combo_share_visit_yn_1
	pbp_d_combo_shr_vst_period_1
	pbp_d_combo_mode_2
	pbp_d_combo_enrollee_lim_yn_2
	pbp_d_combo_max_plan_ben_yn_2
	pbp_d_combo_max_plan_period_2
	pbp_d_combo_share_visit_yn_2
	pbp_d_combo_shr_vst_period_2
	pbp_d_combo_mode_3
	pbp_d_combo_enrollee_lim_yn_3
	pbp_d_combo_max_plan_ben_yn_3
	pbp_d_combo_max_plan_period_3
	pbp_d_combo_share_visit_yn_3
	pbp_d_combo_shr_vst_period_3
	pbp_d_combo_mode_4
	pbp_d_combo_enrollee_lim_yn_4
	pbp_d_combo_max_plan_ben_yn_4
	pbp_d_combo_max_plan_period_4
	pbp_d_combo_share_visit_yn_4
	pbp_d_combo_shr_vst_period_4
	pbp_d_combo_mode_5
	pbp_d_combo_enrollee_lim_yn_5
	pbp_d_combo_max_plan_ben_yn_5
	pbp_d_combo_max_plan_period_5
	pbp_d_combo_share_visit_yn_5
	pbp_d_combo_shr_vst_period_5
/ missing;
run;

proc contents data = out.pbp_Section_D;
  title 'pbp_Section_D data';
run;