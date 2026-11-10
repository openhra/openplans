*pbp_b7_health_prof.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b7;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b7a_maxenr_yn                $1
	pbp_b7a_maxenr_per               $1
	pbp_b7a_maxenr_per_d             $4000
	pbp_b7a_coins_yn                 $1
	pbp_b7a_ded_yn                   $1
	pbp_b7a_copay_yn                 $1
	pbp_b7b_bendesc_yn               $1
	pbp_b7b_bendesc_ehc              $2
	pbp_b7b_bendesc_amo_rc           $1
	pbp_b7b_bendesc_lim_rc           $1
	pbp_b7b_bendesc_per_rc           $1
	pbp_b7b_bendesc_per_rc_d         $4000
	pbp_b7b_addl_service_other       $250
	pbp_b7b_bendesc_amo_other        $1
	pbp_b7b_bendesc_lim_other        $1
	pbp_b7b_bendesc_per_other        $1
	pbp_b7b_bendesc_per_other_d      $4000
	pbp_b7b_maxplan_yn               $1
	pbp_b7b_maxplan_per              $1
	pbp_b7b_maxplan_per_d            $4000
	pbp_b7b_maxenr_yn                $1
	pbp_b7b_maxenr_per               $1
	pbp_b7b_maxenr_per_d             $4000
	pbp_b7b_coins_yn                 $1
	pbp_b7b_coins_ehc                $3
	pbp_b7b_copay_yn                 $1
	pbp_b7b_copay_ehc                $3
	pbp_b7b_ded_yn                   $1
	pbp_b7b_auth_yn                  $1
	pbp_b7b_refer_yn                 $1
	pbp_b7c_maxenr_yn                $1
	pbp_b7c_maxenr_per               $1
	pbp_b7c_maxenr_per_d             $4000
	pbp_b7c_coins_yn                 $1
	pbp_b7c_ded_yn                   $1
	pbp_b7c_copay_yn                 $1
	pbp_b7c_auth_yn                  $1
	pbp_b7c_refer_yn                 $1
	pbp_b7d_maxenr_yn                $1
	pbp_b7d_maxenr_per               $1
	pbp_b7d_maxenr_per_d             $4000
	pbp_b7d_coins_yn                 $1
	pbp_b7d_ded_yn                   $1
	pbp_b7d_copay_yn                 $1
	pbp_b7d_auth_yn                  $1
	pbp_b7d_refer_yn                 $1
	pbp_b7e_maxenr_yn                $1
	pbp_b7e_maxenr_per               $1
	pbp_b7e_maxenr_per_d             $4000
	pbp_b7e_coins_yn                 $1
	pbp_b7e_coins_ehc                $2
	pbp_b7e_ded_yn                   $1
	pbp_b7e_copay_yn                 $1
	pbp_b7e_copay_ehc                $2
	pbp_b7e_auth_yn                  $1
	pbp_b7e_refer_yn                 $1
	pbp_b7f_bendesc_yn               $1
	pbp_b7f_bendesc_rf               $1
	pbp_b7f_bendesc_amo_rf           $1
	pbp_b7f_bendesc_lim_rf           $1
	pbp_b7f_bendesc_per_rf           $1
	pbp_b7f_bendesc_per_rf_d         $4000
	pbp_b7f_maxplan_yn               $1
	pbp_b7f_maxplan_per              $1
	pbp_b7f_maxplan_per_d            $4000
	pbp_b7f_maxenr_yn                $1
	pbp_b7f_maxenr_per               $1
	pbp_b7f_maxenr_per_d             $4000
	pbp_b7f_coins_yn                 $1
	pbp_b7f_coins_ehc                $2
	pbp_b7f_ded_yn                   $1
	pbp_b7f_copay_yn                 $1
	pbp_b7f_copay_ehc                $2
	pbp_b7f_auth_yn                  $1
	pbp_b7f_refer_yn                 $1
	pbp_b7g_maxenr_yn                $1
	pbp_b7g_maxenr_per               $1
	pbp_b7g_maxenr_per_d             $4000
	pbp_b7g_coins_yn                 $1
	pbp_b7g_ded_yn                   $1
	pbp_b7g_copay_yn                 $1
	pbp_b7g_auth_yn                  $1
	pbp_b7g_refer_yn                 $1
	pbp_b7h_maxenr_yn                $1
	pbp_b7h_maxenr_per               $1
	pbp_b7h_maxenr_per_d             $4000
	pbp_b7h_coins_yn                 $1
	pbp_b7h_coins_ehc                $2
	pbp_b7h_ded_yn                   $1
	pbp_b7h_copay_yn                 $1
	pbp_b7h_copay_ehc                $2
	pbp_b7h_auth_yn                  $1
	pbp_b7h_refer_yn                 $1
	pbp_b7i_maxenr_yn                $1
	pbp_b7i_maxenr_per               $1
	pbp_b7i_maxenr_per_d             $4000
	pbp_b7i_coins_yn                 $1
	pbp_b7i_ded_yn                   $1
	pbp_b7i_copay_yn                 $1
	pbp_b7i_auth_yn                  $1
	pbp_b7i_refer_yn                 $1
	pbp_b7j_bendesc_yn               $1
	pbp_b7j_mc_bendesc_cats          $4000
	pbp_b7j_maxenr_yn                $1
	pbp_b7j_maxenr_per               $1
	pbp_b7j_maxenr_per_d             $4000
	pbp_b7j_coins_yn                 $1
	pbp_b7j_ded_yn                   $1
	pbp_b7j_copay_yn                 $1
	pbp_b7j_auth_yn                  $1
	pbp_b7j_refer_yn                 $1
	pbp_b7k_maxenr_yn                $1
	pbp_b7k_maxenr_per               $1
	pbp_b7k_maxenr_per_d             $4000
	pbp_b7k_coins_yn                 $1
	pbp_b7k_ded_yn                   $1
	pbp_b7k_copay_yn                 $1
	pbp_b7k_auth_yn                  $1
	pbp_b7k_refer_yn                 $1
