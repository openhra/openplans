*pbp_b17_eye_exams_wear.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b17;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b17a_bendesc_yn              $1
	pbp_b17a_bendesc_ehc             $2
	pbp_b17a_bendesc_amo_rex         $1
	pbp_b17a_bendesc_lim_rex         $1
	pbp_b17a_bendesc_per_rex         $1
	pbp_b17a_bendesc_per_rex_d       $4000
	pbp_b17a_addl_service_other      $250
	pbp_b17a_bendesc_amo_other       $1
	pbp_b17a_bendesc_lim_other       $1
	pbp_b17a_bendesc_per_other       $1
	pbp_b17a_bendesc_per_other_d     $4000
	pbp_b17a_maxplan_yn              $1
	pbp_b17a_maxplan_in_oon          $1
	pbp_b17a_maxplan_per             $1
	pbp_b17a_maxplan_per_d           $4000
	pbp_b17a_maxenr_yn               $1
	pbp_b17a_maxenr_per              $1
	pbp_b17a_maxenr_per_d            $4000
	pbp_b17a_coins_yn                $1
	pbp_b17a_coins_ehc               $3
	pbp_b17a_copay_yn                $1
	pbp_b17a_copay_ehc               $3
	pbp_b17a_ded_yn                  $1
	pbp_b17a_ded_nmc_yn              $1
	pbp_b17a_auth_yn                 $1
	pbp_b17a_refer_yn                $1
	pbp_b17b_bendesc_yn              $1
	pbp_b17b_bendesc_ehc             $5
	pbp_b17b_bendesc_amo_cl          $1
	pbp_b17b_bendesc_lim_cl          $1
	pbp_b17b_bendesc_per_cl          $1
	pbp_b17b_bendesc_per_cl_d        $4000
	pbp_b17b_bendesc_amo_egs         $1
	pbp_b17b_bendesc_lim_egs         $1
	pbp_b17b_bendesc_per_egs         $1
	pbp_b17b_bendesc_per_egs_d       $4000
	pbp_b17b_bendesc_amo_egi         $1
	pbp_b17b_bendesc_lim_egl         $1
	pbp_b17b_bendesc_per_egl         $1
	pbp_b17b_bendesc_per_egl_d       $4000
	pbp_b17b_bendesc_amo_egf         $1
	pbp_b17b_bendesc_lim_egf         $1
	pbp_b17b_bendesc_per_egf         $1
	pbp_b17b_bendesc_per_egf_d       $4000
	pbp_b17b_bendesc_amo_upg         $1
	pbp_b17b_maxplan_yn              $1
	pbp_b17b_maxplan_in_oon          $1
	pbp_b17b_maxplan_type            $1
	pbp_b17b_comb_maxplan_yn         $1
	pbp_b17b_comb_maxplan_per        $1
	pbp_b17b_comb_maxplan_per_d      $4000
	pbp_b17b_indv_maxplan_bendesc    $5
	pbp_b17b_indv_maxplan_per_cl     $1
	pbp_b17b_indv_maxplan_per_cl_d   $4000
	pbp_b17b_indv_maxplan_per_egs    $1
	pbp_b17b_ind_maxplan_per_egs_d   $4000
	pbp_b17b_indv_maxplan_per_egl    $1
	pbp_b17b_ind_maxplan_per_egl_d   $4000
	pbp_b17b_indv_maxplan_per_egf    $1
	pbp_b17b_ind_maxplan_per_egf_d   $4000
	pbp_b17b_indv_maxplan_per_upg    $1
	pbp_b17b_ind_maxplan_per_upg_d   $4000
	pbp_b17b_maxenr_yn               $1
	pbp_b17b_maxenr_type             $1
	pbp_b17b_maxenr_per              $1
	pbp_b17b_maxenr_per_d            $4000
	pbp_b17b_coins_yn                $1
	pbp_b17b_coins_ehc               $6
	pbp_b17b_ded_yn                  $1
	pbp_b17b_ded_nmc_yn              $1
	pbp_b17b_copay_yn                $1
	pbp_b17b_copay_ehc               $6
	pbp_b17b_auth_yn                 $1
	pbp_b17b_refer_yn                $1
;

