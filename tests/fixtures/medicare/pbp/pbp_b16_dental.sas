*pbp_b16_dental.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b16;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b16a_maxenr_mc_yn            $1
	pbp_b16a_maxenr_mc_per           $1
	pbp_b16a_maxenr_mc_per_desc      $4000
	pbp_b16a_coins_mc_yn             $1
	pbp_b16a_copay_mc_yn             $1
	pbp_b16a_ded_mc_yn               $1
	pbp_b16a_auth_mc_yn              $1
	pbp_b16a_refer_mc_yn             $1
	pbp_b16b_maxplan_pv_yn           $1
	pbp_b16b_maxplan_pv_in_oon       $1
	pbp_b16b_maxplan_pv_per          $1
	pbp_b16b_maxplan_pv_per_desc     $4000
	pbp_b16b_maxenr_pv_yn            $1
	pbp_b16b_maxenr_pv_per           $1
	pbp_b16b_maxenr_pv_per_desc      $4000
	pbp_b16b_coins_ov_yn             $1
	pbp_b16b_coins_ov_svcs           $6
	pbp_b16b_copay_ov_yn             $1
	pbp_b16b_copay_ov_svcs           $6
	pbp_b16b_ded_pv_yn               $1
	pbp_b16b_bendesc_oe_amo          $1
	pbp_b16b_bendesc_oe_lim          $1
	pbp_b16b_bendesc_oe_per          $1
	pbp_b16b_bendesc_oe_desc         $4000
	pbp_b16b_coins_oe_yn             $1
	pbp_b16b_copay_oe_yn             $1
	pbp_b16b_auth_oe_yn              $1
	pbp_b16b_refer_oe_yn             $1
	pbp_b16b_bendesc_dx_amo          $1
	pbp_b16b_bendesc_dx_lim          $1
	pbp_b16b_bendesc_dx_per          $1
	pbp_b16b_bendesc_dx_desc         $4000
	pbp_b16b_coins_dx_yn             $1
	pbp_b16b_copay_dx_yn             $1
	pbp_b16b_auth_dx_yn              $1
	pbp_b16b_refer_dx_yn             $1
	pbp_b16b_bendesc_ods_amo         $1
	pbp_b16b_bendesc_ods_lim         $1
	pbp_b16b_bendesc_ods_per         $1
	pbp_b16b_bendesc_ods_desc        $4000
	pbp_b16b_coins_ods_yn            $1
	pbp_b16b_copay_ods_yn            $1
	pbp_b16b_auth_ods_yn             $1
	pbp_b16b_refer_ods_yn            $1
	pbp_b16b_bendesc_pc_amo          $1
	pbp_b16b_bendesc_pc_lim          $1
	pbp_b16b_bendesc_pc_per          $1
	pbp_b16b_bendesc_pc_desc         $4000
	pbp_b16b_coins_pc_yn             $1
	pbp_b16b_copay_pc_yn             $1
	pbp_b16b_auth_pc_yn              $1
	pbp_b16b_refer_pc_yn             $1
	pbp_b16b_bendesc_ft_amo          $1
	pbp_b16b_bendesc_ft_lim          $1
	pbp_b16b_bendesc_ft_per          $1
	pbp_b16b_bendesc_ft_desc         $4000
	pbp_b16b_coins_ft_yn             $1
	pbp_b16b_copay_ft_yn             $1
	pbp_b16b_auth_ft_yn              $1
	pbp_b16b_refer_ft_yn             $1
	pbp_b16b_bendesc_ops_amo         $1
	pbp_b16b_bendesc_ops_lim         $1
	pbp_b16b_bendesc_ops_per         $1
	pbp_b16b_bendesc_ops_desc        $4000
	pbp_b16b_coins_ops_yn            $1
	pbp_b16b_copay_ops_yn            $1
	pbp_b16b_auth_ops_yn             $1
	pbp_b16b_refer_ops_yn            $1
	pbp_b16c_maxplan_cmp_yn          $1
	pbp_b16c_maxplan_cmp_type        $1
	pbp_b16c_maxplan_cmp_in_oon      $1
	pbp_b16c_maxplan_cmp_per         $1
	pbp_b16c_maxplan_cmp_per_desc    $4000
	pbp_b16c_maxenr_cmp_yn           $1
	pbp_b16c_maxenr_cmp_type         $1
	pbp_b16c_maxenr_cmp_per          $1
	pbp_b16c_maxenr_cmp_per_desc     $4000
	pbp_b16c_ded_cmp_yn              $1
	pbp_b16c_bendesc_rs_amo          $1
	pbp_b16c_bendesc_rs_lim          $1
	pbp_b16c_bendesc_rs_per          $1
	pbp_b16c_bendesc_rs_desc         $4000
	pbp_b16c_coins_rs_yn             $1
	pbp_b16c_copay_rs_yn             $1
	pbp_b16c_auth_rs_yn              $1
	pbp_b16c_refer_rs_yn             $1
	pbp_b16c_bendesc_end_amo         $1
	pbp_b16c_bendesc_end_lim         $1
	pbp_b16c_bendesc_end_per         $1
	pbp_b16c_bendesc_end_desc        $4000
	pbp_b16c_coins_end_yn            $1
	pbp_b16c_copay_end_yn            $1
	pbp_b16c_auth_end_yn             $1
	pbp_b16c_refer_end_yn            $1
	pbp_b16c_bendesc_peri_amo        $1
	pbp_b16c_bendesc_peri_lim        $1
	pbp_b16c_bendesc_peri_per        $1
	pbp_b16c_bendesc_peri_desc       $4000
	pbp_b16c_coins_peri_yn           $1
	pbp_b16c_copay_peri_yn           $1
	pbp_b16c_auth_peri_yn            $1
	pbp_b16c_refer_peri_yn           $1
	pbp_b16c_bendesc_prm_amo         $1
	pbp_b16c_bendesc_prm_lim         $1
	pbp_b16c_bendesc_prm_per         $1
	pbp_b16c_bendesc_prm_desc        $4000
	pbp_b16c_coins_prm_yn            $1
	pbp_b16c_copay_prm_yn            $1
	pbp_b16c_auth_prm_yn             $1
	pbp_b16c_refer_prm_yn            $1
	pbp_b16c_bendesc_mxpr_amo        $1
	pbp_b16c_bendesc_mxpr_lim        $1
	pbp_b16c_bendesc_mxpr_per        $1
	pbp_b16c_bendesc_mxpr_desc       $4000
	pbp_b16c_coins_mxpr_yn           $1
	pbp_b16c_copay_mxpr_yn           $1
	pbp_b16c_auth_mxpr_yn            $1
	pbp_b16c_refer_mxpr_yn           $1
	pbp_b16c_bendesc_impl_amo        $1
	pbp_b16c_bendesc_impl_lim        $1
	pbp_b16c_bendesc_impl_per        $1
	pbp_b16c_bendesc_impl_desc       $4000
	pbp_b16c_coins_impl_yn           $1
	pbp_b16c_copay_impl_yn           $1
	pbp_b16c_auth_impl_yn            $1
	pbp_b16c_refer_impl_yn           $1
	pbp_b16c_bendesc_prf_amo         $1
	pbp_b16c_bendesc_prf_lim         $1
	pbp_b16c_bendesc_prf_per         $1
	pbp_b16c_bendesc_prf_desc        $4000
	pbp_b16c_coins_prf_yn            $1
	pbp_b16c_copay_prf_yn            $1
	pbp_b16c_auth_prf_yn             $1
	pbp_b16c_refer_prf_yn            $1
	pbp_b16c_bendesc_omsg_amo        $1
	pbp_b16c_bendesc_omsg_lim        $1
	pbp_b16c_bendesc_omsg_per        $1
	pbp_b16c_bendesc_omsg_desc       $4000
	pbp_b16c_coins_omsg_yn           $1
	pbp_b16c_copay_omsg_yn           $1
	pbp_b16c_auth_omsg_yn            $1
	pbp_b16c_refer_omsg_yn           $1
	pbp_b16c_bendesc_orth_amo        $1
	pbp_b16c_bendesc_orth_lim        $1
	pbp_b16c_bendesc_orth_per        $1
	pbp_b16c_bendesc_orth_desc       $4000
	pbp_b16c_coins_orth_yn           $1
	pbp_b16c_copay_orth_yn           $1
	pbp_b16c_auth_orth_yn            $1
	pbp_b16c_refer_orth_yn           $1
	pbp_b16c_bendesc_ags_amo         $1
	pbp_b16c_bendesc_ags_lim         $1
	pbp_b16c_bendesc_ags_per         $1
	pbp_b16c_bendesc_ags_desc        $4000
	pbp_b16c_coins_ags_yn            $1
	pbp_b16c_copay_ags_yn            $1
	pbp_b16c_auth_ags_yn             $1
	pbp_b16c_refer_ags_yn            $1