;

infile '.\pbp\pbp_b7_health_prof.txt' delimiter = '09'x
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
	pbp_b7a_maxenr_yn
	pbp_b7a_maxenr_amt
	pbp_b7a_maxenr_per
	pbp_b7a_maxenr_per_d
	pbp_b7a_coins_yn
	pbp_b7a_coins_pct_mc_min
	pbp_b7a_coins_pct_mc_max
	pbp_b7a_ded_yn
	pbp_b7a_ded_amt
	pbp_b7a_copay_yn
	pbp_b7a_copay_amt_mc_min
	pbp_b7a_copay_amt_mc_max
	pbp_b7b_bendesc_yn
	pbp_b7b_bendesc_ehc
	pbp_b7b_bendesc_amo_rc
	pbp_b7b_bendesc_lim_rc
	pbp_b7b_bendesc_num_rc
	pbp_b7b_bendesc_per_rc
	pbp_b7b_bendesc_per_rc_d
	pbp_b7b_addl_service_other
	pbp_b7b_bendesc_amo_other
	pbp_b7b_bendesc_lim_other
	pbp_b7b_bendesc_num_other
	pbp_b7b_bendesc_per_other
	pbp_b7b_bendesc_per_other_d
	pbp_b7b_maxplan_yn
	pbp_b7b_maxplan_amt
	pbp_b7b_maxplan_per
	pbp_b7b_maxplan_per_d
	pbp_b7b_maxenr_yn
	pbp_b7b_maxenr_amt
	pbp_b7b_maxenr_per
	pbp_b7b_maxenr_per_d
	pbp_b7b_coins_yn
	pbp_b7b_coins_ehc
	pbp_b7b_coins_pct_mc_min
	pbp_b7b_coins_pct_mc_max
	pbp_b7b_coins_pct_rc_min
	pbp_b7b_coins_pct_rc_max
	pbp_b7b_coins_pct_other_min
	pbp_b7b_coins_pct_other_max
	pbp_b7b_copay_yn
	pbp_b7b_copay_ehc
	pbp_b7b_copay_mc_amt_min
	pbp_b7b_copay_mc_amt_max
	pbp_b7b_copay_rc_amt_min
	pbp_b7b_copay_rc_amt_max
	pbp_b7b_copay_other_amt_min
	pbp_b7b_copay_other_amt_max
	pbp_b7b_ded_yn
	pbp_b7b_ded_amt
	pbp_b7b_auth_yn
	pbp_b7b_refer_yn
	pbp_b7c_maxenr_yn
	pbp_b7c_maxenr_amt
	pbp_b7c_maxenr_per
	pbp_b7c_maxenr_per_d
	pbp_b7c_coins_yn
	pbp_b7c_coins_pct_mc_min
	pbp_b7c_coins_pct_mc_max
	pbp_b7c_ded_yn
	pbp_b7c_ded_amt
	pbp_b7c_copay_yn
	pbp_b7c_copay_mc_amt_min
	pbp_b7c_copay_mc_amt_max
	pbp_b7c_auth_yn
	pbp_b7c_refer_yn
	pbp_b7d_maxenr_yn
	pbp_b7d_maxenr_amt
	pbp_b7d_maxenr_per
	pbp_b7d_maxenr_per_d
	pbp_b7d_coins_yn
	pbp_b7d_coins_pct_mc_min
	pbp_b7d_coins_pct_mc_max
	pbp_b7d_ded_yn
	pbp_b7d_ded_amt
	pbp_b7d_copay_yn
	pbp_b7d_copay_amt_mc_min
	pbp_b7d_copay_amt_mc_max
	pbp_b7d_auth_yn
	pbp_b7d_refer_yn
	pbp_b7e_maxenr_yn
	pbp_b7e_maxenr_amt
	pbp_b7e_maxenr_per
	pbp_b7e_maxenr_per_d
	pbp_b7e_coins_yn
	pbp_b7e_coins_ehc
	pbp_b7e_coins_mcis_minpct
	pbp_b7e_coins_mcis_maxpct
	pbp_b7e_coins_mcgs_minpct
	pbp_b7e_coins_mcgs_maxpct
	pbp_b7e_ded_yn
	pbp_b7e_ded_amt
	pbp_b7e_copay_yn
	pbp_b7e_copay_ehc
	pbp_b7e_copay_mcis_minamt
	pbp_b7e_copay_mcis_maxamt
	pbp_b7e_copay_mcgs_minamt
	pbp_b7e_copay_mcgs_maxamt
	pbp_b7e_auth_yn
	pbp_b7e_refer_yn
	pbp_b7f_bendesc_yn
	pbp_b7f_bendesc_rf
	pbp_b7f_bendesc_amo_rf
	pbp_b7f_bendesc_lim_rf
	pbp_b7f_bendesc_amt_rf
	pbp_b7f_bendesc_per_rf
	pbp_b7f_bendesc_per_rf_d
	pbp_b7f_maxplan_yn
	pbp_b7f_maxplan_amt
	pbp_b7f_maxplan_per
	pbp_b7f_maxplan_per_d
	pbp_b7f_maxenr_yn
	pbp_b7f_maxenr_amt
	pbp_b7f_maxenr_per
	pbp_b7f_maxenr_per_d
	pbp_b7f_coins_yn
	pbp_b7f_coins_ehc
	pbp_b7f_coins_pct_mc_min
	pbp_b7f_coins_pct_mc_max
	pbp_b7f_coins_pct_rf_min
	pbp_b7f_coins_pct_rf_max
	pbp_b7f_ded_yn
	pbp_b7f_ded_amt
	pbp_b7f_copay_yn
	pbp_b7f_copay_ehc
	pbp_b7f_copay_mc_amt_min
	pbp_b7f_copay_mc_amt_max
	pbp_b7f_copay_rf_amt_min
	pbp_b7f_copay_rf_amt_max
	pbp_b7f_auth_yn
	pbp_b7f_refer_yn
	pbp_b7g_maxenr_yn
	pbp_b7g_maxenr_amt
	pbp_b7g_maxenr_per
	pbp_b7g_maxenr_per_d
	pbp_b7g_coins_yn
	pbp_b7g_coins_pct_mc
	pbp_b7g_coins_max_pct_mc
	pbp_b7g_ded_yn
	pbp_b7g_ded_amt
	pbp_b7g_copay_yn
	pbp_b7g_copay_mc_amt
	pbp_b7g_copay_mc_max_amt
	pbp_b7g_auth_yn
	pbp_b7g_refer_yn
	pbp_b7h_maxenr_yn
	pbp_b7h_maxenr_amt
	pbp_b7h_maxenr_per
	pbp_b7h_maxenr_per_d
	pbp_b7h_coins_yn
	pbp_b7h_coins_ehc
	pbp_b7h_coins_mcis_minpct
	pbp_b7h_coins_mcis_maxpct
	pbp_b7h_coins_mcgs_minpct
	pbp_b7h_coins_mcgs_maxpct
	pbp_b7h_ded_yn
	pbp_b7h_ded_amt
	pbp_b7h_copay_yn
	pbp_b7h_copay_ehc
	pbp_b7h_copay_mcis_minamt
	pbp_b7h_copay_mcis_maxamt
	pbp_b7h_copay_mcgs_minamt
	pbp_b7h_copay_mcgs_maxamt
	pbp_b7h_auth_yn
	pbp_b7h_refer_yn
	pbp_b7i_maxenr_yn
	pbp_b7i_maxenr_amt
	pbp_b7i_maxenr_per
	pbp_b7i_maxenr_per_d
	pbp_b7i_coins_yn
	pbp_b7i_coins_pct_mc_min
	pbp_b7i_coins_pct_mc_max
	pbp_b7i_ded_yn
	pbp_b7i_ded_amt
	pbp_b7i_copay_yn
	pbp_b7i_copay_mc_amt_min
	pbp_b7i_copay_mc_amt_max
	pbp_b7i_auth_yn
	pbp_b7i_refer_yn
	pbp_b7j_bendesc_yn
	pbp_b7j_mc_bendesc_cats
	pbp_b7j_maxenr_yn
	pbp_b7j_maxenr_amt
	pbp_b7j_maxenr_per
	pbp_b7j_maxenr_per_d
	pbp_b7j_coins_yn
	pbp_b7j_coins_pct_mc_min
	pbp_b7j_coins_pct_mc_max
	pbp_b7j_ded_yn
	pbp_b7j_ded_amt
	pbp_b7j_copay_yn
	pbp_b7j_copay_mc_amt_min
	pbp_b7j_copay_mc_amt_max
	pbp_b7j_auth_yn
	pbp_b7j_refer_yn
	pbp_b7k_maxenr_yn
	pbp_b7k_maxenr_amt
	pbp_b7k_maxenr_per
	pbp_b7k_maxenr_per_d
	pbp_b7k_coins_yn
	pbp_b7k_coins_pct_mc
	pbp_b7k_coins_max_pct_mc
	pbp_b7k_ded_yn
	pbp_b7k_ded_amt
	pbp_b7k_copay_yn
	pbp_b7k_copay_mc_amt
	pbp_b7k_copay_mc_max_amt
	pbp_b7k_auth_yn
	pbp_b7k_refer_yn
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
	pbp_b7a_maxenr_yn                = 'Primary Care Max Enr YN'
	pbp_b7a_maxenr_amt               = 'Primary Care Max Enr Amt'
	pbp_b7a_maxenr_per               = 'Primary Care Max Enr Per'
	pbp_b7a_maxenr_per_d             = 'Prim Care Max Enr Per Desc'
	pbp_b7a_coins_yn                 = 'Primary Care Coinsurance YN'
	pbp_b7a_coins_pct_mc_min         = 'Primary Care MC Min Coins Pct'
	pbp_b7a_coins_pct_mc_max         = 'Primary Care MC Max Coins Pct'
	pbp_b7a_ded_yn                   = 'Primary Care Deductible YN'
	pbp_b7a_ded_amt                  = 'Primary Care Deductible Amt'
	pbp_b7a_copay_yn                 = 'Primary Care Copayment YN'
	pbp_b7a_copay_amt_mc_min         = 'Primary Care MC Min Copay Amt'
	pbp_b7a_copay_amt_mc_max         = 'Primary Care MC Max Copay Amt'
	pbp_b7b_bendesc_yn               = 'Chiropractic Ben Desc YN'
	pbp_b7b_bendesc_ehc              = 'Chiropractic Supp Ben Desc'
	pbp_b7b_bendesc_amo_rc           = 'Routine care Ben AMO'
	pbp_b7b_bendesc_lim_rc           = 'Routine care Limit'
	pbp_b7b_bendesc_num_rc           = 'Routine care  Limit Num'
	pbp_b7b_bendesc_per_rc           = 'Routine care Per'
	pbp_b7b_bendesc_per_rc_d         = 'Routine care Per Desc'
	pbp_b7b_addl_service_other       = 'Other service name'
	pbp_b7b_bendesc_amo_other        = 'Other service Ben AMO'
	pbp_b7b_bendesc_lim_other        = 'Other service Limit'
	pbp_b7b_bendesc_num_other        = 'Other service Limit Num'
	pbp_b7b_bendesc_per_other        = 'Other service Per'
	pbp_b7b_bendesc_per_other_d      = 'Other service Per Desc'
	pbp_b7b_maxplan_yn               = 'Chiropractic Max Plan YN'
	pbp_b7b_maxplan_amt              = 'Chiropractic Max Plan Amt'
	pbp_b7b_maxplan_per              = 'Chiropractic Max Plan Per'
	pbp_b7b_maxplan_per_d            = 'Chiro Max Plan Per Desc'
	pbp_b7b_maxenr_yn                = 'Chiropractic Max Enr YN'
	pbp_b7b_maxenr_amt               = 'Chiropractic Max Enr Amt'
	pbp_b7b_maxenr_per               = 'Chiropractic Max Enr Per'
	pbp_b7b_maxenr_per_d             = 'Chiro Max Enr Per Desc'
	pbp_b7b_coins_yn                 = 'Chiropractic Coinsurance YN'
	pbp_b7b_coins_ehc                = 'Chiro Coins Enhance Benefits'
	pbp_b7b_coins_pct_mc_min         = 'Chiropractic MC Min Coins Pct'
	pbp_b7b_coins_pct_mc_max         = 'Chiropractic MC Max Coins Pct'
	pbp_b7b_coins_pct_rc_min         = 'Routine care Min Coins Pct'
	pbp_b7b_coins_pct_rc_max         = 'Routine care Max Coins Pct'
	pbp_b7b_coins_pct_other_min      = 'Other service Min Coins Pct'
	pbp_b7b_coins_pct_other_max      = 'Other service Max Coins Pct'
	pbp_b7b_copay_yn                 = 'Chiropractic Copayment YN'
	pbp_b7b_copay_ehc                = 'Chiro Copay Enhanc Benefits'
	pbp_b7b_copay_mc_amt_min         = 'Chiropractic MC Min Copay Amt'
	pbp_b7b_copay_mc_amt_max         = 'Chiropractic MC Max Copay Amt'
	pbp_b7b_copay_rc_amt_min         = 'Routine care Min Copay Amt'
	pbp_b7b_copay_rc_amt_max         = 'Routine care Max Copay Amt'
	pbp_b7b_copay_other_amt_min      = 'Other service Min Copay Amt'
	pbp_b7b_copay_other_amt_max      = 'Other service Max Copay Amt'
	pbp_b7b_ded_yn                   = 'Chiropractic Deductible YN'
	pbp_b7b_ded_amt                  = 'Chiropractic Deductible Amt'
	pbp_b7b_auth_yn                  = 'Chiropractic Auth YN'
	pbp_b7b_refer_yn                 = 'Chiropractic Referral YN'
	pbp_b7c_maxenr_yn                = 'Occ Therapy Max Enr YN'
	pbp_b7c_maxenr_amt               = 'Occ Therapy Max Enr Amt'
	pbp_b7c_maxenr_per               = 'Occ Therapy Max Enr Per'
	pbp_b7c_maxenr_per_d             = 'Occ Tx Max Enr Per Desc'
	pbp_b7c_coins_yn                 = 'Occ Therapy Coinsurance YN'
	pbp_b7c_coins_pct_mc_min         = 'Occ Ther MC MIN Coins Pct'
	pbp_b7c_coins_pct_mc_max         = 'Occ Ther MC MAX Coins Pct'
	pbp_b7c_ded_yn                   = 'Occ Therapy Deductible YN'
	pbp_b7c_ded_amt                  = 'Occ Therapy Deductible Amt'
	pbp_b7c_copay_yn                 = 'Occ Therapy Copayment YN'
	pbp_b7c_copay_mc_amt_min         = 'Occ Ther MC MIN Copay Amt'
	pbp_b7c_copay_mc_amt_max         = 'Occ Ther MC MAX Copay Amt'
	pbp_b7c_auth_yn                  = 'Occ Therapy Auth YN'
	pbp_b7c_refer_yn                 = 'Occ Therapy Referral YN'
	pbp_b7d_maxenr_yn                = 'Phys Spclist Max Enr YN'
	pbp_b7d_maxenr_amt               = 'Phys Spclist Max Enr Amt'
	pbp_b7d_maxenr_per               = 'Phys Spclist Max Enr Per'
	pbp_b7d_maxenr_per_d             = 'Phys Spc Max Enr Per Desc'
	pbp_b7d_coins_yn                 = 'Phys Spclist Coinsurance YN'
	pbp_b7d_coins_pct_mc_min         = 'Phys Spclist Min MC Coins Pct'
	pbp_b7d_coins_pct_mc_max         = 'Phys Spclist Max MC Coins Pct'
	pbp_b7d_ded_yn                   = 'Phys Spclist Deductible YN'
	pbp_b7d_ded_amt                  = 'Phys Spclist Deductible Amt'
	pbp_b7d_copay_yn                 = 'Phys Spclist Copayment YN'
	pbp_b7d_copay_amt_mc_min         = 'Phys Spclist Min MC Copay Amt'
	pbp_b7d_copay_amt_mc_max         = 'Phys Spclist Max MC Copay Amt'
	pbp_b7d_auth_yn                  = 'Phys Spclist Auth'
	pbp_b7d_refer_yn                 = 'Phys Spclist Referral YN'
	pbp_b7e_maxenr_yn                = 'MH Max Enr YN'
	pbp_b7e_maxenr_amt               = 'MH Max Enr Amt'
	pbp_b7e_maxenr_per               = 'MH Max Enr Per'
	pbp_b7e_maxenr_per_d             = 'MH Max Enr Per Desc'
	pbp_b7e_coins_yn                 = 'MH Coinsurance YN'
	pbp_b7e_coins_ehc                = 'MH Specialty Coins'
	pbp_b7e_coins_mcis_minpct        = 'MH MC Min Coins Individual'
	pbp_b7e_coins_mcis_maxpct        = 'MH MC Max Coins Individual'
	pbp_b7e_coins_mcgs_minpct        = 'MH MC Min Coins Group'
	pbp_b7e_coins_mcgs_maxpct        = 'MH MC Max Coins Group'
	pbp_b7e_ded_yn                   = 'MH Deductible YN'
	pbp_b7e_ded_amt                  = 'MH Deductible Amt'
	pbp_b7e_copay_yn                 = 'MH Copayment YN'
	pbp_b7e_copay_ehc                = 'MH Specialty Copays'
	pbp_b7e_copay_mcis_minamt        = 'MH MC Min Copay Individual'
	pbp_b7e_copay_mcis_maxamt        = 'MH MC Max Copay Individual'
	pbp_b7e_copay_mcgs_minamt        = 'MH MC Min Copay Group'
	pbp_b7e_copay_mcgs_maxamt        = 'MH MC Max Copay Group'
	pbp_b7e_auth_yn                  = 'MH Auth YN'
	pbp_b7e_refer_yn                 = 'MH Referral YN'
	pbp_b7f_bendesc_yn               = 'Podiatrist Ben Desc YN'
	pbp_b7f_bendesc_rf               = 'Podiatrist RF Ben Desc Enhance'
	pbp_b7f_bendesc_amo_rf           = 'Podiatrist RF Ben Desc AMO'
	pbp_b7f_bendesc_lim_rf           = 'Podiatrist RF Ben Desc Lim YN'
	pbp_b7f_bendesc_amt_rf           = 'Podiatrist RF Ben Desc Amt'
	pbp_b7f_bendesc_per_rf           = 'Podiatrist RF Ben Desc Per'
	pbp_b7f_bendesc_per_rf_d         = 'Podiatrist RF Per Desc'
	pbp_b7f_maxplan_yn               = 'Podiatrist Max Plan YN'
	pbp_b7f_maxplan_amt              = 'Podiatrist Max Plan Amt'
	pbp_b7f_maxplan_per              = 'Podiatrist Max Plan Per'
	pbp_b7f_maxplan_per_d            = 'Podiatrist Max Plan Per Desc'
	pbp_b7f_maxenr_yn                = 'Podiatrist Max Enr YN'
	pbp_b7f_maxenr_amt               = 'Podiatrist Max Enr Amt'
	pbp_b7f_maxenr_per               = 'Podiatrist Max Enr Per'
	pbp_b7f_maxenr_per_d             = 'Podiat Max Enr Per Desc'
	pbp_b7f_coins_yn                 = 'Podiatrist Coinsurance YN'
	pbp_b7f_coins_ehc                = 'Podiatry Services Coinsurance'
	pbp_b7f_coins_pct_mc_min         = 'Podiatrist MC Min Coins Pct'
	pbp_b7f_coins_pct_mc_max         = 'Podiatrist MC Max Coins Pct'
	pbp_b7f_coins_pct_rf_min         = 'Podiatry RF Min Coins Pct'
	pbp_b7f_coins_pct_rf_max         = 'Podiatry RF Max Coins Pct'
	pbp_b7f_ded_yn                   = 'Podiatrist Deductible YN'
	pbp_b7f_ded_amt                  = 'Podiatrist Deductible Amt'
	pbp_b7f_copay_yn                 = 'Podiatrist Copayment YN'
	pbp_b7f_copay_ehc                = 'Podiatry Services have a Copay'
	pbp_b7f_copay_mc_amt_min         = 'Podiatrist MC Min Copay Amt'
	pbp_b7f_copay_mc_amt_max         = 'Podiatrist MC Max Copay Amt'
	pbp_b7f_copay_rf_amt_min         = 'Podiatrist RF Min Copay Amt'
	pbp_b7f_copay_rf_amt_max         = 'Podiatrist RF Max Copay Amt'
	pbp_b7f_auth_yn                  = 'Podiatrist Auth YN'
	pbp_b7f_refer_yn                 = 'Podiatrist Referral YN'
	pbp_b7g_maxenr_yn                = 'Oth Hlth Care Max Enr YN'
	pbp_b7g_maxenr_amt               = 'Oth Hlth Care Max Enr Amt'
	pbp_b7g_maxenr_per               = 'Oth Hlth Care Max Enr Per'
	pbp_b7g_maxenr_per_d             = 'Oth Hlth Cr Max Enr Per Desc'
	pbp_b7g_coins_yn                 = 'Oth Hlth Care Coinsurance YN'
	pbp_b7g_coins_pct_mc             = 'Oth Hlth Care MC Min Coins Pct'
	pbp_b7g_coins_max_pct_mc         = 'Oth Hlth Care MC Max Coins Pct'
	pbp_b7g_ded_yn                   = 'Oth Hlth Care Deductible YN'
	pbp_b7g_ded_amt                  = 'Oth Hlth Care Deductible Amt'
	pbp_b7g_copay_yn                 = 'Oth Hlth Care Copayment YN'
	pbp_b7g_copay_mc_amt             = 'Oth Hlth Care MC Min Copay Amt'
	pbp_b7g_copay_mc_max_amt         = 'Oth Hlth Care MC Max Copay Amt'
	pbp_b7g_auth_yn                  = 'Oth Hlth Care Enrollee Auth'
	pbp_b7g_refer_yn                 = 'Oth Hlth Care Referral YN'
	pbp_b7h_maxenr_yn                = 'Psych Max Enr YN'
	pbp_b7h_maxenr_amt               = 'Psych Max Enr Amt'
	pbp_b7h_maxenr_per               = 'Psych Max Enr Per'
	pbp_b7h_maxenr_per_d             = 'Psych Max Enr Per Desc'
	pbp_b7h_coins_yn                 = 'Psych Coinsurance YN'
	pbp_b7h_coins_ehc                = 'Psychiatric Services Coins'
	pbp_b7h_coins_mcis_minpct        = 'Psych Min Coins Individual'
	pbp_b7h_coins_mcis_maxpct        = 'Psych Max Coins Individual'
	pbp_b7h_coins_mcgs_minpct        = 'Psych Min Coins Group'
	pbp_b7h_coins_mcgs_maxpct        = 'Psych Max Coins Group'
	pbp_b7h_ded_yn                   = 'Psych Deductible YN'
	pbp_b7h_ded_amt                  = 'Psych Deductible Amt'
	pbp_b7h_copay_yn                 = 'Psych Copayment YN'
	pbp_b7h_copay_ehc                = 'Psychiatric Services Copay'
	pbp_b7h_copay_mcis_minamt        = 'Psych Min Copay Individual'
	pbp_b7h_copay_mcis_maxamt        = 'Psych Max Copay Individual'
	pbp_b7h_copay_mcgs_minamt        = 'Psych Min Copay Group'
	pbp_b7h_copay_mcgs_maxamt        = 'Psych Max Copay Group'
	pbp_b7h_auth_yn                  = 'Psych Auth YN'
	pbp_b7h_refer_yn                 = 'Psych Referral YN'
	pbp_b7i_maxenr_yn                = 'PT/SP Srvs Max Enr YN'
	pbp_b7i_maxenr_amt               = 'PT/SP Srvs Max Enr Amt'
	pbp_b7i_maxenr_per               = 'PT/SP Srvs Max Enr Per'
	pbp_b7i_maxenr_per_d             = 'PT/SP Srvs Max Enr Per Desc'
	pbp_b7i_coins_yn                 = 'PT/SP Srvs Coinsurance YN'
	pbp_b7i_coins_pct_mc_min         = 'PT/SP Coins MC Min'
	pbp_b7i_coins_pct_mc_max         = 'PT/SP Coins MC Max'
	pbp_b7i_ded_yn                   = 'PT/SP Srvs Deductible YN'
	pbp_b7i_ded_amt                  = 'PT/SP Srvs Deductible Amt'
	pbp_b7i_copay_yn                 = 'PT/SP Srvs Copayment YN'
	pbp_b7i_copay_mc_amt_min         = 'PT/SP Copay MC Min'
	pbp_b7i_copay_mc_amt_max         = 'PT/SP Copay MC Max'
	pbp_b7i_auth_yn                  = 'PT/SP Srvs Enrollee Auth'
	pbp_b7i_refer_yn                 = 'PT/SP Srvs Referral YN'
	pbp_b7j_bendesc_yn               = 'Telehealth Ben Desc YN'
	pbp_b7j_mc_bendesc_cats          = 'Telehealth services'
	pbp_b7j_maxenr_yn                = 'Telehealth Max Enr YN'
	pbp_b7j_maxenr_amt               = 'Telehealth Max Enr Amt'
	pbp_b7j_maxenr_per               = 'Telehealth Max Enr Per'
	pbp_b7j_maxenr_per_d             = 'Telehealth Max Enr Per Desc'
	pbp_b7j_coins_yn                 = 'Telehealth Coinsurance YN'
	pbp_b7j_coins_pct_mc_min         = 'Telehealth MC Min Coins Pct'
	pbp_b7j_coins_pct_mc_max         = 'Telehealth MC Max Coins Pct'
	pbp_b7j_ded_yn                   = 'Telehealth Deductible YN'
	pbp_b7j_ded_amt                  = 'Telehealth Deductible Amt'
	pbp_b7j_copay_yn                 = 'Telehealth Copayment YN'
	pbp_b7j_copay_mc_amt_min         = 'Telehealth MC Min Copay Amt'
	pbp_b7j_copay_mc_amt_max         = 'Telehealth MC Max Copay Amt'
	pbp_b7j_auth_yn                  = 'Telehealth Auth YN'
	pbp_b7j_refer_yn                 = 'Telehealth Referral YN'
	pbp_b7k_maxenr_yn                = 'Opi Treat Max Enr YN'
	pbp_b7k_maxenr_amt               = 'Opi Treat Max Enr Amt'
	pbp_b7k_maxenr_per               = 'Opi Treat Max Enr Per'
	pbp_b7k_maxenr_per_d             = 'Opi Treat Max Enr Per Desc'
	pbp_b7k_coins_yn                 = 'Opi Treat Coinsurance YN'
	pbp_b7k_coins_pct_mc             = 'Opi Treat MC Min Coins Pct'
	pbp_b7k_coins_max_pct_mc         = 'Opi Treat MC Max Coins Pct'
	pbp_b7k_ded_yn                   = 'Opi Treat Deductible YN'
	pbp_b7k_ded_amt                  = 'Opi Treat Deductible Amt'
	pbp_b7k_copay_yn                 = 'Opi Treat Copayment YN'
	pbp_b7k_copay_mc_amt             = 'Opi Treat MC Min Copay Amt'
	pbp_b7k_copay_mc_max_amt         = 'Opi Treat MC Max Copay Amt'
	pbp_b7k_auth_yn                  = 'Opi Treat Enrollee Auth'
	pbp_b7k_refer_yn                 = 'Opi Treat Referral YN'