infile '.\pbp\pbp_b17_eye_exams_wear.txt' delimiter = '09'x
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
	pbp_b17a_bendesc_yn
	pbp_b17a_bendesc_ehc
	pbp_b17a_bendesc_amo_rex
	pbp_b17a_bendesc_lim_rex
	pbp_b17a_bendesc_num_rex
	pbp_b17a_bendesc_per_rex
	pbp_b17a_bendesc_per_rex_d
	pbp_b17a_addl_service_other
	pbp_b17a_bendesc_amo_other
	pbp_b17a_bendesc_lim_other
	pbp_b17a_bendesc_num_other
	pbp_b17a_bendesc_per_other
	pbp_b17a_bendesc_per_other_d
	pbp_b17a_maxplan_yn
	pbp_b17a_maxplan_in_oon
	pbp_b17a_maxplan_amt
	pbp_b17a_maxplan_per
	pbp_b17a_maxplan_per_d
	pbp_b17a_maxenr_yn
	pbp_b17a_maxenr_amt
	pbp_b17a_maxenr_per
	pbp_b17a_maxenr_per_d
	pbp_b17a_coins_yn
	pbp_b17a_coins_ehc
	pbp_b17a_coins_pct_mc_min
	pbp_b17a_coins_pct_mc_max
	pbp_b17a_coins_pct_rex_min
	pbp_b17a_coins_pct_rex_max
	pbp_b17a_coins_pct_other_min
	pbp_b17a_coins_pct_other_max
	pbp_b17a_copay_yn
	pbp_b17a_copay_ehc
	pbp_b17a_copay_amt_mc_min
	pbp_b17a_copay_amt_mc_max
	pbp_b17a_copay_amt_rex_min
	pbp_b17a_copay_amt_rex_max
	pbp_b17a_copay_amt_other_min
	pbp_b17a_copay_amt_other_max
	pbp_b17a_ded_yn
	pbp_b17a_ded_amt
	pbp_b17a_ded_nmc_yn
	pbp_b17a_ded_nmc_amt
	pbp_b17a_auth_yn
	pbp_b17a_refer_yn
	pbp_b17b_bendesc_yn
	pbp_b17b_bendesc_ehc
	pbp_b17b_bendesc_amo_cl
	pbp_b17b_bendesc_lim_cl
	pbp_b17b_bendesc_numv_cl
	pbp_b17b_bendesc_per_cl
	pbp_b17b_bendesc_per_cl_d
	pbp_b17b_bendesc_amo_egs
	pbp_b17b_bendesc_lim_egs
	pbp_b17b_bendesc_numv_egs
	pbp_b17b_bendesc_per_egs
	pbp_b17b_bendesc_per_egs_d
	pbp_b17b_bendesc_amo_egi
	pbp_b17b_bendesc_lim_egl
	pbp_b17b_bendesc_numv_egl
	pbp_b17b_bendesc_per_egl
	pbp_b17b_bendesc_per_egl_d
	pbp_b17b_bendesc_amo_egf
	pbp_b17b_bendesc_lim_egf
	pbp_b17b_bendesc_numv_egf
	pbp_b17b_bendesc_per_egf
	pbp_b17b_bendesc_per_egf_d
	pbp_b17b_bendesc_amo_upg
	pbp_b17b_maxplan_yn
	pbp_b17b_maxplan_in_oon
	pbp_b17b_maxplan_type
	pbp_b17b_comb_maxplan_yn
	pbp_b17b_comb_maxplan_amt
	pbp_b17b_comb_maxplan_per
	pbp_b17b_comb_maxplan_per_d
	pbp_b17b_indv_maxplan_bendesc
	pbp_b17b_indv_maxplan_amt_cl
	pbp_b17b_indv_maxplan_per_cl
	pbp_b17b_indv_maxplan_per_cl_d
	pbp_b17b_indv_maxplan_amt_egs
	pbp_b17b_indv_maxplan_per_egs
	pbp_b17b_ind_maxplan_per_egs_d
	pbp_b17b_indv_maxplan_amt_egl
	pbp_b17b_indv_maxplan_per_egl
	pbp_b17b_ind_maxplan_per_egl_d
	pbp_b17b_indv_maxplan_amt_egf
	pbp_b17b_indv_maxplan_per_egf
	pbp_b17b_ind_maxplan_per_egf_d
	pbp_b17b_indv_maxplan_amt_upg
	pbp_b17b_indv_maxplan_per_upg
	pbp_b17b_ind_maxplan_per_upg_d
	pbp_b17b_maxenr_yn
	pbp_b17b_maxenr_type
	pbp_b17b_maxenr_amt
	pbp_b17b_maxenr_per
	pbp_b17b_maxenr_per_d
	pbp_b17b_coins_yn
	pbp_b17b_coins_ehc
	pbp_b17b_coins_pct_mc_min
	pbp_b17b_coins_pct_mc_max
	pbp_b17b_coins_pct_cl_min
	pbp_b17b_coins_pct_cl_max
	pbp_b17b_coins_pct_egs_min
	pbp_b17b_coins_pct_egs_max
	pbp_b17b_coins_pct_egl_min
	pbp_b17b_coins_pct_egl_max
	pbp_b17b_coins_pct_egf_min
	pbp_b17b_coins_pct_egf_max
	pbp_b17b_coins_pct_upg_min
	pbp_b17b_coins_pct_upg_max
	pbp_b17b_ded_yn
	pbp_b17b_ded_amt
	pbp_b17b_ded_nmc_yn
	pbp_b17b_ded_nmc_amt
	pbp_b17b_copay_yn
	pbp_b17b_copay_ehc
	pbp_b17b_copay_amt_mc_min
	pbp_b17b_copay_amt_mc_max
	pbp_b17b_copay_amt_cl_min
	pbp_b17b_copay_amt_cl_max
	pbp_b17b_copay_amt_egs_min
	pbp_b17b_copay_amt_egs_max
	pbp_b17b_copay_amt_egl_min
	pbp_b17b_copay_amt_egl_max
	pbp_b17b_copay_amt_egf_min
	pbp_b17b_copay_amt_egf_max
	pbp_b17b_copay_amt_upg_min
	pbp_b17b_copay_amt_upg_max
	pbp_b17b_auth_yn
	pbp_b17b_refer_yn
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
	pbp_b17a_bendesc_yn              = 'Eye Exams Ben YN'
	pbp_b17a_bendesc_ehc             = 'Eye Exams (17a) Ben'
	pbp_b17a_bendesc_amo_rex         = 'Eye Exams REX AMO'
	pbp_b17a_bendesc_lim_rex         = 'Eye Exams REX Desc Lim YN'
	pbp_b17a_bendesc_num_rex         = 'Eye Exams REX Desc lim num'
	pbp_b17a_bendesc_per_rex         = 'Eye Exams REX Desc Per'
	pbp_b17a_bendesc_per_rex_d       = 'Eye Exams REX Per Desc'
	pbp_b17a_addl_service_other      = 'Eye Exams other service name'
	pbp_b17a_bendesc_amo_other       = 'Eye Exams other Desc AMO'
	pbp_b17a_bendesc_lim_other       = 'Eye Exams other Desc Lim YN'
	pbp_b17a_bendesc_num_other       = 'Eye Exams other Desc lim num'
	pbp_b17a_bendesc_per_other       = 'Eye Exams other Desc Per'
	pbp_b17a_bendesc_per_other_d     = 'Eye Exams other Per Desc'
	pbp_b17a_maxplan_yn              = 'Eye Exams Max Plan YN'
	pbp_b17a_maxplan_in_oon          = 'Eye Exams INN or OON'
	pbp_b17a_maxplan_amt             = 'Eye Exams Max Plan Amt'
	pbp_b17a_maxplan_per             = 'Eye Exams Max Plan Per'
	pbp_b17a_maxplan_per_d           = 'Eye Exam Max Plan Per Desc'
	pbp_b17a_maxenr_yn               = 'Eye Exams Max Enr YN'
	pbp_b17a_maxenr_amt              = 'Eye Exams Max Enr Amt'
	pbp_b17a_maxenr_per              = 'Eye Exams Max Enr Per'
	pbp_b17a_maxenr_per_d            = 'Eye Exam Max Enr Per Desc'
	pbp_b17a_coins_yn                = 'Eye Exams Coinsurance YN'
	pbp_b17a_coins_ehc               = 'Eye Exams Coinsurance Svcs'
	pbp_b17a_coins_pct_mc_min        = 'Eye Exams MC Min Coins Pct'
	pbp_b17a_coins_pct_mc_max        = 'Eye Exams MC Max Coins Pct'
	pbp_b17a_coins_pct_rex_min       = 'Eye Exams REX Min Coins Pct'
	pbp_b17a_coins_pct_rex_max       = 'Eye Exams REX Max Coins Pct'
	pbp_b17a_coins_pct_other_min     = 'Eye Exams other Min Coins Pct'
	pbp_b17a_coins_pct_other_max     = 'Eye Exams other Max Coins Pct'
	pbp_b17a_copay_yn                = 'Eye Exams Copayment YN'
	pbp_b17a_copay_ehc               = 'Eye Exams Copayment Svcs'
	pbp_b17a_copay_amt_mc_min        = 'Eye Exams MC Min Copay Amt'
	pbp_b17a_copay_amt_mc_max        = 'Eye Exams MC Max Copay Amt'
	pbp_b17a_copay_amt_rex_min       = 'Eye Exams REX Min Copay Amt'
	pbp_b17a_copay_amt_rex_max       = 'Eye Exams REX Max Copay Amt'
	pbp_b17a_copay_amt_other_min     = 'Eye Exams other Min Copay Amt'
	pbp_b17a_copay_amt_other_max     = 'Eye Exams other Max Copay Amt'
	pbp_b17a_ded_yn                  = 'Eye Exams Deduct MC YN'
	pbp_b17a_ded_amt                 = 'Eye Exams Deduct MC Amt'
	pbp_b17a_ded_nmc_yn              = 'Eye Exams Deduct NMC YN'
	pbp_b17a_ded_nmc_amt             = 'Eye Exams Deduct NMC Amt'
	pbp_b17a_auth_yn                 = 'Eye Exams Auth YN'
	pbp_b17a_refer_yn                = 'Eye Exams Referral YN'
	pbp_b17b_bendesc_yn              = 'Eyewear Ben YN'
	pbp_b17b_bendesc_ehc             = 'Eyewear (17b) Ben'
	pbp_b17b_bendesc_amo_cl          = 'Eyewear CL Ben Desc AMO'
	pbp_b17b_bendesc_lim_cl          = 'Eyewear CL Ben Desc Lim YN'
	pbp_b17b_bendesc_numv_cl         = 'Eyewear CL Ben Desc Num'
	pbp_b17b_bendesc_per_cl          = 'Eyewear CL Ben Desc Per'
	pbp_b17b_bendesc_per_cl_d        = 'Eyewear CL Ben Per Desc'
	pbp_b17b_bendesc_amo_egs         = 'Eyewear EGS Ben Desc AMO'
	pbp_b17b_bendesc_lim_egs         = 'Eyewear EGS Ben Desc Lim YN'
	pbp_b17b_bendesc_numv_egs        = 'Eyewear EGS Ben Desc Num'
	pbp_b17b_bendesc_per_egs         = 'Eyewear EGS Ben Desc Per'
	pbp_b17b_bendesc_per_egs_d       = 'Eyewear EGS Ben Per Desc'
	pbp_b17b_bendesc_amo_egi         = 'Eyewear EGL Ben Desc AMO'
	pbp_b17b_bendesc_lim_egl         = 'Eyewear EGL Ben Desc Lim YN'
	pbp_b17b_bendesc_numv_egl        = 'Eyewear EGL Ben Desc Num'
	pbp_b17b_bendesc_per_egl         = 'Eyewear EGL Ben Desc Per'
	pbp_b17b_bendesc_per_egl_d       = 'Eyewear EGL Ben Per Desc'
	pbp_b17b_bendesc_amo_egf         = 'Eyewear EGF Ben Desc AMO'
	pbp_b17b_bendesc_lim_egf         = 'Eyewear EGF Ben Desc Lim YN'
	pbp_b17b_bendesc_numv_egf        = 'Eyewear EGF Ben Desc Num'
	pbp_b17b_bendesc_per_egf         = 'Eyewear EGF Ben Desc Per'
	pbp_b17b_bendesc_per_egf_d       = 'Eyewear EGF Ben Per Desc'
	pbp_b17b_bendesc_amo_upg         = 'Eyewear UPG Ben Desc AMO'
	pbp_b17b_maxplan_yn              = 'Eyewear Max Plan YN'
	pbp_b17b_maxplan_in_oon          = 'Eyewear INN or OON'
	pbp_b17b_maxplan_type            = 'Eyewear Max Plan Type'
	pbp_b17b_comb_maxplan_yn         = 'Eyewear Comb Max Plan YN'
	pbp_b17b_comb_maxplan_amt        = 'Eyewear Comb Max Plan Amt'
	pbp_b17b_comb_maxplan_per        = 'Eyewear Comb Max Plan Per'
	pbp_b17b_comb_maxplan_per_d      = 'Eyewear Comb Max Plan Per Desc'
	pbp_b17b_indv_maxplan_bendesc    = 'Eyewear Indiv Max Plan Bendsc'
	pbp_b17b_indv_maxplan_amt_cl     = 'Eyewear Indv Max Plan Amt CL'
	pbp_b17b_indv_maxplan_per_cl     = 'Eyewear Indv Max Plan Per CL'
	pbp_b17b_indv_maxplan_per_cl_d   = 'Eyewear Indv Max Plan CL Desc'
	pbp_b17b_indv_maxplan_amt_egs    = 'Eyewear Indv Max Plan Amt EGS'
	pbp_b17b_indv_maxplan_per_egs    = 'Eyewear Indv Max Plan Per EGS'
	pbp_b17b_ind_maxplan_per_egs_d   = 'Eyewear Indv Max Pln EGS Desc'
	pbp_b17b_indv_maxplan_amt_egl    = 'Eyewear Indv Maxplan Amt EGL'
	pbp_b17b_indv_maxplan_per_egl    = 'Eyewear Indv Max Plan Per EGL'
	pbp_b17b_ind_maxplan_per_egl_d   = 'Eyewear Indv Max Pln EGL Desc'
	pbp_b17b_indv_maxplan_amt_egf    = 'Eyewear Indv Max Plan Amt EGF'
	pbp_b17b_indv_maxplan_per_egf    = 'Eyewear Indv Max Plan Per EGF'
	pbp_b17b_ind_maxplan_per_egf_d   = 'Eyewear Indv Max Pln EGF Desc'
	pbp_b17b_indv_maxplan_amt_upg    = 'Eyewear Indv Max Plan Amt UPG'
	pbp_b17b_indv_maxplan_per_upg    = 'Eyewear Indv Max Plan Per UPG'
	pbp_b17b_ind_maxplan_per_upg_d   = 'Eyewear Indv Max Pln UPG Desc'
	pbp_b17b_maxenr_yn               = 'Eyewear Max Enr YN'
	pbp_b17b_maxenr_type             = 'Eyewear Max Enr Type'
	pbp_b17b_maxenr_amt              = 'Eyewear Max Enr Amt'
	pbp_b17b_maxenr_per              = 'Eyewear Max Enr Per'
	pbp_b17b_maxenr_per_d            = 'Eyewear Max Enr Per Desc'
	pbp_b17b_coins_yn                = 'Eyewear Coinsurance YN'
	pbp_b17b_coins_ehc               = 'Eyewear Benefits Coinsurance'
	pbp_b17b_coins_pct_mc_min        = 'Eyewear MC Min Coins Pct'
	pbp_b17b_coins_pct_mc_max        = 'Eyewear MC Max Coins Pct'
	pbp_b17b_coins_pct_cl_min        = 'Eyewear CL Min Coins Pct'
	pbp_b17b_coins_pct_cl_max        = 'Eyewear CL Max Coins Pct'
	pbp_b17b_coins_pct_egs_min       = 'Eyewear EGS Min Coins Pct'
	pbp_b17b_coins_pct_egs_max       = 'Eyewear EGS Max Coins Pct'
	pbp_b17b_coins_pct_egl_min       = 'Eyewear EGL Min Coins Pct'
	pbp_b17b_coins_pct_egl_max       = 'Eyewear EGL Max Coins Pct'
	pbp_b17b_coins_pct_egf_min       = 'Eyewear EGF Min Coins Pct'
	pbp_b17b_coins_pct_egf_max       = 'Eyewear EGF Max Coins Pct'
	pbp_b17b_coins_pct_upg_min       = 'Eyewear UPG Min Coins Pct'
	pbp_b17b_coins_pct_upg_max       = 'Eyewear UPG Max Coins Pct'
	pbp_b17b_ded_yn                  = 'Eyewear Deduct MC YN'
	pbp_b17b_ded_amt                 = 'Eyewear Deduct MC Amt'
	pbp_b17b_ded_nmc_yn              = 'Eyewear Deduct NMC YN'
	pbp_b17b_ded_nmc_amt             = 'Eyewear Deduct NMC Amt'
	pbp_b17b_copay_yn                = 'Eyewear Copayment YN'
	pbp_b17b_copay_ehc               = 'Eyewear Benefits Copayment'
	pbp_b17b_copay_amt_mc_min        = 'Eyewear MC Min Copay Amt'
	pbp_b17b_copay_amt_mc_max        = 'Eyewear MC Max Copay Amt'
	pbp_b17b_copay_amt_cl_min        = 'Eyewear CL Min Copay Amt'
	pbp_b17b_copay_amt_cl_max        = 'Eyewear CL Max Copay Amt'
	pbp_b17b_copay_amt_egs_min       = 'Eyewear EGS Min Copay Amt'
	pbp_b17b_copay_amt_egs_max       = 'Eyewear EGS Max Copay Amt'
	pbp_b17b_copay_amt_egl_min       = 'Eyewear EGL Min Copay Amt'
	pbp_b17b_copay_amt_egl_max       = 'Eyewear EGL Max Copay Amt'
	pbp_b17b_copay_amt_egf_min       = 'Eyewear EGF Min Copay Amt'
	pbp_b17b_copay_amt_egf_max       = 'Eyewear EGF Max Copay Amt'
	pbp_b17b_copay_amt_upg_min       = 'Eyewear UPG Min Copay Amt'
	pbp_b17b_copay_amt_upg_max       = 'Eyewear UPG Max Copay Amt'
	pbp_b17b_auth_yn                 = 'Eyewear Enrollee Auth'
	pbp_b17b_refer_yn                = 'Eyewear Referral YN'