;

infile '.\pbp\pbp_b16_dental.txt' delimiter = '09'x
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
	pbp_b16a_maxenr_mc_yn
	pbp_b16a_maxenr_mc_amt
	pbp_b16a_maxenr_mc_per
	pbp_b16a_maxenr_mc_per_desc
	pbp_b16a_coins_mc_yn
	pbp_b16a_coins_mc_pct
	pbp_b16a_coins_mc_pct_min
	pbp_b16a_coins_mc_pct_max
	pbp_b16a_copay_mc_yn
	pbp_b16a_copay_mc_amt
	pbp_b16a_copay_mc_amt_min
	pbp_b16a_copay_mc_amt_max
	pbp_b16a_ded_mc_yn
	pbp_b16a_ded_mc_amt
	pbp_b16a_auth_mc_yn
	pbp_b16a_refer_mc_yn
	pbp_b16b_maxplan_pv_yn
	pbp_b16b_maxplan_pv_in_oon
	pbp_b16b_maxplan_pv_amt
	pbp_b16b_maxplan_pv_per
	pbp_b16b_maxplan_pv_per_desc
	pbp_b16b_maxenr_pv_yn
	pbp_b16b_maxenr_pv_amt
	pbp_b16b_maxenr_pv_per
	pbp_b16b_maxenr_pv_per_desc
	pbp_b16b_coins_ov_yn
	pbp_b16b_coins_ov_svcs
	pbp_b16b_coins_ov_pct
	pbp_b16b_coins_ov_pct_min
	pbp_b16b_coins_ov_pct_max
	pbp_b16b_copay_ov_yn
	pbp_b16b_copay_ov_svcs
	pbp_b16b_copay_ov_amt
	pbp_b16b_copay_ov_amt_min
	pbp_b16b_copay_ov_amt_max
	pbp_b16b_ded_pv_yn
	pbp_b16b_ded_pv_amt
	pbp_b16b_bendesc_oe_amo
	pbp_b16b_bendesc_oe_lim
	pbp_b16b_bendesc_oe_num
	pbp_b16b_bendesc_oe_per
	pbp_b16b_bendesc_oe_desc
	pbp_b16b_coins_oe_yn
	pbp_b16b_coins_oe_pct
	pbp_b16b_coins_oe_pct_min
	pbp_b16b_coins_oe_pct_max
	pbp_b16b_copay_oe_yn
	pbp_b16b_copay_oe_amt
	pbp_b16b_copay_oe_amt_min
	pbp_b16b_copay_oe_amt_max
	pbp_b16b_auth_oe_yn
	pbp_b16b_refer_oe_yn
	pbp_b16b_bendesc_dx_amo
	pbp_b16b_bendesc_dx_lim
	pbp_b16b_bendesc_dx_num
	pbp_b16b_bendesc_dx_per
	pbp_b16b_bendesc_dx_desc
	pbp_b16b_coins_dx_yn
	pbp_b16b_coins_dx_pct
	pbp_b16b_coins_dx_pct_min
	pbp_b16b_coins_dx_pct_max
	pbp_b16b_copay_dx_yn
	pbp_b16b_copay_dx_amt
	pbp_b16b_copay_dx_amt_min
	pbp_b16b_copay_dx_amt_max
	pbp_b16b_auth_dx_yn
	pbp_b16b_refer_dx_yn
	pbp_b16b_bendesc_ods_amo
	pbp_b16b_bendesc_ods_lim
	pbp_b16b_bendesc_ods_num
	pbp_b16b_bendesc_ods_per
	pbp_b16b_bendesc_ods_desc
	pbp_b16b_coins_ods_yn
	pbp_b16b_coins_ods_pct
	pbp_b16b_coins_ods_pct_min
	pbp_b16b_coins_ods_pct_max
	pbp_b16b_copay_ods_yn
	pbp_b16b_copay_ods_amt
	pbp_b16b_copay_ods_amt_min
	pbp_b16b_copay_ods_amt_max
	pbp_b16b_auth_ods_yn
	pbp_b16b_refer_ods_yn
	pbp_b16b_bendesc_pc_amo
	pbp_b16b_bendesc_pc_lim
	pbp_b16b_bendesc_pc_num
	pbp_b16b_bendesc_pc_per
	pbp_b16b_bendesc_pc_desc
	pbp_b16b_coins_pc_yn
	pbp_b16b_coins_pc_pct
	pbp_b16b_coins_pc_pct_min
	pbp_b16b_coins_pc_pct_max
	pbp_b16b_copay_pc_yn
	pbp_b16b_copay_pc_amt
	pbp_b16b_copay_pc_amt_min
	pbp_b16b_copay_pc_amt_max
	pbp_b16b_auth_pc_yn
	pbp_b16b_refer_pc_yn
	pbp_b16b_bendesc_ft_amo
	pbp_b16b_bendesc_ft_lim
	pbp_b16b_bendesc_ft_num
	pbp_b16b_bendesc_ft_per
	pbp_b16b_bendesc_ft_desc
	pbp_b16b_coins_ft_yn
	pbp_b16b_coins_ft_pct
	pbp_b16b_coins_ft_pct_min
	pbp_b16b_coins_ft_pct_max
	pbp_b16b_copay_ft_yn
	pbp_b16b_copay_ft_amt
	pbp_b16b_copay_ft_amt_min
	pbp_b16b_copay_ft_amt_max
	pbp_b16b_auth_ft_yn
	pbp_b16b_refer_ft_yn
	pbp_b16b_bendesc_ops_amo
	pbp_b16b_bendesc_ops_lim
	pbp_b16b_bendesc_ops_num
	pbp_b16b_bendesc_ops_per
	pbp_b16b_bendesc_ops_desc
	pbp_b16b_coins_ops_yn
	pbp_b16b_coins_ops_pct
	pbp_b16b_coins_ops_pct_min
	pbp_b16b_coins_ops_pct_max
	pbp_b16b_copay_ops_yn
	pbp_b16b_copay_ops_amt
	pbp_b16b_copay_ops_amt_min
	pbp_b16b_copay_ops_amt_max
	pbp_b16b_auth_ops_yn
	pbp_b16b_refer_ops_yn
	pbp_b16c_maxplan_cmp_yn
	pbp_b16c_maxplan_cmp_type
	pbp_b16c_maxplan_cmp_in_oon
	pbp_b16c_maxplan_cmp_amt
	pbp_b16c_maxplan_cmp_per
	pbp_b16c_maxplan_cmp_per_desc
	pbp_b16c_maxenr_cmp_yn
	pbp_b16c_maxenr_cmp_type
	pbp_b16c_maxenr_cmp_amt
	pbp_b16c_maxenr_cmp_per
	pbp_b16c_maxenr_cmp_per_desc
	pbp_b16c_ded_cmp_yn
	pbp_b16c_ded_cmp_amt
	pbp_b16c_bendesc_rs_amo
	pbp_b16c_bendesc_rs_lim
	pbp_b16c_bendesc_rs_num
	pbp_b16c_bendesc_rs_per
	pbp_b16c_bendesc_rs_desc
	pbp_b16c_coins_rs_yn
	pbp_b16c_coins_rs_pct
	pbp_b16c_coins_rs_pct_min
	pbp_b16c_coins_rs_pct_max
	pbp_b16c_copay_rs_yn
	pbp_b16c_copay_rs_amt
	pbp_b16c_copay_rs_amt_min
	pbp_b16c_copay_rs_amt_max
	pbp_b16c_auth_rs_yn
	pbp_b16c_refer_rs_yn
	pbp_b16c_bendesc_end_amo
	pbp_b16c_bendesc_end_lim
	pbp_b16c_bendesc_end_num
	pbp_b16c_bendesc_end_per
	pbp_b16c_bendesc_end_desc
	pbp_b16c_coins_end_yn
	pbp_b16c_coins_end_pct
	pbp_b16c_coins_end_pct_min
	pbp_b16c_coins_end_pct_max
	pbp_b16c_copay_end_yn
	pbp_b16c_copay_end_amt
	pbp_b16c_copay_end_amt_min
	pbp_b16c_copay_end_amt_max
	pbp_b16c_auth_end_yn
	pbp_b16c_refer_end_yn
	pbp_b16c_bendesc_peri_amo
	pbp_b16c_bendesc_peri_lim
	pbp_b16c_bendesc_peri_num
	pbp_b16c_bendesc_peri_per
	pbp_b16c_bendesc_peri_desc
	pbp_b16c_coins_peri_yn
	pbp_b16c_coins_peri_pct
	pbp_b16c_coins_peri_pct_min
	pbp_b16c_coins_peri_pct_max
	pbp_b16c_copay_peri_yn
	pbp_b16c_copay_peri_amt
	pbp_b16c_copay_peri_amt_min
	pbp_b16c_copay_peri_amt_max
	pbp_b16c_auth_peri_yn
	pbp_b16c_refer_peri_yn
	pbp_b16c_bendesc_prm_amo
	pbp_b16c_bendesc_prm_lim
	pbp_b16c_bendesc_prm_num
	pbp_b16c_bendesc_prm_per
	pbp_b16c_bendesc_prm_desc
	pbp_b16c_coins_prm_yn
	pbp_b16c_coins_prm_pct
	pbp_b16c_coins_prm_pct_min
	pbp_b16c_coins_prm_pct_max
	pbp_b16c_copay_prm_yn
	pbp_b16c_copay_prm_amt
	pbp_b16c_copay_prm_amt_min
	pbp_b16c_copay_prm_amt_max
	pbp_b16c_auth_prm_yn
	pbp_b16c_refer_prm_yn
	pbp_b16c_bendesc_mxpr_amo
	pbp_b16c_bendesc_mxpr_lim
	pbp_b16c_bendesc_mxpr_num
	pbp_b16c_bendesc_mxpr_per
	pbp_b16c_bendesc_mxpr_desc
	pbp_b16c_coins_mxpr_yn
	pbp_b16c_coins_mxpr_pct
	pbp_b16c_coins_mxpr_pct_min
	pbp_b16c_coins_mxpr_pct_max
	pbp_b16c_copay_mxpr_yn
	pbp_b16c_copay_mxpr_amt
	pbp_b16c_copay_mxpr_amt_min
	pbp_b16c_copay_mxpr_amt_max
	pbp_b16c_auth_mxpr_yn
	pbp_b16c_refer_mxpr_yn
	pbp_b16c_bendesc_impl_amo
	pbp_b16c_bendesc_impl_lim
	pbp_b16c_bendesc_impl_num
	pbp_b16c_bendesc_impl_per
	pbp_b16c_bendesc_impl_desc
	pbp_b16c_coins_impl_yn
	pbp_b16c_coins_impl_pct
	pbp_b16c_coins_impl_pct_min
	pbp_b16c_coins_impl_pct_max
	pbp_b16c_copay_impl_yn
	pbp_b16c_copay_impl_amt
	pbp_b16c_copay_impl_amt_min
	pbp_b16c_copay_impl_amt_max
	pbp_b16c_auth_impl_yn
	pbp_b16c_refer_impl_yn
	pbp_b16c_bendesc_prf_amo
	pbp_b16c_bendesc_prf_lim
	pbp_b16c_bendesc_prf_num
	pbp_b16c_bendesc_prf_per
	pbp_b16c_bendesc_prf_desc
	pbp_b16c_coins_prf_yn
	pbp_b16c_coins_prf_pct
	pbp_b16c_coins_prf_pct_min
	pbp_b16c_coins_prf_pct_max
	pbp_b16c_copay_prf_yn
	pbp_b16c_copay_prf_amt
	pbp_b16c_copay_prf_amt_min
	pbp_b16c_copay_prf_amt_max
	pbp_b16c_auth_prf_yn
	pbp_b16c_refer_prf_yn
	pbp_b16c_bendesc_omsg_amo
	pbp_b16c_bendesc_omsg_lim
	pbp_b16c_bendesc_omsg_num
	pbp_b16c_bendesc_omsg_per
	pbp_b16c_bendesc_omsg_desc
	pbp_b16c_coins_omsg_yn
	pbp_b16c_coins_omsg_pct
	pbp_b16c_coins_omsg_pct_min
	pbp_b16c_coins_omsg_pct_max
	pbp_b16c_copay_omsg_yn
	pbp_b16c_copay_omsg_amt
	pbp_b16c_copay_omsg_amt_min
	pbp_b16c_copay_omsg_amt_max
	pbp_b16c_auth_omsg_yn
	pbp_b16c_refer_omsg_yn
	pbp_b16c_bendesc_orth_amo
	pbp_b16c_bendesc_orth_lim
	pbp_b16c_bendesc_orth_num
	pbp_b16c_bendesc_orth_per
	pbp_b16c_bendesc_orth_desc
	pbp_b16c_coins_orth_yn
	pbp_b16c_coins_orth_pct
	pbp_b16c_coins_orth_pct_min
	pbp_b16c_coins_orth_pct_max
	pbp_b16c_copay_orth_yn
	pbp_b16c_copay_orth_amt
	pbp_b16c_copay_orth_amt_min
	pbp_b16c_copay_orth_amt_max
	pbp_b16c_auth_orth_yn
	pbp_b16c_refer_orth_yn
	pbp_b16c_bendesc_ags_amo
	pbp_b16c_bendesc_ags_lim
	pbp_b16c_bendesc_ags_num
	pbp_b16c_bendesc_ags_per
	pbp_b16c_bendesc_ags_desc
	pbp_b16c_coins_ags_yn
	pbp_b16c_coins_ags_pct
	pbp_b16c_coins_ags_pct_min
	pbp_b16c_coins_ags_pct_max
	pbp_b16c_copay_ags_yn
	pbp_b16c_copay_ags_amt
	pbp_b16c_copay_ags_amt_min
	pbp_b16c_copay_ags_amt_max
	pbp_b16c_auth_ags_yn
	pbp_b16c_refer_ags_yn
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
	pbp_b16a_maxenr_mc_yn            = 'Dental MC Max Enr YN'
	pbp_b16a_maxenr_mc_amt           = 'Dental MC Max Enr Amt'
	pbp_b16a_maxenr_mc_per           = 'Dental MC Max Enr Per'
	pbp_b16a_maxenr_mc_per_desc      = 'Dental MC Max Enr Other'
	pbp_b16a_coins_mc_yn             = 'Dental MC Coinsurance YN'
	pbp_b16a_coins_mc_pct            = 'Dental MC Min Coins Pct'
	pbp_b16a_coins_mc_pct_min        = 'Dental MC Min Coins Pct'
	pbp_b16a_coins_mc_pct_max        = 'Dental MC Max Coins Pct'
	pbp_b16a_copay_mc_yn             = 'Dental MC Copayment YN'
	pbp_b16a_copay_mc_amt            = 'Dental MC Copay Amt'
	pbp_b16a_copay_mc_amt_min        = 'Dental MC Min Copay Amt'
	pbp_b16a_copay_mc_amt_max        = 'Dental MC Max Copay Amt'
	pbp_b16a_ded_mc_yn               = 'Dental MC Deductible YN'
	pbp_b16a_ded_mc_amt              = 'Dental MC Deductible Amt'
	pbp_b16a_auth_mc_yn              = 'Dental MC Auth YN'
	pbp_b16a_refer_mc_yn             = 'Dental MC Referral YN'
	pbp_b16b_maxplan_pv_yn           = 'Dental Prev Max Plan YN'
	pbp_b16b_maxplan_pv_in_oon       = 'Dental Prev Max Plan INN OON'
	pbp_b16b_maxplan_pv_amt          = 'Dental Prev Max Plan Amt'
	pbp_b16b_maxplan_pv_per          = 'Dental Prev Max Plan Per'
	pbp_b16b_maxplan_pv_per_desc     = 'Dental Prev Max Plan Desc'
	pbp_b16b_maxenr_pv_yn            = 'Dental Prev Max Enr YN'
	pbp_b16b_maxenr_pv_amt           = 'Dental Prev Max Enr Amt'
	pbp_b16b_maxenr_pv_per           = 'Dental Prev Max Enr Per'
	pbp_b16b_maxenr_pv_per_desc      = 'Dental Prev Max Enr Other'
	pbp_b16b_coins_ov_yn             = 'Dental Prev OV Coins YN'
	pbp_b16b_coins_ov_svcs           = 'Dental Prev OV Coins Svcs'
	pbp_b16b_coins_ov_pct            = 'Dental Prev OV Coins Pct'
	pbp_b16b_coins_ov_pct_min        = 'Dental Prev OV Min Coins Pct'
	pbp_b16b_coins_ov_pct_max        = 'Dental Prev OV Max Coins Pct'
	pbp_b16b_copay_ov_yn             = 'Dental Prev Copayment YN'
	pbp_b16b_copay_ov_svcs           = 'Dental Prev PV Copay Svcs'
	pbp_b16b_copay_ov_amt            = 'Dental Prev OV Copay Amt'
	pbp_b16b_copay_ov_amt_min        = 'Dental Prev OV Min Copay Amt'
	pbp_b16b_copay_ov_amt_max        = 'Dental Prev OV Max Copay Amt'
	pbp_b16b_ded_pv_yn               = 'Dental Prev Deductible YN'
	pbp_b16b_ded_pv_amt              = 'Dental Prev Deductible Amt'
	pbp_b16b_bendesc_oe_amo          = 'Dental Prev OE Ben Desc AMO'
	pbp_b16b_bendesc_oe_lim          = 'Dental Prev OE Ben Desc Lim YN'
	pbp_b16b_bendesc_oe_num          = 'Dental Prev OE Ben Desc Num'
	pbp_b16b_bendesc_oe_per          = 'Dental Prev OE Ben Desc Per'
	pbp_b16b_bendesc_oe_desc         = 'Dental Prev OE Ben Per Desc'
	pbp_b16b_coins_oe_yn             = 'Dental Prev OE Coins YN'
	pbp_b16b_coins_oe_pct            = 'Dental Prev OE Coins Pct'
	pbp_b16b_coins_oe_pct_min        = 'Dental Prev OE Min Coins Pct'
	pbp_b16b_coins_oe_pct_max        = 'Dental Prev OE Max Coins Pct'
	pbp_b16b_copay_oe_yn             = 'Dental Prev OE Copayment YN'
	pbp_b16b_copay_oe_amt            = 'Dental OPrev E Copay Amt'
	pbp_b16b_copay_oe_amt_min        = 'Dental Prev OE Min Copay Amt'
	pbp_b16b_copay_oe_amt_max        = 'Dental Prev OE Max Copay Amt'
	pbp_b16b_auth_oe_yn              = 'Dental Prev OE Auth YN'
	pbp_b16b_refer_oe_yn             = 'Dental Prev OE Referral YN'
	pbp_b16b_bendesc_dx_amo          = 'Dental Prev DX Ben Desc AMO'
	pbp_b16b_bendesc_dx_lim          = 'Dental Prev DX Ben Desc Lim YN'
	pbp_b16b_bendesc_dx_num          = 'Dental Prev DX Ben Desc Num'
	pbp_b16b_bendesc_dx_per          = 'Dental Prev DX Ben Desc Per'
	pbp_b16b_bendesc_dx_desc         = 'Dental Prev DX Ben Per Desc'
	pbp_b16b_coins_dx_yn             = 'Dental Prev DX Coins YN'
	pbp_b16b_coins_dx_pct            = 'Dental Prev DX Coins Pct'
	pbp_b16b_coins_dx_pct_min        = 'Dental Prev DX Min Coins Pct'
	pbp_b16b_coins_dx_pct_max        = 'Dental Prev DX Max Coins Pct'
	pbp_b16b_copay_dx_yn             = 'Dental Prev DX Copayment YN'
	pbp_b16b_copay_dx_amt            = 'Dental Prev DX Copay Amt'
	pbp_b16b_copay_dx_amt_min        = 'Dental Prev DX Min Copay Amt'
	pbp_b16b_copay_dx_amt_max        = 'Dental Prev DX Max Copay Amt'
	pbp_b16b_auth_dx_yn              = 'Dental Prev DX Auth YN'
	pbp_b16b_refer_dx_yn             = 'Dental Prev DX Referral YN'
	pbp_b16b_bendesc_ods_amo         = 'Dental Prev ODS Ben Desc AMO'
	pbp_b16b_bendesc_ods_lim         = 'Dental Prev ODS Ben Lim YN'
	pbp_b16b_bendesc_ods_num         = 'Dental Prev ODS Ben Desc Num'
	pbp_b16b_bendesc_ods_per         = 'Dental Prev ODS Ben Desc Per'
	pbp_b16b_bendesc_ods_desc        = 'Dental Prev ODS Ben Per Desc'
	pbp_b16b_coins_ods_yn            = 'Dental Prev ODS Coins YN'
	pbp_b16b_coins_ods_pct           = 'Dental Prev ODS Coins Pct'
	pbp_b16b_coins_ods_pct_min       = 'Dental Prev ODS Min Coins Pct'
	pbp_b16b_coins_ods_pct_max       = 'Dental Prev ODS Max Coins Pct'
	pbp_b16b_copay_ods_yn            = 'Dental Prev ODS Copayment YN'
	pbp_b16b_copay_ods_amt           = 'Dental Prev ODS Copay Amt'
	pbp_b16b_copay_ods_amt_min       = 'Dental Prev ODS Min Copay Amt'
	pbp_b16b_copay_ods_amt_max       = 'Dental Prev ODS Max Copay Amt'
	pbp_b16b_auth_ods_yn             = 'Dental Prev ODS Auth YN'
	pbp_b16b_refer_ods_yn            = 'Dental Prev ODS Referral YN'
	pbp_b16b_bendesc_pc_amo          = 'Dental Prev PC Ben Desc AMO'
	pbp_b16b_bendesc_pc_lim          = 'Dental Prev PC Ben Desc Lim YN'
	pbp_b16b_bendesc_pc_num          = 'Dental Prev PC Ben Desc Num'
	pbp_b16b_bendesc_pc_per          = 'Dental Prev PC Ben Desc Per'
	pbp_b16b_bendesc_pc_desc         = 'Dental Prev PC Ben Per Desc'
	pbp_b16b_coins_pc_yn             = 'Dental Prev PC Coins YN'
	pbp_b16b_coins_pc_pct            = 'Dental Prev PC Coins Pct'
	pbp_b16b_coins_pc_pct_min        = 'Dental Prev PC Min Coins Pct'
	pbp_b16b_coins_pc_pct_max        = 'Dental Prev PC Max Coins Pct'
	pbp_b16b_copay_pc_yn             = 'Dental Prev PC Copayment YN'
	pbp_b16b_copay_pc_amt            = 'Dental Prev PC Copay Amt'
	pbp_b16b_copay_pc_amt_min        = 'Dental Prev PC Min Copay Amt'
	pbp_b16b_copay_pc_amt_max        = 'Dental Prev PC Max Copay Amt'
	pbp_b16b_auth_pc_yn              = 'Dental Prev PC Auth YN'
	pbp_b16b_refer_pc_yn             = 'Dental Prev PC Referral YN'
	pbp_b16b_bendesc_ft_amo          = 'Dental Prev FT Ben Desc AMO'
	pbp_b16b_bendesc_ft_lim          = 'Dental Prev FT Ben Desc Lim YN'
	pbp_b16b_bendesc_ft_num          = 'Dental Prev FT Ben Desc Num'
	pbp_b16b_bendesc_ft_per          = 'Dental Prev FT Ben Desc Per'
	pbp_b16b_bendesc_ft_desc         = 'Dental Prev FT Ben Per Desc'
	pbp_b16b_coins_ft_yn             = 'Dental Prev FT Coins YN'
	pbp_b16b_coins_ft_pct            = 'Dental Prev FT Coins Pct'
	pbp_b16b_coins_ft_pct_min        = 'Dental Prev FT Min Coins Pct'
	pbp_b16b_coins_ft_pct_max        = 'Dental Prev FT Max Coins Pct'
	pbp_b16b_copay_ft_yn             = 'Dental Prev FT Copayment YN'
	pbp_b16b_copay_ft_amt            = 'Dental Prev FT Copay Amt'
	pbp_b16b_copay_ft_amt_min        = 'Dental Prev FT Min Copay Amt'
	pbp_b16b_copay_ft_amt_max        = 'Dental Prev FT Max Copay Amt'
	pbp_b16b_auth_ft_yn              = 'Dental Prev FT Auth YN'
	pbp_b16b_refer_ft_yn             = 'Dental Prev FT Referral YN'
	pbp_b16b_bendesc_ops_amo         = 'Dental Prev OPS Ben Desc AMO'
	pbp_b16b_bendesc_ops_lim         = 'Dental Prev OPS Ben Lim YN'
	pbp_b16b_bendesc_ops_num         = 'Dental Prev OPS Ben Desc Num'
	pbp_b16b_bendesc_ops_per         = 'Dental Prev OPS Ben Desc Per'
	pbp_b16b_bendesc_ops_desc        = 'Dental Prev OPS Ben Per Desc'
	pbp_b16b_coins_ops_yn            = 'Dental Prev FT Coins YN'
	pbp_b16b_coins_ops_pct           = 'Dental Prev OPS Coins Pct'
	pbp_b16b_coins_ops_pct_min       = 'Dental Prev OPS Min Coins Pct'
	pbp_b16b_coins_ops_pct_max       = 'Dental Prev OPS Max Coins Pct'
	pbp_b16b_copay_ops_yn            = 'Dental Prev OPS Copayment YN'
	pbp_b16b_copay_ops_amt           = 'Dental Prev OPS Copay Amt'
	pbp_b16b_copay_ops_amt_min       = 'Dental Prev OPS Min Copay Amt'
	pbp_b16b_copay_ops_amt_max       = 'Dental Prev OPS Max Copay Amt'
	pbp_b16b_auth_ops_yn             = 'Dental Prev OPS Auth YN'
	pbp_b16b_refer_ops_yn            = 'Dental Prev OPS Referral YN'
	pbp_b16c_maxplan_cmp_yn          = 'Dental Comp Max Plan YN'
	pbp_b16c_maxplan_cmp_type        = 'Dental Comp Max Plan Type'
	pbp_b16c_maxplan_cmp_in_oon      = 'Dental Comp Max Plan INN OON'
	pbp_b16c_maxplan_cmp_amt         = 'Dental Comp Max Plan Amt'
	pbp_b16c_maxplan_cmp_per         = 'Dental Comp Max Plan Per'
	pbp_b16c_maxplan_cmp_per_desc    = 'Dental Comp Max Plan Desc'
	pbp_b16c_maxenr_cmp_yn           = 'Dental Comp Max Enr YN'
	pbp_b16c_maxenr_cmp_type         = 'Dental Comp Max Enr Type'
	pbp_b16c_maxenr_cmp_amt          = 'Dental Comp Max Enr Amt'
	pbp_b16c_maxenr_cmp_per          = 'Dental Comp Max Enr Per'
	pbp_b16c_maxenr_cmp_per_desc     = 'Dental Comp Max Enr Other'
	pbp_b16c_ded_cmp_yn              = 'Dental Comp Deductible YN'
	pbp_b16c_ded_cmp_amt             = 'Dental Comp Deductible Amt'
	pbp_b16c_bendesc_rs_amo          = 'Dental Comp RS Ben Desc AMO'
	pbp_b16c_bendesc_rs_lim          = 'Dental Comp RS Ben Desc Lim YN'
	pbp_b16c_bendesc_rs_num          = 'Dental Comp RS Ben Desc Num'
	pbp_b16c_bendesc_rs_per          = 'Dental Comp RS Ben Desc Per'
	pbp_b16c_bendesc_rs_desc         = 'Dental Comp RS Ben Per Desc'
	pbp_b16c_coins_rs_yn             = 'Dental Comp RS Coins YN'
	pbp_b16c_coins_rs_pct            = 'Dental Comp RS Coins Pct'
	pbp_b16c_coins_rs_pct_min        = 'Dental Comp RS Min Coins Pct'
	pbp_b16c_coins_rs_pct_max        = 'Dental Comp RS Max Coins Pct'
	pbp_b16c_copay_rs_yn             = 'Dental Comp RS Copayment YN'
	pbp_b16c_copay_rs_amt            = 'Dental Comp RS Copay Amt'
	pbp_b16c_copay_rs_amt_min        = 'Dental Comp RS Min Copay Amt'
	pbp_b16c_copay_rs_amt_max        = 'Dental Comp RS Max Copay Amt'
	pbp_b16c_auth_rs_yn              = 'Dental Comp RS Auth YN'
	pbp_b16c_refer_rs_yn             = 'Dental Comp RS Referral YN'
	pbp_b16c_bendesc_end_amo         = 'Dental Comp END Ben Desc AMO'
	pbp_b16c_bendesc_end_lim         = 'Dental Comp END Ben Lim YN'
	pbp_b16c_bendesc_end_num         = 'Dental Comp END Ben Num'
	pbp_b16c_bendesc_end_per         = 'Dental Comp END Ben Per'
	pbp_b16c_bendesc_end_desc        = 'Dental Comp END Ben Per Desc'
	pbp_b16c_coins_end_yn            = 'Dental Comp END Coins YN'
	pbp_b16c_coins_end_pct           = 'Dental Comp END Coins Pct'
	pbp_b16c_coins_end_pct_min       = 'Dental Comp END Min Coins Pct'
	pbp_b16c_coins_end_pct_max       = 'Dental Comp END Max Coins Pct'
	pbp_b16c_copay_end_yn            = 'Dental Comp END Copayment YN'
	pbp_b16c_copay_end_amt           = 'Dental Comp END Copay Amt'
	pbp_b16c_copay_end_amt_min       = 'Dental Comp END Min Copay Amt'
	pbp_b16c_copay_end_amt_max       = 'Dental Comp END Max Copay Amt'
	pbp_b16c_auth_end_yn             = 'Dental Comp END Auth YN'
	pbp_b16c_refer_end_yn            = 'Dental Comp END Referral YN'
	pbp_b16c_bendesc_peri_amo        = 'Dental Comp PERI Ben Desc AMO'
	pbp_b16c_bendesc_peri_lim        = 'Dental Comp PERI Ben Lim YN'
	pbp_b16c_bendesc_peri_num        = 'Dental Comp PERI Ben Num'
	pbp_b16c_bendesc_peri_per        = 'Dental Comp PERI Ben Per'
	pbp_b16c_bendesc_peri_desc       = 'Dental Comp PERI Ben Per Desc'
	pbp_b16c_coins_peri_yn           = 'Dental Comp PERI Coins YN'
	pbp_b16c_coins_peri_pct          = 'Dental Comp PERI Coins Pct'
	pbp_b16c_coins_peri_pct_min      = 'Dental Comp PERI Min Coins Pct'
	pbp_b16c_coins_peri_pct_max      = 'Dental Comp PERI Max Coins Pct'
	pbp_b16c_copay_peri_yn           = 'Dental Comp PERI Copayment YN'
	pbp_b16c_copay_peri_amt          = 'Dental Comp PERI Copay Amt'
	pbp_b16c_copay_peri_amt_min      = 'Dental Comp PERI Min Copay Amt'
	pbp_b16c_copay_peri_amt_max      = 'Dental Comp PERI Max Copay Amt'
	pbp_b16c_auth_peri_yn            = 'Dental Comp PERI Auth YN'
	pbp_b16c_refer_peri_yn           = 'Dental Comp PERI Referral YN'
	pbp_b16c_bendesc_prm_amo         = 'Dental Comp PRM Ben Desc AMO'
	pbp_b16c_bendesc_prm_lim         = 'Dental Comp PRM Ben Lim YN'
	pbp_b16c_bendesc_prm_num         = 'Dental Comp PRM Ben Num'
	pbp_b16c_bendesc_prm_per         = 'Dental Comp PRM Ben Per'
	pbp_b16c_bendesc_prm_desc        = 'Dental Comp PRM Ben Per Desc'
	pbp_b16c_coins_prm_yn            = 'Dental Comp PRM Coins YN'
	pbp_b16c_coins_prm_pct           = 'Dental Comp PRM Coins Pct'
	pbp_b16c_coins_prm_pct_min       = 'Dental Comp PRM Min Coins Pct'
	pbp_b16c_coins_prm_pct_max       = 'Dental Comp PRM Max Coins Pct'
	pbp_b16c_copay_prm_yn            = 'Dental Comp PRM Copayment YN'
	pbp_b16c_copay_prm_amt           = 'Dental Comp PRM Copay Amt'
	pbp_b16c_copay_prm_amt_min       = 'Dental Comp PRM Min Copay Amt'
	pbp_b16c_copay_prm_amt_max       = 'Dental Comp PRM Max Copay Amt'
	pbp_b16c_auth_prm_yn             = 'Dental Comp PRM Auth YN'
	pbp_b16c_refer_prm_yn            = 'Dental Comp PRM Referral YN'
	pbp_b16c_bendesc_mxpr_amo        = 'Dental Comp MXPR Ben Desc AMO'
	pbp_b16c_bendesc_mxpr_lim        = 'Dental Comp MXPR Ben Lim YN'
	pbp_b16c_bendesc_mxpr_num        = 'Dental Comp MXPR Ben Num'
	pbp_b16c_bendesc_mxpr_per        = 'Dental Comp MXPR Ben Per'
	pbp_b16c_bendesc_mxpr_desc       = 'Dental Comp MXPR Ben Per Desc'
	pbp_b16c_coins_mxpr_yn           = 'Dental Comp MXPR Coins YN'
	pbp_b16c_coins_mxpr_pct          = 'Dental Comp MXPR Coins Pct'
	pbp_b16c_coins_mxpr_pct_min      = 'Dental Comp MXPR Min Coins Pct'
	pbp_b16c_coins_mxpr_pct_max      = 'Dental Comp MXPR Max Coins Pct'
	pbp_b16c_copay_mxpr_yn           = 'Dental Comp MXPR Copayment YN'
	pbp_b16c_copay_mxpr_amt          = 'Dental Comp MXPR Copay Amt'
	pbp_b16c_copay_mxpr_amt_min      = 'Dental Comp MXPR Min Copay Amt'
	pbp_b16c_copay_mxpr_amt_max      = 'Dental Comp MXPR Max Copay Amt'
	pbp_b16c_auth_mxpr_yn            = 'Dental Comp MXPR Auth YN'
	pbp_b16c_refer_mxpr_yn           = 'Dental Comp MXPR Referral YN'
	pbp_b16c_bendesc_impl_amo        = 'Dental Comp IMPL Ben Desc AMO'
	pbp_b16c_bendesc_impl_lim        = 'Dental Comp IMPL Ben Lim YN'
	pbp_b16c_bendesc_impl_num        = 'Dental Comp IMPL Ben Num'
	pbp_b16c_bendesc_impl_per        = 'Dental Comp IMPL Ben Per'
	pbp_b16c_bendesc_impl_desc       = 'Dental Comp IMPL Ben Per Desc'
	pbp_b16c_coins_impl_yn           = 'Dental Comp IMPL Coins YN'
	pbp_b16c_coins_impl_pct          = 'Dental Comp IMPL Coins Pct'
	pbp_b16c_coins_impl_pct_min      = 'Dental Comp IMPL Min Coins Pct'
	pbp_b16c_coins_impl_pct_max      = 'Dental Comp IMPL Max Coins Pct'
	pbp_b16c_copay_impl_yn           = 'Dental Comp IMPL Copayment YN'
	pbp_b16c_copay_impl_amt          = 'Dental Comp IMPL Copay Amt'
	pbp_b16c_copay_impl_amt_min      = 'Dental Comp IMPL Min Copay Amt'
	pbp_b16c_copay_impl_amt_max      = 'Dental Comp IMPL Max Copay Amt'
	pbp_b16c_auth_impl_yn            = 'Dental Comp IMPL Auth YN'
	pbp_b16c_refer_impl_yn           = 'Dental Comp IMPL Referral YN'
	pbp_b16c_bendesc_prf_amo         = 'Dental Comp PRF Ben Desc AMO'
	pbp_b16c_bendesc_prf_lim         = 'Dental Comp PRF Ben Lim YN'
	pbp_b16c_bendesc_prf_num         = 'Dental Comp PRF Ben Num'
	pbp_b16c_bendesc_prf_per         = 'Dental Comp PRF Ben Per'
	pbp_b16c_bendesc_prf_desc        = 'Dental Comp PRF Ben Per Desc'
	pbp_b16c_coins_prf_yn            = 'Dental Comp PRF Coins YN'
	pbp_b16c_coins_prf_pct           = 'Dental Comp PRF Coins Pct'
	pbp_b16c_coins_prf_pct_min       = 'Dental Comp PRF Min Coins Pct'
	pbp_b16c_coins_prf_pct_max       = 'Dental Comp PRF Max Coins Pct'
	pbp_b16c_copay_prf_yn            = 'Dental Comp PRF Copayment YN'
	pbp_b16c_copay_prf_amt           = 'Dental Comp PRF Copay Amt'
	pbp_b16c_copay_prf_amt_min       = 'Dental Comp PRF Min Copay Amt'
	pbp_b16c_copay_prf_amt_max       = 'Dental Comp PRF Max Copay Amt'
	pbp_b16c_auth_prf_yn             = 'Dental Comp PRF Auth YN'
	pbp_b16c_refer_prf_yn            = 'Dental Comp PRF Referral YN'
	pbp_b16c_bendesc_omsg_amo        = 'Dental Comp OMSG Ben Desc AMO'
	pbp_b16c_bendesc_omsg_lim        = 'Dental Comp OMSG Ben Lim YN'
	pbp_b16c_bendesc_omsg_num        = 'Dental Comp OMSG Ben Num'
	pbp_b16c_bendesc_omsg_per        = 'Dental Comp OMSG Ben Per'
	pbp_b16c_bendesc_omsg_desc       = 'Dental Comp OMSG Ben Per Desc'
	pbp_b16c_coins_omsg_yn           = 'Dental Comp OMSG Coins YN'
	pbp_b16c_coins_omsg_pct          = 'Dental Comp OMSG Coins Pct'
	pbp_b16c_coins_omsg_pct_min      = 'Dental Comp OMSG Min Coins Pct'
	pbp_b16c_coins_omsg_pct_max      = 'Dental Comp OMSG Max Coins Pct'
	pbp_b16c_copay_omsg_yn           = 'Dental Comp OMSG Copayment YN'
	pbp_b16c_copay_omsg_amt          = 'Dental Comp OMSG Copay Amt'
	pbp_b16c_copay_omsg_amt_min      = 'Dental Comp OMSG Min Copay Amt'
	pbp_b16c_copay_omsg_amt_max      = 'Dental Comp OMSG Max Copay Amt'
	pbp_b16c_auth_omsg_yn            = 'Dental Comp OMSG Auth YN'
	pbp_b16c_refer_omsg_yn           = 'Dental Comp OMSG Referral YN'
	pbp_b16c_bendesc_orth_amo        = 'Dental Comp ORTH Ben Desc AMO'
	pbp_b16c_bendesc_orth_lim        = 'Dental Comp ORTH Ben Lim YN'
	pbp_b16c_bendesc_orth_num        = 'Dental Comp ORTH Ben Num'
	pbp_b16c_bendesc_orth_per        = 'Dental Comp ORTH Ben Per'
	pbp_b16c_bendesc_orth_desc       = 'Dental Comp ORTH Ben Per Desc'
	pbp_b16c_coins_orth_yn           = 'Dental Comp ORTH Coins YN'
	pbp_b16c_coins_orth_pct          = 'Dental Comp ORTH Coins Pct'
	pbp_b16c_coins_orth_pct_min      = 'Dental Comp ORTH Min Coins Pct'
	pbp_b16c_coins_orth_pct_max      = 'Dental Comp ORTH Max Coins Pct'
	pbp_b16c_copay_orth_yn           = 'Dental Comp ORTH Copayment YN'
	pbp_b16c_copay_orth_amt          = 'Dental Comp ORTH Copay Amt'
	pbp_b16c_copay_orth_amt_min      = 'Dental Comp ORTH Min Copay Amt'
	pbp_b16c_copay_orth_amt_max      = 'Dental Comp ORTH Max Copay Amt'
	pbp_b16c_auth_orth_yn            = 'Dental Comp ORTH Auth YN'
	pbp_b16c_refer_orth_yn           = 'Dental Comp ORTH Referral YN'
	pbp_b16c_bendesc_ags_amo         = 'Dental Comp AGS Ben Desc AMO'
	pbp_b16c_bendesc_ags_lim         = 'Dental Comp AGS Ben Lim YN'
	pbp_b16c_bendesc_ags_num         = 'Dental Comp AGS Ben Num'
	pbp_b16c_bendesc_ags_per         = 'Dental Comp AGS Ben Per'
	pbp_b16c_bendesc_ags_desc        = 'Dental Comp AGS Ben Per Desc'
	pbp_b16c_coins_ags_yn            = 'Dental Comp AGS Coins YN'
	pbp_b16c_coins_ags_pct           = 'Dental Comp AGS Coins Pct'
	pbp_b16c_coins_ags_pct_min       = 'Dental Comp AGS Min Coins Pct'
	pbp_b16c_coins_ags_pct_max       = 'Dental Comp AGS Max Coins Pct'
	pbp_b16c_copay_ags_yn            = 'Dental Comp AGS Copayment YN'
	pbp_b16c_copay_ags_amt           = 'Dental Comp AGS Copay Amt'
	pbp_b16c_copay_ags_amt_min       = 'Dental Comp AGS Min Copay Amt'
	pbp_b16c_copay_ags_amt_max       = 'Dental Comp AGS Max Copay Amt'
	pbp_b16c_auth_ags_yn             = 'Dental Comp AGS Auth YN'
	pbp_b16c_refer_ags_yn            = 'Dental Comp AGS Referral YN'