;

run;

proc sort data = pbp_b7 out=out.pbp_b7;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b7(obs = 10);
  title 'pbp_b7_health_prof file ';
run;

proc means data = out.pbp_b7;
  title 'pbp_b7_health_prof file ';
run;

proc freq data = out.pbp_b7;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b7a_maxenr_yn
	pbp_b7a_maxenr_per
	pbp_b7a_coins_yn
	pbp_b7a_ded_yn
	pbp_b7a_copay_yn
	pbp_b7b_bendesc_yn
	pbp_b7b_bendesc_ehc
	pbp_b7b_bendesc_amo_rc
	pbp_b7b_bendesc_lim_rc
	pbp_b7b_bendesc_per_rc
	pbp_b7b_bendesc_amo_other
	pbp_b7b_bendesc_lim_other
	pbp_b7b_bendesc_per_other
	pbp_b7b_maxplan_yn
	pbp_b7b_maxplan_per
	pbp_b7b_maxenr_yn
	pbp_b7b_maxenr_per
	pbp_b7b_coins_yn
	pbp_b7b_coins_ehc
	pbp_b7b_copay_yn
	pbp_b7b_copay_ehc
	pbp_b7b_ded_yn
	pbp_b7b_auth_yn
	pbp_b7b_refer_yn
	pbp_b7c_maxenr_yn
	pbp_b7c_maxenr_per
	pbp_b7c_coins_yn
	pbp_b7c_ded_yn
	pbp_b7c_copay_yn
	pbp_b7c_auth_yn
	pbp_b7c_refer_yn
	pbp_b7d_maxenr_yn
	pbp_b7d_maxenr_per
	pbp_b7d_coins_yn
	pbp_b7d_ded_yn
	pbp_b7d_copay_yn
	pbp_b7d_auth_yn
	pbp_b7d_refer_yn
	pbp_b7e_maxenr_yn
	pbp_b7e_maxenr_per
	pbp_b7e_coins_yn
	pbp_b7e_coins_ehc
	pbp_b7e_ded_yn
	pbp_b7e_copay_yn
	pbp_b7e_copay_ehc
	pbp_b7e_auth_yn
	pbp_b7e_refer_yn
	pbp_b7f_bendesc_yn
	pbp_b7f_bendesc_rf
	pbp_b7f_bendesc_amo_rf
	pbp_b7f_bendesc_lim_rf
	pbp_b7f_bendesc_per_rf
	pbp_b7f_maxplan_yn
	pbp_b7f_maxplan_per
	pbp_b7f_maxenr_yn
	pbp_b7f_maxenr_per
	pbp_b7f_coins_yn
	pbp_b7f_coins_ehc
	pbp_b7f_ded_yn
	pbp_b7f_copay_yn
	pbp_b7f_copay_ehc
	pbp_b7f_auth_yn
	pbp_b7f_refer_yn
	pbp_b7g_maxenr_yn
	pbp_b7g_maxenr_per
	pbp_b7g_coins_yn
	pbp_b7g_ded_yn
	pbp_b7g_copay_yn
	pbp_b7g_auth_yn
	pbp_b7g_refer_yn
	pbp_b7h_maxenr_yn
	pbp_b7h_maxenr_per
	pbp_b7h_coins_yn
	pbp_b7h_coins_ehc
	pbp_b7h_ded_yn
	pbp_b7h_copay_yn
	pbp_b7h_copay_ehc
	pbp_b7h_auth_yn
	pbp_b7h_refer_yn
	pbp_b7i_maxenr_yn
	pbp_b7i_maxenr_per
	pbp_b7i_coins_yn
	pbp_b7i_ded_yn
	pbp_b7i_copay_yn
	pbp_b7i_auth_yn
	pbp_b7i_refer_yn
	pbp_b7j_bendesc_yn
	pbp_b7j_maxenr_yn
	pbp_b7j_maxenr_per
	pbp_b7j_coins_yn
	pbp_b7j_ded_yn
	pbp_b7j_copay_yn
	pbp_b7j_auth_yn
	pbp_b7j_refer_yn
	pbp_b7k_maxenr_yn
	pbp_b7k_maxenr_per
	pbp_b7k_coins_yn
	pbp_b7k_ded_yn
	pbp_b7k_copay_yn
	pbp_b7k_auth_yn
	pbp_b7k_refer_yn
/ missing;
run;

proc contents data = out.pbp_b7;
  title 'pbp_b7 data';
run;