;

run;

proc sort data = pbp_b17 out=out.pbp_b17;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b17(obs = 10);
  title 'pbp_b17_eye_exams_wear file ';
run;

proc means data = out.pbp_b17;
  title 'pbp_b17_eye_exams_wear file ';
run;

proc freq data = out.pbp_b17;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b17a_bendesc_yn
	pbp_b17a_bendesc_ehc
	pbp_b17a_bendesc_amo_rex
	pbp_b17a_bendesc_lim_rex
	pbp_b17a_bendesc_per_rex
	pbp_b17a_bendesc_amo_other
	pbp_b17a_bendesc_lim_other
	pbp_b17a_bendesc_per_other
	pbp_b17a_maxplan_yn
	pbp_b17a_maxplan_in_oon
	pbp_b17a_maxplan_per
	pbp_b17a_maxenr_yn
	pbp_b17a_maxenr_per
	pbp_b17a_coins_yn
	pbp_b17a_coins_ehc
	pbp_b17a_copay_yn
	pbp_b17a_copay_ehc
	pbp_b17a_ded_yn
	pbp_b17a_ded_nmc_yn
	pbp_b17a_auth_yn
	pbp_b17a_refer_yn
	pbp_b17b_bendesc_yn
	pbp_b17b_bendesc_ehc
	pbp_b17b_bendesc_amo_cl
	pbp_b17b_bendesc_lim_cl
	pbp_b17b_bendesc_per_cl
	pbp_b17b_bendesc_amo_egs
	pbp_b17b_bendesc_lim_egs
	pbp_b17b_bendesc_per_egs
	pbp_b17b_bendesc_amo_egi
	pbp_b17b_bendesc_lim_egl
	pbp_b17b_bendesc_per_egl
	pbp_b17b_bendesc_amo_egf
	pbp_b17b_bendesc_lim_egf
	pbp_b17b_bendesc_per_egf
	pbp_b17b_bendesc_amo_upg
	pbp_b17b_maxplan_yn
	pbp_b17b_maxplan_in_oon
	pbp_b17b_maxplan_type
	pbp_b17b_comb_maxplan_yn
	pbp_b17b_comb_maxplan_per
	pbp_b17b_indv_maxplan_bendesc
	pbp_b17b_indv_maxplan_per_cl
	pbp_b17b_indv_maxplan_per_egs
	pbp_b17b_indv_maxplan_per_egl
	pbp_b17b_indv_maxplan_per_egf
	pbp_b17b_indv_maxplan_per_upg
	pbp_b17b_maxenr_yn
	pbp_b17b_maxenr_type
	pbp_b17b_maxenr_per
	pbp_b17b_coins_yn
	pbp_b17b_ded_yn
	pbp_b17b_ded_nmc_yn
	pbp_b17b_copay_yn
	pbp_b17b_auth_yn
	pbp_b17b_refer_yn
/ missing;
run;

proc contents data = out.pbp_b17;
  title 'pbp_b17 data';
run;