;

run;

proc sort data = pbp_b16 out=out.pbp_b16;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b16(obs = 10);
  title 'pbp_b16_dental file ';
run;

proc means data = out.pbp_b16;
  title 'pbp_b16_dental file ';
run;

proc freq data = out.pbp_b16;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b16a_maxenr_mc_yn
	pbp_b16a_maxenr_mc_per
	pbp_b16a_coins_mc_yn
	pbp_b16a_copay_mc_yn
	pbp_b16a_ded_mc_yn
	pbp_b16a_auth_mc_yn
	pbp_b16a_refer_mc_yn
	pbp_b16b_maxplan_pv_yn
	pbp_b16b_maxplan_pv_in_oon
	pbp_b16b_maxplan_pv_per
	pbp_b16b_maxenr_pv_yn
	pbp_b16b_maxenr_pv_per
	pbp_b16b_coins_ov_yn
	pbp_b16b_copay_ov_yn
	pbp_b16b_ded_pv_yn
	pbp_b16b_bendesc_oe_amo
	pbp_b16b_bendesc_oe_lim
	pbp_b16b_bendesc_oe_per
	pbp_b16b_coins_oe_yn
	pbp_b16b_copay_oe_yn
	pbp_b16b_auth_oe_yn
	pbp_b16b_refer_oe_yn
	pbp_b16b_bendesc_dx_amo
	pbp_b16b_bendesc_dx_lim
	pbp_b16b_bendesc_dx_per
	pbp_b16b_coins_dx_yn
	pbp_b16b_copay_dx_yn
	pbp_b16b_auth_dx_yn
	pbp_b16b_refer_dx_yn
	pbp_b16b_bendesc_ods_amo
	pbp_b16b_bendesc_ods_lim
	pbp_b16b_bendesc_ods_per
	pbp_b16b_coins_ods_yn
	pbp_b16b_copay_ods_yn
	pbp_b16b_auth_ods_yn
	pbp_b16b_refer_ods_yn
	pbp_b16b_bendesc_pc_amo
	pbp_b16b_bendesc_pc_lim
	pbp_b16b_bendesc_pc_per
	pbp_b16b_coins_pc_yn
	pbp_b16b_copay_pc_yn
	pbp_b16b_auth_pc_yn
	pbp_b16b_refer_pc_yn
	pbp_b16b_bendesc_ft_amo
	pbp_b16b_bendesc_ft_lim
	pbp_b16b_bendesc_ft_per
	pbp_b16b_coins_ft_yn
	pbp_b16b_copay_ft_yn
	pbp_b16b_auth_ft_yn
	pbp_b16b_refer_ft_yn
	pbp_b16b_bendesc_ops_amo
	pbp_b16b_bendesc_ops_lim
	pbp_b16b_bendesc_ops_per
	pbp_b16b_coins_ops_yn
	pbp_b16b_copay_ops_yn
	pbp_b16b_auth_ops_yn
	pbp_b16b_refer_ops_yn
	pbp_b16c_maxplan_cmp_yn
	pbp_b16c_maxplan_cmp_type
	pbp_b16c_maxplan_cmp_in_oon
	pbp_b16c_maxplan_cmp_per
	pbp_b16c_maxenr_cmp_yn
	pbp_b16c_maxenr_cmp_type
	pbp_b16c_maxenr_cmp_per
	pbp_b16c_ded_cmp_yn
	pbp_b16c_bendesc_rs_amo
	pbp_b16c_bendesc_rs_lim
	pbp_b16c_bendesc_rs_per
	pbp_b16c_coins_rs_yn
	pbp_b16c_copay_rs_yn
	pbp_b16c_auth_rs_yn
	pbp_b16c_refer_rs_yn
	pbp_b16c_bendesc_end_amo
	pbp_b16c_bendesc_end_lim
	pbp_b16c_bendesc_end_per
	pbp_b16c_coins_end_yn
	pbp_b16c_copay_end_yn
	pbp_b16c_auth_end_yn
	pbp_b16c_refer_end_yn
	pbp_b16c_bendesc_peri_amo
	pbp_b16c_bendesc_peri_lim
	pbp_b16c_bendesc_peri_per
	pbp_b16c_coins_peri_yn
	pbp_b16c_copay_peri_yn
	pbp_b16c_auth_peri_yn
	pbp_b16c_refer_peri_yn
	pbp_b16c_bendesc_prm_amo
	pbp_b16c_bendesc_prm_lim
	pbp_b16c_bendesc_prm_per
	pbp_b16c_coins_prm_yn
	pbp_b16c_copay_prm_yn
	pbp_b16c_auth_prm_yn
	pbp_b16c_refer_prm_yn
	pbp_b16c_bendesc_mxpr_amo
	pbp_b16c_bendesc_mxpr_lim
	pbp_b16c_bendesc_mxpr_per
	pbp_b16c_coins_mxpr_yn
	pbp_b16c_copay_mxpr_yn
	pbp_b16c_auth_mxpr_yn
	pbp_b16c_refer_mxpr_yn
	pbp_b16c_bendesc_impl_amo
	pbp_b16c_bendesc_impl_lim
	pbp_b16c_bendesc_impl_per
	pbp_b16c_coins_impl_yn
	pbp_b16c_copay_impl_yn
	pbp_b16c_auth_impl_yn
	pbp_b16c_refer_impl_yn
	pbp_b16c_bendesc_prf_amo
	pbp_b16c_bendesc_prf_lim
	pbp_b16c_bendesc_prf_per
	pbp_b16c_coins_prf_yn
	pbp_b16c_copay_prf_yn
	pbp_b16c_auth_prf_yn
	pbp_b16c_refer_prf_yn
	pbp_b16c_bendesc_omsg_amo
	pbp_b16c_bendesc_omsg_lim
	pbp_b16c_bendesc_omsg_per
	pbp_b16c_coins_omsg_yn
	pbp_b16c_copay_omsg_yn
	pbp_b16c_auth_omsg_yn
	pbp_b16c_refer_omsg_yn
	pbp_b16c_bendesc_orth_amo
	pbp_b16c_bendesc_orth_lim
	pbp_b16c_bendesc_orth_per
	pbp_b16c_coins_orth_yn
	pbp_b16c_copay_orth_yn
	pbp_b16c_auth_orth_yn
	pbp_b16c_refer_orth_yn
	pbp_b16c_bendesc_ags_amo
	pbp_b16c_bendesc_ags_lim
	pbp_b16c_bendesc_ags_per
	pbp_b16c_coins_ags_yn
	pbp_b16c_copay_ags_yn
	pbp_b16c_auth_ags_yn
	pbp_b16c_refer_ags_yn
/ missing;
run;

proc contents data = out.pbp_b16;
  title 'pbp_b16 data';
run;