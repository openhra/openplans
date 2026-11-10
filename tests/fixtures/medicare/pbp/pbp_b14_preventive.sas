*pbp_b14_preventive.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b14;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b14a_mc_prevent_attest       $1
	pbp_b14a_auth_yn                 $1
	pbp_b14a_refer_yn                $1
	pbp_b14b_bendesc_yn              $1
	pbp_b14b_bendesc_rpe_amo         $1
	pbp_b14b_maxplan_yn              $1
	pbp_b14b_maxenr_yn               $1
	pbp_b14b_coins_yn                $1
	pbp_b14b_ded_yn                  $1
	pbp_b14b_copay_yn                $1
	pbp_b14b_auth_yn                 $1
	pbp_b14b_refer_yn                $1
	pbp_b14c_bendesc_yn              $1
	pbp_b14c_bendesc_ehc             $4000
	pbp_b14c_bendesc_amo_hec         $1
	pbp_b14c_bendesc_amo_ntb         $1
	pbp_b14c_bendesc_lim_ntb         $1
	pbp_b14c_bendesc_dur_ntb         $1
	pbp_b14c_bendesc_amo_sc          $1
	pbp_b14c_bendesc_amo_mhc         $1
	pbp_b14c_bendesc_typ_mhc         $3
	pbp_b14c_bendesc_amo_edm         $1
	pbp_b14c_bendesc_amo_tm          $1
	pbp_b14c_bendesc_amo_rat         $1
	pbp_b14c_rat_bendesc_ehc         $2
	pbp_b14c_bendesc_amo_bsd         $1
	pbp_b14c_bendesc_amo_cs          $1
	pbp_b14c_bendesc_lim_cs          $1
	pbp_b14c_bendesc_dur_cs          $1
	pbp_b14c_bendesc_amo_isa         $1
	pbp_b14c_bendesc_amo_prs         $1
	pbp_b14c_bendesc_amo_mnt         $1
	pbp_b14c_mnt_mcd_yn              $1
	pbp_b14c_mnt_mcd_unit            $1
	pbp_b14c_mnt_mcd_unit_d          $4000
	pbp_b14c_mnt_nmcd_yn             $1
	pbp_b14c_mnt_nmcd_unit           $1
	pbp_b14c_bendesc_amo_imr         $1
	pbp_b14c_bendesc_amo_rp          $1
	pbp_b14c_rp_bendesc_ehc          $4
	pbp_b14c_rp_bendesc_other        $4000
	pbp_b14c_bendesc_amo_wig         $1
	pbp_b14c_bendesc_amo_wm          $1
	pbp_b14c_bendesc_amo_at          $1
	pbp_b14c_bendesc_lim_at          $1
	pbp_b14c_bendesc_thp_msg         $1
	pbp_b14c_thp_msg_unlimited       $1
	pbp_b14c_thp_msg_period          $1
	pbp_b14c_thp_msg_period_d        $4000
	pbp_b14c_bendesc_adcs            $1
	pbp_b14c_bendesc_hbpc            $1
	pbp_b14c_bendesc_ihss            $1
	pbp_b14c_bendesc_sce             $1
	pbp_b14c_sce_type_chk            $3
	pbp_b14c_sce_note                $4000
	pbp_b14c_maxplan_yn              $1
	pbp_b14c_maxplan_ehc             $4000
	pbp_b14c_maxplan_per_hec         $1
	pbp_b14c_maxplan_per_hec_d       $4000
	pbp_b14c_maxplan_per_ntb         $1
	pbp_b14c_maxplan_per_ntb_d       $4000
	pbp_b14c_maxplan_per_sc          $1
	pbp_b14c_maxplan_per_sc_d        $4000
	pbp_b14c_maxplan_per_mhc         $1
	pbp_b14c_maxplan_per_mhc_d       $4000
	pbp_b14c_maxplan_per_edm         $1
	pbp_b14c_maxplan_per_edm_d       $4000
	pbp_b14c_maxplan_per_tm          $1
	pbp_b14c_maxplan_per_tm_d        $4000
	pbp_b14c_maxplan_per_rat         $1
	pbp_b14c_maxplan_per_rat_d       $4000
	pbp_b14c_maxplan_per_bsd         $1
	pbp_b14c_maxplan_per_bsd_d       $4000
	pbp_b14c_maxplan_per_cs          $1
	pbp_b14c_maxplan_per_cs_d        $4000
	pbp_b14c_maxplan_per_isa         $1
	pbp_b14c_maxplan_per_isa_d       $4000
	pbp_b14c_maxplan_per_prs         $1
	pbp_b14c_maxplan_per_prs_d       $4000
	pbp_b14c_maxplan_per_mnt         $1
	pbp_b14c_maxplan_per_mnt_d       $4000
	pbp_b14c_maxplan_per_imr         $1
	pbp_b14c_maxplan_per_imr_d       $4000
	pbp_b14c_maxplan_per_rp          $1
	pbp_b14c_maxplan_per_rp_d        $4000
	pbp_b14c_maxplan_per_wig         $1
	pbp_b14c_maxplan_per_wig_d       $4000
	pbp_b14c_maxplan_per_wm          $1
	pbp_b14c_maxplan_per_wm_d        $4000
	pbp_b14c_maxplan_per_at          $1
	pbp_b14c_maxplan_per_at_d        $4000
	pbp_b14c_maxplan_per_thms        $1
	pbp_b14c_maxplan_per_thms_d      $4000
	pbp_b14c_maxplan_per_adcs        $1
	pbp_b14c_maxplan_per_adcs_d      $4000
	pbp_b14c_maxplan_per_hbpc        $1
	pbp_b14c_maxplan_per_hbpc_d      $4000
	pbp_b14c_maxplan_per_ihss        $1
	pbp_b14c_maxplan_per_ihss_d      $4000
	pbp_b14c_maxplan_per_sce         $1
	pbp_b14c_maxplan_per_sce_d       $4000
	pbp_b14c_maxenr_yn               $1
	pbp_b14c_maxenr_ehc              $4000
	pbp_b14c_maxenr_per_hec          $1
	pbp_b14c_maxenr_per_hec_d        $4000
	pbp_b14c_maxenr_per_ntb          $1
	pbp_b14c_maxenr_per_ntb_d        $4000
	pbp_b14c_maxenr_per_sc           $1
	pbp_b14c_maxenr_per_sc_d         $4000
	pbp_b14c_maxenr_per_mhc          $1
	pbp_b14c_maxenr_per_mhc_d        $4000
	pbp_b14c_maxenr_per_edm          $1
	pbp_b14c_maxenr_per_edm_d        $4000
	pbp_b14c_maxenr_per_tm           $1
	pbp_b14c_maxenr_per_tm_d         $4000
	pbp_b14c_maxenr_per_rat          $1
	pbp_b14c_maxenr_per_rat_d        $4000
	pbp_b14c_maxenr_per_bsd          $1
	pbp_b14c_maxenr_per_bsd_d        $4000
	pbp_b14c_maxenr_per_cs           $1
	pbp_b14c_maxenr_per_cs_d         $4000
	pbp_b14c_maxenr_per_isa          $1
	pbp_b14c_maxenr_per_isa_d        $4000
	pbp_b14c_maxenr_per_prs          $1
	pbp_b14c_maxenr_per_prs_d        $4000
	pbp_b14c_maxenr_per_mnt          $1
	pbp_b14c_maxenr_per_mnt_d        $4000
	pbp_b14c_maxenr_per_imr          $1
	pbp_b14c_maxenr_per_imr_d        $4000
	pbp_b14c_maxenr_per_rp           $1
	pbp_b14c_maxenr_per_rp_d         $4000
	pbp_b14c_maxenr_per_wig          $1
	pbp_b14c_maxenr_per_wig_d        $4000
	pbp_b14c_maxenr_per_wm           $1
	pbp_b14c_maxenr_per_wm_d         $4000
	pbp_b14c_maxenr_per_at           $1
	pbp_b14c_maxenr_per_at_d         $4000
	pbp_b14c_maxenr_per_thmg         $1
	pbp_b14c_maxenr_per_thmg_d       $4000
	pbp_b14c_maxenr_per_adcs         $1
	pbp_b14c_maxenr_per_adcs_d       $4000
	pbp_b14c_maxenr_per_hbpc         $1
	pbp_b14c_maxenr_per_hbpc_d       $4000
	pbp_b14c_maxenr_per_ihss         $1
	pbp_b14c_maxenr_per_ihss_d       $4000
	pbp_b14c_maxenr_per_sce          $1
	pbp_b14c_maxenr_per_sce_d        $4000
	pbp_b14c_coins_yn                $1
	pbp_b14c_coins_ehc               $4000
	pbp_b14c_ded_yn                  $1
	pbp_b14c_copay_yn                $1
	pbp_b14c_copay_ehc               $4000
	pbp_b14c_auth_yn                 $1
	pbp_b14c_refer_yn                $1
	pbp_b14d_maxenr_yn               $1
	pbp_b14d_maxenr_per              $1
	pbp_b14d_maxenr_per_d            $4000
	pbp_b14d_coins_yn                $1
	pbp_b14d_ded_yn                  $1
	pbp_b14d_copay_yn                $1
	pbp_b14d_auth_yn                 $1
	pbp_b14d_refer_yn                $1
	pbp_b14e_maxenr_yn               $1
	pbp_b14e_maxenr_ehc              $4
	pbp_b14e_maxenr_per_glauc        $1
	pbp_b14e_maxenr_per_glauc_d      $4000
	pbp_b14e_maxenr_per_diab         $1
	pbp_b14e_maxenr_per_diab_d       $4000
	pbp_b14e_maxenr_per_dre          $1
	pbp_b14e_maxenr_per_dre_d        $4000
	pbp_b14e_maxenr_per_ekg          $1
	pbp_b14e_maxenr_per_ekg_d        $4000
	pbp_b14e_coins_yn                $1
	pbp_b14e_coins_ehc               $4
	pbp_b14e_ded_yn                  $1
	pbp_b14e_ded_ehc                 $4
	pbp_b14e_copay_yn                $1
	pbp_b14e_copay_ehc               $4
	pbp_b14e_auth_yn_glauc           $1
	pbp_b14e_auth_yn_diab            $1
	pbp_b14e_auth_yn_dre             $1
	pbp_b14e_auth_yn_ekg             $1
	pbp_b14e_refer_yn                $1
	pbp_b14e_refer_ehc               $4
;

infile '.\pbp\pbp_b14_preventive.txt' delimiter = '09'x
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
	pbp_b14a_mc_prevent_attest
	pbp_b14a_auth_yn
	pbp_b14a_refer_yn
	pbp_b14b_bendesc_yn
	pbp_b14b_bendesc_rpe_amo
	pbp_b14b_maxplan_yn
	pbp_b14b_maxplan_amt
	pbp_b14b_maxenr_yn
	pbp_b14b_maxenr_amt
	pbp_b14b_coins_yn
	pbp_b14b_coins_pct_rpe_min
	pbp_b14b_coins_pct_rpe_max
	pbp_b14b_ded_yn
	pbp_b14b_ded_amt
	pbp_b14b_copay_yn
	pbp_b14b_copay_amt_rpe_min
	pbp_b14b_copay_amt_rpe_max
	pbp_b14b_auth_yn
	pbp_b14b_refer_yn
	pbp_b14c_bendesc_yn
	pbp_b14c_bendesc_ehc
	pbp_b14c_bendesc_amo_hec
	pbp_b14c_bendesc_amo_ntb
	pbp_b14c_bendesc_lim_ntb
	pbp_b14c_bendesc_num_ntb
	pbp_b14c_bendesc_dur_ntb
	pbp_b14c_bendesc_amo_sc
	pbp_b14c_bendesc_visit_num_sc
	pbp_b14c_bendesc_amo_mhc
	pbp_b14c_bendesc_typ_mhc
	pbp_b14c_bendesc_amo_edm
	pbp_b14c_bendesc_amo_tm
	pbp_b14c_bendesc_amo_rat
	pbp_b14c_rat_bendesc_ehc
	pbp_b14c_bendesc_amo_bsd
	pbp_b14c_bendesc_amo_cs
	pbp_b14c_bendesc_lim_cs
	pbp_b14c_bendesc_num_cs
	pbp_b14c_bendesc_dur_cs
	pbp_b14c_bendesc_dur_num_cs
	pbp_b14c_bendesc_amo_isa
	pbp_b14c_bendesc_amo_prs
	pbp_b14c_bendesc_amo_mnt
	pbp_b14c_mnt_mcd_yn
	pbp_b14c_mnt_mcd_unit
	pbp_b14c_mnt_mcd_unit_d
	pbp_b14c_mnt_mcd_num
	pbp_b14c_mnt_nmcd_yn
	pbp_b14c_mnt_nmcd_unit
	pbp_b14c_mnt_nmcd_num
	pbp_b14c_bendesc_amo_imr
	pbp_b14c_bendesc_amo_rp
	pbp_b14c_rp_bendesc_ehc
	pbp_b14c_rp_bendesc_other
	pbp_b14c_bendesc_amo_wig
	pbp_b14c_bendesc_amo_wm
	pbp_b14c_bendesc_amo_at
	pbp_b14c_bendesc_lim_at
	pbp_b14c_at_visits
	pbp_b14c_bendesc_thp_msg
	pbp_b14c_thp_msg_unlimited
	pbp_b14c_thp_msg_num_amt
	pbp_b14c_thp_msg_period
	pbp_b14c_thp_msg_period_d
	pbp_b14c_bendesc_adcs
	pbp_b14c_bendesc_hbpc
	pbp_b14c_bendesc_ihss
	pbp_b14c_bendesc_sce
	pbp_b14c_sce_type_chk
	pbp_b14c_sce_note
	pbp_b14c_maxplan_yn
	pbp_b14c_maxplan_ehc
	pbp_b14c_maxplan_amt_hec
	pbp_b14c_maxplan_per_hec
	pbp_b14c_maxplan_per_hec_d
	pbp_b14c_maxplan_amt_ntb
	pbp_b14c_maxplan_per_ntb
	pbp_b14c_maxplan_per_ntb_d
	pbp_b14c_maxplan_amt_sc
	pbp_b14c_maxplan_per_sc
	pbp_b14c_maxplan_per_sc_d
	pbp_b14c_maxplan_amt_mhc
	pbp_b14c_maxplan_per_mhc
	pbp_b14c_maxplan_per_mhc_d
	pbp_b14c_maxplan_amt_edm
	pbp_b14c_maxplan_per_edm
	pbp_b14c_maxplan_per_edm_d
	pbp_b14c_maxplan_amt_tm
	pbp_b14c_maxplan_per_tm
	pbp_b14c_maxplan_per_tm_d
	pbp_b14c_maxplan_amt_rat
	pbp_b14c_maxplan_per_rat
	pbp_b14c_maxplan_per_rat_d
	pbp_b14c_maxplan_amt_bsd
	pbp_b14c_maxplan_per_bsd
	pbp_b14c_maxplan_per_bsd_d
	pbp_b14c_maxplan_amt_cs
	pbp_b14c_maxplan_per_cs
	pbp_b14c_maxplan_per_cs_d
	pbp_b14c_maxplan_amt_isa
	pbp_b14c_maxplan_per_isa
	pbp_b14c_maxplan_per_isa_d
	pbp_b14c_maxplan_amt_prs
	pbp_b14c_maxplan_per_prs
	pbp_b14c_maxplan_per_prs_d
	pbp_b14c_maxplan_amt_mnt
	pbp_b14c_maxplan_per_mnt
	pbp_b14c_maxplan_per_mnt_d
	pbp_b14c_maxplan_amt_imr
	pbp_b14c_maxplan_per_imr
	pbp_b14c_maxplan_per_imr_d
	pbp_b14c_maxplan_amt_rp
	pbp_b14c_maxplan_per_rp
	pbp_b14c_maxplan_per_rp_d
	pbp_b14c_maxplan_amt_wig
	pbp_b14c_maxplan_per_wig
	pbp_b14c_maxplan_per_wig_d
	pbp_b14c_maxplan_amt_wm
	pbp_b14c_maxplan_per_wm
	pbp_b14c_maxplan_per_wm_d
	pbp_b14c_maxplan_amt_at
	pbp_b14c_maxplan_per_at
	pbp_b14c_maxplan_per_at_d
	pbp_b14c_maxplan_amt_thms
	pbp_b14c_maxplan_per_thms
	pbp_b14c_maxplan_per_thms_d
	pbp_b14c_maxplan_amt_adcs
	pbp_b14c_maxplan_per_adcs
	pbp_b14c_maxplan_per_adcs_d
	pbp_b14c_maxplan_amt_hbpc
	pbp_b14c_maxplan_per_hbpc
	pbp_b14c_maxplan_per_hbpc_d
	pbp_b14c_maxplan_amt_ihss
	pbp_b14c_maxplan_per_ihss
	pbp_b14c_maxplan_per_ihss_d
	pbp_b14c_maxplan_amt_sce
	pbp_b14c_maxplan_per_sce
	pbp_b14c_maxplan_per_sce_d
	pbp_b14c_maxenr_yn
	pbp_b14c_maxenr_ehc
	pbp_b14c_maxenr_amt_hec
	pbp_b14c_maxenr_per_hec
	pbp_b14c_maxenr_per_hec_d
	pbp_b14c_maxenr_amt_ntb
	pbp_b14c_maxenr_per_ntb
	pbp_b14c_maxenr_per_ntb_d
	pbp_b14c_maxenr_amt_sc
	pbp_b14c_maxenr_per_sc
	pbp_b14c_maxenr_per_sc_d
	pbp_b14c_maxenr_amt_mhc
	pbp_b14c_maxenr_per_mhc
	pbp_b14c_maxenr_per_mhc_d
	pbp_b14c_maxenr_amt_edm
	pbp_b14c_maxenr_per_edm
	pbp_b14c_maxenr_per_edm_d
	pbp_b14c_maxenr_amt_tm
	pbp_b14c_maxenr_per_tm
	pbp_b14c_maxenr_per_tm_d
	pbp_b14c_maxenr_amt_rat
	pbp_b14c_maxenr_per_rat
	pbp_b14c_maxenr_per_rat_d
	pbp_b14c_maxenr_amt_bsd
	pbp_b14c_maxenr_per_bsd
	pbp_b14c_maxenr_per_bsd_d
	pbp_b14c_maxenr_amt_cs
	pbp_b14c_maxenr_per_cs
	pbp_b14c_maxenr_per_cs_d
	pbp_b14c_maxenr_amt_isa
	pbp_b14c_maxenr_per_isa
	pbp_b14c_maxenr_per_isa_d
	pbp_b14c_maxenr_amt_prs
	pbp_b14c_maxenr_per_prs
	pbp_b14c_maxenr_per_prs_d
	pbp_b14c_maxenr_amt_mnt
	pbp_b14c_maxenr_per_mnt
	pbp_b14c_maxenr_per_mnt_d
	pbp_b14c_maxenr_amt_imr
	pbp_b14c_maxenr_per_imr
	pbp_b14c_maxenr_per_imr_d
	pbp_b14c_maxenr_amt_rp
	pbp_b14c_maxenr_per_rp
	pbp_b14c_maxenr_per_rp_d
	pbp_b14c_maxenr_amt_wig
	pbp_b14c_maxenr_per_wig
	pbp_b14c_maxenr_per_wig_d
	pbp_b14c_maxenr_amt_wm
	pbp_b14c_maxenr_per_wm
	pbp_b14c_maxenr_per_wm_d
	pbp_b14c_maxenr_amt_at
	pbp_b14c_maxenr_per_at
	pbp_b14c_maxenr_per_at_d
	pbp_b14c_maxenr_amt_thmg
	pbp_b14c_maxenr_per_thmg
	pbp_b14c_maxenr_per_thmg_d
	pbp_b14c_maxenr_amt_adcs
	pbp_b14c_maxenr_per_adcs
	pbp_b14c_maxenr_per_adcs_d
	pbp_b14c_maxenr_amt_hbpc
	pbp_b14c_maxenr_per_hbpc
	pbp_b14c_maxenr_per_hbpc_d
	pbp_b14c_maxenr_amt_ihss
	pbp_b14c_maxenr_per_ihss
	pbp_b14c_maxenr_per_ihss_d
	pbp_b14c_maxenr_amt_sce
	pbp_b14c_maxenr_per_sce
	pbp_b14c_maxenr_per_sce_d
	pbp_b14c_coins_yn
	pbp_b14c_coins_ehc
	pbp_b14c_coins_pct_min_hec
	pbp_b14c_coins_pct_max_hec
	pbp_b14c_coins_pct_min_ntb
	pbp_b14c_coins_pct_max_ntb
	pbp_b14c_coins_pct_min_sc
	pbp_b14c_coins_pct_max_sc
	pbp_b14c_coins_pct_min_mhc
	pbp_b14c_coins_pct_max_mhc
	pbp_b14c_coins_pct_min_edm
	pbp_b14c_coins_pct_max_edm
	pbp_b14c_coins_pct_min_tm
	pbp_b14c_coins_pct_max_tm
	pbp_b14c_coins_pct_min_rat_wp
	pbp_b14c_coins_pct_max_rat_wp
	pbp_b14c_coins_pct_min_rat_nh
	pbp_b14c_coins_pct_max_rat_nh
	pbp_b14c_coins_pct_min_bsd
	pbp_b14c_coins_pct_max_bsd
	pbp_b14c_coins_pct_min_cs
	pbp_b14c_coins_pct_max_cs
	pbp_b14c_coins_pct_min_isa
	pbp_b14c_coins_pct_max_isa
	pbp_b14c_coins_pct_min_prs
	pbp_b14c_coins_pct_max_prs
	pbp_b14c_coins_pct_min_mnt
	pbp_b14c_coins_pct_max_mnt
	pbp_b14c_coins_pct_min_imr
	pbp_b14c_coins_pct_max_imr
	pbp_b14c_coins_pct_min_rp
	pbp_b14c_coins_pct_max_rp
	pbp_b14c_coins_pct_min_wig
	pbp_b14c_coins_pct_max_wig
	pbp_b14c_coins_pct_min_wm
	pbp_b14c_coins_pct_max_wm
	pbp_b14c_coins_pct_min_at
	pbp_b14c_coins_pct_max_at
	pbp_b14c_coins_pct_min_thmg
	pbp_b14c_coins_pct_max_thmg
	pbp_b14c_coins_pct_min_adcs
	pbp_b14c_coins_pct_max_adcs
	pbp_b14c_coins_pct_min_hbpc
	pbp_b14c_coins_pct_max_hbpc
	pbp_b14c_coins_pct_min_ihss
	pbp_b14c_coins_pct_max_ihss
	pbp_b14c_coins_pct_min_sce
	pbp_b14c_coins_pct_max_sce
	pbp_b14c_ded_yn
	pbp_b14c_ded_amt
	pbp_b14c_copay_yn
	pbp_b14c_copay_ehc
	pbp_b14c_copay_hec_min_amt
	pbp_b14c_copay_hec_max_amt
	pbp_b14c_copay_ntb_min_amt
	pbp_b14c_copay_ntb_max_amt
	pbp_b14c_copay_sc_min_amt
	pbp_b14c_copay_sc_max_amt
	pbp_b14c_copay_mhc_min_amt
	pbp_b14c_copay_mhc_max_amt
	pbp_b14c_copay_edm_min_amt
	pbp_b14c_copay_edm_max_amt
	pbp_b14c_copay_tm_min_amt
	pbp_b14c_copay_tm_max_amt
	pbp_b14c_copay_rat_wp_min_amt
	pbp_b14c_copay_rat_wp_max_amt
	pbp_b14c_copay_rat_nh_min_amt
	pbp_b14c_copay_rat_nh_max_amt
	pbp_b14c_copay_bsd_min_amt
	pbp_b14c_copay_bsd_max_amt
	pbp_b14c_copay_cs_min_amt
	pbp_b14c_copay_cs_max_amt
	pbp_b14c_copay_isa_min_amt
	pbp_b14c_copay_isa_max_amt
	pbp_b14c_copay_prs_min_amt
	pbp_b14c_copay_prs_max_amt
	pbp_b14c_copay_mnt_min_amt
	pbp_b14c_copay_mnt_max_amt
	pbp_b14c_copay_imr_min_amt
	pbp_b14c_copay_imr_max_amt
	pbp_b14c_copay_rp_min_amt
	pbp_b14c_copay_rp_max_amt
	pbp_b14c_copay_wig_min_amt
	pbp_b14c_copay_wig_max_amt
	pbp_b14c_copay_wm_min_amt
	pbp_b14c_copay_wm_max_amt
	pbp_b14c_copay_at_min_amt
	pbp_b14c_copay_at_max_amt
	pbp_b14c_copay_min_amt_thmg
	pbp_b14c_copay_max_amt_thmg
	pbp_b14c_copay_min_amt_adcs
	pbp_b14c_copay_max_amt_adcs
	pbp_b14c_copay_min_amt_hbpc
	pbp_b14c_copay_max_amt_hbpc
	pbp_b14c_copay_min_amt_ihss
	pbp_b14c_copay_max_amt_ihss
	pbp_b14c_copay_min_amt_sce
	pbp_b14c_copay_max_amt_sce
	pbp_b14c_auth_yn
	pbp_b14c_refer_yn
	pbp_b14d_maxenr_yn
	pbp_b14d_maxenr_amt
	pbp_b14d_maxenr_per
	pbp_b14d_maxenr_per_d
	pbp_b14d_coins_yn
	pbp_b14d_coins_mc_min_pct
	pbp_b14d_coins_mc_max_pct
	pbp_b14d_ded_yn
	pbp_b14d_ded_amt
	pbp_b14d_copay_yn
	pbp_b14d_copay_mc_min_amt
	pbp_b14d_copay_mc_max_amt
	pbp_b14d_auth_yn
	pbp_b14d_refer_yn
	pbp_b14e_maxenr_yn
	pbp_b14e_maxenr_ehc
	pbp_b14e_maxenr_amt_glauc
	pbp_b14e_maxenr_per_glauc
	pbp_b14e_maxenr_per_glauc_d
	pbp_b14e_maxenr_amt_diab
	pbp_b14e_maxenr_per_diab
	pbp_b14e_maxenr_per_diab_d
	pbp_b14e_maxenr_amt_dre
	pbp_b14e_maxenr_per_dre
	pbp_b14e_maxenr_per_dre_d
	pbp_b14e_maxenr_amt_ekg
	pbp_b14e_maxenr_per_ekg
	pbp_b14e_maxenr_per_ekg_d
	pbp_b14e_coins_yn
	pbp_b14e_coins_ehc
	pbp_b14e_coins_pct_min_glauc
	pbp_b14e_coins_pct_max_glauc
	pbp_b14e_coins_pct_min_diab
	pbp_b14e_coins_pct_max_diab
	pbp_b14e_coins_pct_min_dre
	pbp_b14e_coins_pct_max_dre
	pbp_b14e_coins_pct_min_ekg
	pbp_b14e_coins_pct_max_ekg
	pbp_b14e_ded_yn
	pbp_b14e_ded_ehc
	pbp_b14e_ded_amt_glauc
	pbp_b14e_ded_amt_diab
	pbp_b14e_ded_amt_dre
	pbp_b14e_ded_amt_ekg
	pbp_b14e_copay_yn
	pbp_b14e_copay_ehc
	pbp_b14e_copay_amt_min_glauc
	pbp_b14e_copay_amt_max_glauc
	pbp_b14e_copay_amt_min_diab
	pbp_b14e_copay_amt_max_diab
	pbp_b14e_copay_amt_min_dre
	pbp_b14e_copay_amt_max_dre
	pbp_b14e_copay_amt_min_ekg
	pbp_b14e_copay_amt_max_ekg
	pbp_b14e_auth_yn_glauc
	pbp_b14e_auth_yn_diab
	pbp_b14e_auth_yn_dre
	pbp_b14e_auth_yn_ekg
	pbp_b14e_refer_yn
	pbp_b14e_refer_ehc
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
	pbp_b14a_mc_prevent_attest       = 'Zero $ Prevent attest'
	pbp_b14a_auth_yn                 = 'Zero $ Prevent Auth YN'
	pbp_b14a_refer_yn                = 'Zero $ Prevent Refer YN'
	pbp_b14b_bendesc_yn              = 'AnnPhysExam Ben Desc YN'
	pbp_b14b_bendesc_rpe_amo         = 'AnnPhysExam Ben Desc AMO'
	pbp_b14b_maxplan_yn              = 'AnnPhysExam Max Plan YN'
	pbp_b14b_maxplan_amt             = 'AnnPhysExam Max Plan Amt'
	pbp_b14b_maxenr_yn               = 'AnnPhysExam Max Enr YN'
	pbp_b14b_maxenr_amt              = 'AnnPhysExam Max Enr Amt'
	pbp_b14b_coins_yn                = 'AnnPhysExam Coinsurance YN'
	pbp_b14b_coins_pct_rpe_min       = 'AnnPhysExam Min Coins Pct'
	pbp_b14b_coins_pct_rpe_max       = 'AnnPhysExam Max Coins Pct'
	pbp_b14b_ded_yn                  = 'AnnPhysExam Deductible YN'
	pbp_b14b_ded_amt                 = 'AnnPhysExam Deductible Amt'
	pbp_b14b_copay_yn                = 'AnnPhysExam Copayment YN'
	pbp_b14b_copay_amt_rpe_min       = 'AnnPhysExam Min Copay Amt'
	pbp_b14b_copay_amt_rpe_max       = 'AnnPhysExam Max Copay Amt'
	pbp_b14b_auth_yn                 = 'AnnPhysExam Enrollee Auth YN'
	pbp_b14b_refer_yn                = 'AnnPhysExam Referral YN'
	pbp_b14c_bendesc_yn              = '14C Supp Bens YN'
	pbp_b14c_bendesc_ehc             = '14C Supp Benefits'
	pbp_b14c_bendesc_amo_hec         = '14C Health Ed HEC Ben AMO'
	pbp_b14c_bendesc_amo_ntb         = '14C Health Ed NTB Ben AMO'
	pbp_b14c_bendesc_lim_ntb         = '14C Nut Ben Lim'
	pbp_b14c_bendesc_num_ntb         = '14C Nut Ben Lim Num'
	pbp_b14c_bendesc_dur_ntb         = '14C Nut Ben Dur'
	pbp_b14c_bendesc_amo_sc          = '14C Health Ed SC Ben AMO'
	pbp_b14c_bendesc_visit_num_sc    = '14C SC Num Visits'
	pbp_b14c_bendesc_amo_mhc         = '14C FB Ben Desc AMO'
	pbp_b14c_bendesc_typ_mhc         = '14C Fitness Ben Type'
	pbp_b14c_bendesc_amo_edm         = '14C Health Ed EDM AMO'
	pbp_b14c_bendesc_amo_tm          = '14C Health Ed TM AMO'
	pbp_b14c_bendesc_amo_rat         = '14C Health Ed RAT AMO'
	pbp_b14c_rat_bendesc_ehc         = '14C RAT benefit Type'
	pbp_b14c_bendesc_amo_bsd         = '14C BSD Benefit AMO'
	pbp_b14c_bendesc_amo_cs          = '14C CS Benefit AMO'
	pbp_b14c_bendesc_lim_cs          = '14C CS Ben Lim'
	pbp_b14c_bendesc_num_cs          = '14C CS Ben Lim Num'
	pbp_b14c_bendesc_dur_cs          = '14C CS Ben Dur'
	pbp_b14c_bendesc_dur_num_cs      = '14C CS Dur Dur Num'
	pbp_b14c_bendesc_amo_isa         = '14C ISA Benefit AMO'
	pbp_b14c_bendesc_amo_prs         = '14C PRS Benefit AMO'
	pbp_b14c_bendesc_amo_mnt         = '14C MNT Benefit AMO'
	pbp_b14c_mnt_mcd_yn              = '14C MNT diseases yn'
	pbp_b14c_mnt_mcd_unit            = '14C MNT diseases unit'
	pbp_b14c_mnt_mcd_unit_d          = '14C MNT unit desc'
	pbp_b14c_mnt_mcd_num             = '14C MNT diseases num'
	pbp_b14c_mnt_nmcd_yn             = '14C MNT Coverage NMC diseases'
	pbp_b14c_mnt_nmcd_unit           = '14C MNT Coverage NMC dis unit'
	pbp_b14c_mnt_nmcd_num            = '14C MNT Coverage NMC dis num'
	pbp_b14c_bendesc_amo_imr         = '14C IMR BENDESC_AMO Label'
	pbp_b14c_bendesc_amo_rp          = '14C RP Benefit AMO'
	pbp_b14c_rp_bendesc_ehc          = '14C RP Benefit List'
	pbp_b14c_rp_bendesc_other        = '14C Other RP Service Name'
	pbp_b14c_bendesc_amo_wig         = '14C WIG Benefit AMO'
	pbp_b14c_bendesc_amo_wm          = '14C Weight Mngmt Benefit AMO'
	pbp_b14c_bendesc_amo_at          = '14C AT Benefit AMO'
	pbp_b14c_bendesc_lim_at          = '14C AT Ben Desc Lim'
	pbp_b14c_at_visits               = '14C Visits AT'
	pbp_b14c_bendesc_thp_msg         = '14C Ther Mssg Beneefit AMO'
	pbp_b14c_thp_msg_unlimited       = '14C Ther Mssg Unlimited'
	pbp_b14c_thp_msg_num_amt         = '14C Ther Mssg # Sessions'
	pbp_b14c_thp_msg_period          = '14C Ther Mssg Periodicity'
	pbp_b14c_thp_msg_period_d        = '14C Ther Mssg Period Desc'
	pbp_b14c_bendesc_adcs            = '14C Adult Day Care Svc AMO'
	pbp_b14c_bendesc_hbpc            = '14C Home Bsd Pal Care AMO'
	pbp_b14c_bendesc_ihss            = '14C In Hme Sppt Svc AMO'
	pbp_b14c_bendesc_sce             = '14C Spt Cre Give Enr AMO'
	pbp_b14c_sce_type_chk            = '14C Support Caregiver Type'
	pbp_b14c_sce_note                = '14C Caregiver Other note'
	pbp_b14c_maxplan_yn              = '14C Max Plan YN'
	pbp_b14c_maxplan_ehc             = '14C Maxplan enhanced bens'
	pbp_b14c_maxplan_amt_hec         = '14C HEC Max Plan Amt'
	pbp_b14c_maxplan_per_hec         = '14C HEC Max Plan Per'
	pbp_b14c_maxplan_per_hec_d       = '14C HEC Max Plan Per Desc'
	pbp_b14c_maxplan_amt_ntb         = '14C NTB Max Plan Amt'
	pbp_b14c_maxplan_per_ntb         = '14C NTB Max Plan Per'
	pbp_b14c_maxplan_per_ntb_d       = '14C NTB Max Plan Per Desc'
	pbp_b14c_maxplan_amt_sc          = '14C SC Max Plan Amt'
	pbp_b14c_maxplan_per_sc          = '14C SC Max Plan Per'
	pbp_b14c_maxplan_per_sc_d        = '14C SC Max Plan Per Desc'
	pbp_b14c_maxplan_amt_mhc         = '14C MHC Max Plan Amt'
	pbp_b14c_maxplan_per_mhc         = '14C MHC Max Plan Per'
	pbp_b14c_maxplan_per_mhc_d       = '14C MHC Max Plan Per Desc'
	pbp_b14c_maxplan_amt_edm         = '14C EDM Max Plan Amt'
	pbp_b14c_maxplan_per_edm         = '14C EDM Max Plan Per'
	pbp_b14c_maxplan_per_edm_d       = '14C EDM Max Plan Per Desc'
	pbp_b14c_maxplan_amt_tm          = '14C TM Max Plan Amt'
	pbp_b14c_maxplan_per_tm          = '14C TM Max Plan Per'
	pbp_b14c_maxplan_per_tm_d        = '14C TM Max Plan Per Desc'
	pbp_b14c_maxplan_amt_rat         = '14C RAT Max Plan Amt'
	pbp_b14c_maxplan_per_rat         = '14C RAT Max Plan Per'
	pbp_b14c_maxplan_per_rat_d       = '14C RAT Max Plan Per Desc'
	pbp_b14c_maxplan_amt_bsd         = '14C BSD Max Plan Amt'
	pbp_b14c_maxplan_per_bsd         = '14C BSD Max Plan Per'
	pbp_b14c_maxplan_per_bsd_d       = '14C BSD Max Plan Per Desc'
	pbp_b14c_maxplan_amt_cs          = '14C CS Max Plan Amt'
	pbp_b14c_maxplan_per_cs          = '14C CS Max Plan Per'
	pbp_b14c_maxplan_per_cs_d        = '14C CS Max Plan Per Desc'
	pbp_b14c_maxplan_amt_isa         = '14C ISA Max Plan Amt'
	pbp_b14c_maxplan_per_isa         = '14C ISA Max Plan Per'
	pbp_b14c_maxplan_per_isa_d       = '14C ISA Max Plan Per Desc'
	pbp_b14c_maxplan_amt_prs         = '14C PRS Max Plan Amt'
	pbp_b14c_maxplan_per_prs         = '14C PRS Max Plan Per'
	pbp_b14c_maxplan_per_prs_d       = '14C PRS Max Plan Per Desc'
	pbp_b14c_maxplan_amt_mnt         = '14C MNT Max Plan Amt'
	pbp_b14c_maxplan_per_mnt         = '14C MNT Max Plan Per'
	pbp_b14c_maxplan_per_mnt_d       = '14C MNT Max Plan Per Desc'
	pbp_b14c_maxplan_amt_imr         = '14C IMR Max Plan Amt'
	pbp_b14c_maxplan_per_imr         = '14C IMR Max Plan Per'
	pbp_b14c_maxplan_per_imr_d       = '14C IMR Max Plan Per Desc'
	pbp_b14c_maxplan_amt_rp          = '14C RP Max Plan Amt'
	pbp_b14c_maxplan_per_rp          = '14C RP Max Plan Per'
	pbp_b14c_maxplan_per_rp_d        = '14C RP Max Plan Per Desc'
	pbp_b14c_maxplan_amt_wig         = '14C WIG Max Plan Amt'
	pbp_b14c_maxplan_per_wig         = '14C WIG Max Plan Per'
	pbp_b14c_maxplan_per_wig_d       = '14C WIG Max Plan Per Desc'
	pbp_b14c_maxplan_amt_wm          = '14C WMP Max Plan Amt'
	pbp_b14c_maxplan_per_wm          = '14C WMP Max Plan Per'
	pbp_b14c_maxplan_per_wm_d        = '14C WMP Max Plan Per Desc'
	pbp_b14c_maxplan_amt_at          = '14C ALT Max Plan Amt'
	pbp_b14c_maxplan_per_at          = '14C ALT Max Plan Per'
	pbp_b14c_maxplan_per_at_d        = '14C ALT Max Plan Per Desc'
	pbp_b14c_maxplan_amt_thms        = '14C THMS Max Plan Amt'
	pbp_b14c_maxplan_per_thms        = '14C THMS Max Plan Per'
	pbp_b14c_maxplan_per_thms_d      = '14C THMS Max Plan Per Desc'
	pbp_b14c_maxplan_amt_adcs        = '14C ADCS Max Plan Amt'
	pbp_b14c_maxplan_per_adcs        = '14C ADCS Max Plan Per'
	pbp_b14c_maxplan_per_adcs_d      = '14C ADCS Max Plan Per Desc'
	pbp_b14c_maxplan_amt_hbpc        = '14C HBPC Max Plan Amt'
	pbp_b14c_maxplan_per_hbpc        = '14C HBPC Max Plan Per'
	pbp_b14c_maxplan_per_hbpc_d      = '14C HBPC Max Plan Per Desc'
	pbp_b14c_maxplan_amt_ihss        = '14C IHSS Max Plan Amt'
	pbp_b14c_maxplan_per_ihss        = '14C IHSS Max Plan Per'
	pbp_b14c_maxplan_per_ihss_d      = '14C IHSS Max Plan Per Desc'
	pbp_b14c_maxplan_amt_sce         = '14C SCE Max Plan Amt'
	pbp_b14c_maxplan_per_sce         = '14C SCE Max Plan Per'
	pbp_b14c_maxplan_per_sce_d       = '14C SCE Max Plan Per Desc'
	pbp_b14c_maxenr_yn               = '14C Max Enr YN'
	pbp_b14c_maxenr_ehc              = '14C Max Enr enhanced bens'
	pbp_b14c_maxenr_amt_hec          = '14C HEC Max Enr Amt'
	pbp_b14c_maxenr_per_hec          = '14C HEC Max Enr Per'
	pbp_b14c_maxenr_per_hec_d        = '14C HEC Max Enr Per Desc'
	pbp_b14c_maxenr_amt_ntb          = '14C NTB Max Enr Amt'
	pbp_b14c_maxenr_per_ntb          = '14C NTB Max Enr Per'
	pbp_b14c_maxenr_per_ntb_d        = '14C NTB Max Enr Per Desc'
	pbp_b14c_maxenr_amt_sc           = '14C SC Max Enr Amt'
	pbp_b14c_maxenr_per_sc           = '14C SC Max Enr Per'
	pbp_b14c_maxenr_per_sc_d         = '14C SC Max Enr Per Desc'
	pbp_b14c_maxenr_amt_mhc          = '14C MHC Max Enr Amt'
	pbp_b14c_maxenr_per_mhc          = '14C MHC Max Enr Per'
	pbp_b14c_maxenr_per_mhc_d        = '14C MHC Max Enr Per Desc'
	pbp_b14c_maxenr_amt_edm          = '14C EDM Max Enr Amt'
	pbp_b14c_maxenr_per_edm          = '14C EDM Max Enr Per'
	pbp_b14c_maxenr_per_edm_d        = '14C EDM Max Enr Per Desc'
	pbp_b14c_maxenr_amt_tm           = '14C TM Max Enr Amt'
	pbp_b14c_maxenr_per_tm           = '14C TM Max Enr Per'
	pbp_b14c_maxenr_per_tm_d         = '14C TM Max Enr Per Desc'
	pbp_b14c_maxenr_amt_rat          = '14C RAT Max Enr Amt'
	pbp_b14c_maxenr_per_rat          = '14C RAT Max Enr Per'
	pbp_b14c_maxenr_per_rat_d        = '14C RAT Max Enr Per Desc'
	pbp_b14c_maxenr_amt_bsd          = '14C BSD Max Enr Amt'
	pbp_b14c_maxenr_per_bsd          = '14C BSD Max Enr Per'
	pbp_b14c_maxenr_per_bsd_d        = '14C BSD Max Enr Per Desc'
	pbp_b14c_maxenr_amt_cs           = '14C CS Max Enr Amt'
	pbp_b14c_maxenr_per_cs           = '14C CS Max Enr Per'
	pbp_b14c_maxenr_per_cs_d         = '14C CS Max Enr Per Desc'
	pbp_b14c_maxenr_amt_isa          = '14C ISA Max Enr Amt'
	pbp_b14c_maxenr_per_isa          = '14C ISA Max Enr Per'
	pbp_b14c_maxenr_per_isa_d        = '14C ISA Max Enr Per Desc'
	pbp_b14c_maxenr_amt_prs          = '14C PRS Max Enr Amt'
	pbp_b14c_maxenr_per_prs          = '14C PRS Max Enr Per'
	pbp_b14c_maxenr_per_prs_d        = '14C PRS Max Enr Per Desc'
	pbp_b14c_maxenr_amt_mnt          = '14C MNT Max Enr Amt'
	pbp_b14c_maxenr_per_mnt          = '14C MNT Max Enr Per'
	pbp_b14c_maxenr_per_mnt_d        = '14C MNT Max Enr Per Desc'
	pbp_b14c_maxenr_amt_imr          = '14C IMR Max Enr Amt'
	pbp_b14c_maxenr_per_imr          = '14C IMR Max Enr Per'
	pbp_b14c_maxenr_per_imr_d        = '14C IMR Max Enr Per Desc'
	pbp_b14c_maxenr_amt_rp           = '14C RP Max Enr Amt'
	pbp_b14c_maxenr_per_rp           = '14C RP Max Enr Per'
	pbp_b14c_maxenr_per_rp_d         = '14C RP Max Enr Per Desc'
	pbp_b14c_maxenr_amt_wig          = '14C WIG Max Enr Amt'
	pbp_b14c_maxenr_per_wig          = '14C WIG Max Enr Per'
	pbp_b14c_maxenr_per_wig_d        = '14C WIG Max Enr Per Desc'
	pbp_b14c_maxenr_amt_wm           = '14C WM Max Enr Amt'
	pbp_b14c_maxenr_per_wm           = '14C WM Max Enr Per'
	pbp_b14c_maxenr_per_wm_d         = '14C WM Max Enr Per Desc'
	pbp_b14c_maxenr_amt_at           = '14C AT Max Enr Amt'
	pbp_b14c_maxenr_per_at           = '14C AT Max Enr Per'
	pbp_b14c_maxenr_per_at_d         = '14C AT Max Enr Per Desc'
	pbp_b14c_maxenr_amt_thmg         = '14C THMG Max Enr Amt'
	pbp_b14c_maxenr_per_thmg         = '14C THMG Max Enr Per'
	pbp_b14c_maxenr_per_thmg_d       = '14C THMG Max Enr Per Desc'
	pbp_b14c_maxenr_amt_adcs         = '14C ADCS Max Enr Amt'
	pbp_b14c_maxenr_per_adcs         = '14C ADCS Max Enr Per'
	pbp_b14c_maxenr_per_adcs_d       = '14C ADCS Max Enr Per Desc'
	pbp_b14c_maxenr_amt_hbpc         = '14C HBPC Max Enr Amt'
	pbp_b14c_maxenr_per_hbpc         = '14C HBPC Max Enr Per'
	pbp_b14c_maxenr_per_hbpc_d       = '14C HBPC Max Enr Per Desc'
	pbp_b14c_maxenr_amt_ihss         = '14C IHSS Max Enr Amt'
	pbp_b14c_maxenr_per_ihss         = '14C IHSS Max Enr Per'
	pbp_b14c_maxenr_per_ihss_d       = '14C IHSS Max Enr Per Desc'
	pbp_b14c_maxenr_amt_sce          = '14C SCE Max Enr Amt'
	pbp_b14c_maxenr_per_sce          = '14C SCE Max Enr Per'
	pbp_b14c_maxenr_per_sce_d        = '14C SCE Max Enr Per Desc'
	pbp_b14c_coins_yn                = '14C Coinsurance YN'
	pbp_b14c_coins_ehc               = '14C Coins Enhance Bens'
	pbp_b14c_coins_pct_min_hec       = '14C Health Ed HEC Min Coins'
	pbp_b14c_coins_pct_max_hec       = '14C Health Ed HEC Max Coins'
	pbp_b14c_coins_pct_min_ntb       = '14C Health Ed NTB Coins min'
	pbp_b14c_coins_pct_max_ntb       = '14C Health Ed NTB Coins max'
	pbp_b14c_coins_pct_min_sc        = '14C Health Ed SC Coins min'
	pbp_b14c_coins_pct_max_sc        = '14C Health Ed SC Coins max'
	pbp_b14c_coins_pct_min_mhc       = '14C MHC Min Coins'
	pbp_b14c_coins_pct_max_mhc       = '14C MHC Max Coins'
	pbp_b14c_coins_pct_min_edm       = '14C EDM Coinsurance min'
	pbp_b14c_coins_pct_max_edm       = '14C EDM Coinsurance max'
	pbp_b14c_coins_pct_min_tm        = '14C TM Coinsurance min'
	pbp_b14c_coins_pct_max_tm        = '14C TM Coinsurance max'
	pbp_b14c_coins_pct_min_rat_wp    = '14C RAT WP Coins min'
	pbp_b14c_coins_pct_max_rat_wp    = '14C RAT WP Coins max'
	pbp_b14c_coins_pct_min_rat_nh    = '14C RAT NH Coins min'
	pbp_b14c_coins_pct_max_rat_nh    = '14C RAT NH Coins min'
	pbp_b14c_coins_pct_min_bsd       = '14C BSD Coins min'
	pbp_b14c_coins_pct_max_bsd       = '14C BSD Coins max'
	pbp_b14c_coins_pct_min_cs        = '14C CS Coins min'
	pbp_b14c_coins_pct_max_cs        = '14C CS Coins max'
	pbp_b14c_coins_pct_min_isa       = '14C ISA Coins min'
	pbp_b14c_coins_pct_max_isa       = '14C ISA Coins max'
	pbp_b14c_coins_pct_min_prs       = '14C PRS Coins min'
	pbp_b14c_coins_pct_max_prs       = '14C PRS Coins max'
	pbp_b14c_coins_pct_min_mnt       = '14C MNT Coins min'
	pbp_b14c_coins_pct_max_mnt       = '14C MNT Coins max'
	pbp_b14c_coins_pct_min_imr       = '14C IMR Coins min'
	pbp_b14c_coins_pct_max_imr       = '14C IMR Coins max'
	pbp_b14c_coins_pct_min_rp        = '14C RP Coins min'
	pbp_b14c_coins_pct_max_rp        = '14C RP Coins max'
	pbp_b14c_coins_pct_min_wig       = '14C WIG Coins min'
	pbp_b14c_coins_pct_max_wig       = '14C WIG Coins max'
	pbp_b14c_coins_pct_min_wm        = '14C WeightManage Min Coins'
	pbp_b14c_coins_pct_max_wm        = '14C WeightManage Max Coins'
	pbp_b14c_coins_pct_min_at        = '14C AltTherapy Min Coins'
	pbp_b14c_coins_pct_max_at        = '14C AltTherapy Max Coins'
	pbp_b14c_coins_pct_min_thmg      = '14C THMG Min Coins'
	pbp_b14c_coins_pct_max_thmg      = '14C THMG Max Coins'
	pbp_b14c_coins_pct_min_adcs      = '14C ADCS Min Coins'
	pbp_b14c_coins_pct_max_adcs      = '14C ADCS Max Coins'
	pbp_b14c_coins_pct_min_hbpc      = '14C HBPC Min Coins'
	pbp_b14c_coins_pct_max_hbpc      = '14C HBPC Max Coins'
	pbp_b14c_coins_pct_min_ihss      = '14C IHSS Min Coins'
	pbp_b14c_coins_pct_max_ihss      = '14C IHSS Max Coins'
	pbp_b14c_coins_pct_min_sce       = '14C SCE Min Coins'
	pbp_b14c_coins_pct_max_sce       = '14C SCE Max Coins'
	pbp_b14c_ded_yn                  = '14C Deductible YN'
	pbp_b14c_ded_amt                 = '14C Deductible Amt'
	pbp_b14c_copay_yn                = '14C Copayment YN'
	pbp_b14c_copay_ehc               = '14C Copay Enhanced Bens'
	pbp_b14c_copay_hec_min_amt       = '14C Health Ed HEC Copay Min'
	pbp_b14c_copay_hec_max_amt       = '14C Health Ed HEC Copay Max'
	pbp_b14c_copay_ntb_min_amt       = '14C Health Ed NTB Copay min'
	pbp_b14c_copay_ntb_max_amt       = '14C Health Ed NTB Copay max'
	pbp_b14c_copay_sc_min_amt        = '14C Health Ed SC Copay min'
	pbp_b14c_copay_sc_max_amt        = '14C Health Ed SC Copay max'
	pbp_b14c_copay_mhc_min_amt       = '14C FB Min Copay'
	pbp_b14c_copay_mhc_max_amt       = '14C FB Max Copay'
	pbp_b14c_copay_edm_min_amt       = '14C EDM Copayment min'
	pbp_b14c_copay_edm_max_amt       = '14C EDM Copayment max'
	pbp_b14c_copay_tm_min_amt        = '14C TM Copayment min'
	pbp_b14c_copay_tm_max_amt        = '14C TM Copayment max'
	pbp_b14c_copay_rat_wp_min_amt    = '14C RAT WP Copay min'
	pbp_b14c_copay_rat_wp_max_amt    = '14C RAT WP Copay max'
	pbp_b14c_copay_rat_nh_min_amt    = '14C RAT NH Copay min'
	pbp_b14c_copay_rat_nh_max_amt    = '14C RAT NH Copay max'
	pbp_b14c_copay_bsd_min_amt       = '14C BSD Copay min'
	pbp_b14c_copay_bsd_max_amt       = '14C BSD Copay max'
	pbp_b14c_copay_cs_min_amt        = '14C CS Copay min'
	pbp_b14c_copay_cs_max_amt        = '14C CS Copay max'
	pbp_b14c_copay_isa_min_amt       = '14C ISA Copay min'
	pbp_b14c_copay_isa_max_amt       = '14C ISA Copay max'
	pbp_b14c_copay_prs_min_amt       = '14C PRS Copay min'
	pbp_b14c_copay_prs_max_amt       = '14C PRS Copay max'
	pbp_b14c_copay_mnt_min_amt       = '14C MNT Copay min'
	pbp_b14c_copay_mnt_max_amt       = '14C MNT Copay max'
	pbp_b14c_copay_imr_min_amt       = '14C IMR Copay min'
	pbp_b14c_copay_imr_max_amt       = '14C IMR Copay max'
	pbp_b14c_copay_rp_min_amt        = '14C RP Copay min'
	pbp_b14c_copay_rp_max_amt        = '14C RP Copay max'
	pbp_b14c_copay_wig_min_amt       = '14C WIG Copay min'
	pbp_b14c_copay_wig_max_amt       = '14C WIG Copay max'
	pbp_b14c_copay_wm_min_amt        = '14C WeightManage Copay Min'
	pbp_b14c_copay_wm_max_amt        = '14C WeightManage Copay Max'
	pbp_b14c_copay_at_min_amt        = '14C AltTherapy Copay Min'
	pbp_b14c_copay_at_max_amt        = '14C AltTherapy Copay Max'
	pbp_b14c_copay_min_amt_thmg      = '14C THMG Copay Min'
	pbp_b14c_copay_max_amt_thmg      = '14C THMG Copay Max'
	pbp_b14c_copay_min_amt_adcs      = '14C ADCS Copay Min'
	pbp_b14c_copay_max_amt_adcs      = '14C ADCS Copay Max'
	pbp_b14c_copay_min_amt_hbpc      = '14C HBPC Copay Min'
	pbp_b14c_copay_max_amt_hbpc      = '14C HBPC Copay Max'
	pbp_b14c_copay_min_amt_ihss      = '14C IHSS Copay Min'
	pbp_b14c_copay_max_amt_ihss      = '14C IHSS Copay Max'
	pbp_b14c_copay_min_amt_sce       = '14C SCE Copay Min'
	pbp_b14c_copay_max_amt_sce       = '14C SCE Copay Max'
	pbp_b14c_auth_yn                 = '14C Auth YN'
	pbp_b14c_refer_yn                = '14C Referral YN'
	pbp_b14d_maxenr_yn               = 'Kidney Disease Max Enr YN'
	pbp_b14d_maxenr_amt              = 'Kidney Disease Max Enr Amt'
	pbp_b14d_maxenr_per              = 'Kidney Disease Max Enr Per'
	pbp_b14d_maxenr_per_d            = 'Kidney Dis Max Enr Per Desc'
	pbp_b14d_coins_yn                = 'Kidney Dis Coinsurance YN'
	pbp_b14d_coins_mc_min_pct        = 'Kidney Dis MC Min Coins Pct'
	pbp_b14d_coins_mc_max_pct        = 'Kidney Dis MC Max Coins Pct'
	pbp_b14d_ded_yn                  = 'Kidney Dis Deductible YN'
	pbp_b14d_ded_amt                 = 'Kidney Dis Deductible Amt'
	pbp_b14d_copay_yn                = 'Kidney Dis Copayment YN'
	pbp_b14d_copay_mc_min_amt        = 'Kidney Dis MC Min Copay Amt'
	pbp_b14d_copay_mc_max_amt        = 'Kidney DisMC Max Copay Amt'
	pbp_b14d_auth_yn                 = 'Kidney Dis Enrollee Auth'
	pbp_b14d_refer_yn                = 'Kidney Dis Referral YN'
	pbp_b14e_maxenr_yn               = '14E Max Enr YN'
	pbp_b14e_maxenr_ehc              = '14E Enr Services'
	pbp_b14e_maxenr_amt_glauc        = '14E Glaucoma Mon Max Enr Amt'
	pbp_b14e_maxenr_per_glauc        = '14E Glaucoma Mon Max Enr Per'
	pbp_b14e_maxenr_per_glauc_d      = '14E Glauc Max Enr Per Desc'
	pbp_b14e_maxenr_amt_diab         = '14E Diabetes Mon Max Enr Amt'
	pbp_b14e_maxenr_per_diab         = '14E Diabetes Mon Max Enr Per'
	pbp_b14e_maxenr_per_diab_d       = '14E Diab Max Enr Per Desc'
	pbp_b14e_maxenr_amt_dre          = '14E DigRecEx Max Enr Amt'
	pbp_b14e_maxenr_per_dre          = '14E DigRecEx Max Enr Per'
	pbp_b14e_maxenr_per_dre_d        = '14E DigRecEx Max Enr Per Desc'
	pbp_b14e_maxenr_amt_ekg          = '14E EKG Max Enr Amt'
	pbp_b14e_maxenr_per_ekg          = '14E EKG Max Enr Per'
	pbp_b14e_maxenr_per_ekg_d        = '14E EKG Max Enr Per Desc'
	pbp_b14e_coins_yn                = '14E Coinsurance YN'
	pbp_b14e_coins_ehc               = '14E Coinsurance Services'
	pbp_b14e_coins_pct_min_glauc     = '14E Glaucoma Coins Min'
	pbp_b14e_coins_pct_max_glauc     = '14E Glaucoma Coins Max'
	pbp_b14e_coins_pct_min_diab      = '14E Diabetes Mon Coins Min'
	pbp_b14e_coins_pct_max_diab      = '14E Diabetes Coins Max'
	pbp_b14e_coins_pct_min_dre       = '14E DRE Min coins'
	pbp_b14e_coins_pct_max_dre       = '14E DRE Max coins'
	pbp_b14e_coins_pct_min_ekg       = '14E EKG Min coins'
	pbp_b14e_coins_pct_max_ekg       = '14E EKG Max coins'
	pbp_b14e_ded_yn                  = '14E Deductible YN'
	pbp_b14e_ded_ehc                 = '14E Deductible Services'
	pbp_b14e_ded_amt_glauc           = '14E Glauc Deductible Amt'
	pbp_b14e_ded_amt_diab            = '14E Diabetes Mon Deduct Amt'
	pbp_b14e_ded_amt_dre             = '14E DRE ded amt'
	pbp_b14e_ded_amt_ekg             = '14E EKG ded amt'
	pbp_b14e_copay_yn                = '14E Copay YN'
	pbp_b14e_copay_ehc               = '14E Copay Services'
	pbp_b14e_copay_amt_min_glauc     = '14E Glaucoma Copay Min'
	pbp_b14e_copay_amt_max_glauc     = '14E Glaucoma Copay Max'
	pbp_b14e_copay_amt_min_diab      = '14E Diabetes Mon Copay Min'
	pbp_b14e_copay_amt_max_diab      = '14E Diabetes Mon Copay Max'
	pbp_b14e_copay_amt_min_dre       = '14E DRE min copay amt'
	pbp_b14e_copay_amt_max_dre       = '14E DRE max copay amt'
	pbp_b14e_copay_amt_min_ekg       = '14E EKG min copay amt'
	pbp_b14e_copay_amt_max_ekg       = '14E EKG max copay amt'
	pbp_b14e_auth_yn_glauc           = '14E Glaucoma Auth YN'
	pbp_b14e_auth_yn_diab            = '14E Diabetes Mon Auth YN'
	pbp_b14e_auth_yn_dre             = '14E DRE Auth YN'
	pbp_b14e_auth_yn_ekg             = '14E EKG Auth YN'
	pbp_b14e_refer_yn                = '14E Referral YN'
	pbp_b14e_refer_ehc               = '14E Referral Benefits'
;

run;

proc sort data = pbp_b14 out=out.pbp_b14;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b14(obs = 10);
  title 'pbp_b14_preventive file ';
run;

proc means data = out.pbp_b14;
  title 'pbp_b14_preventive file ';
run;

proc freq data = out.pbp_b14;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b14a_mc_prevent_attest
	pbp_b14a_auth_yn
	pbp_b14a_refer_yn
	pbp_b14b_bendesc_yn
	pbp_b14b_bendesc_rpe_amo
	pbp_b14b_maxplan_yn
	pbp_b14b_maxenr_yn
	pbp_b14b_coins_yn
	pbp_b14b_ded_yn
	pbp_b14b_copay_yn
	pbp_b14b_auth_yn
	pbp_b14b_refer_yn
	pbp_b14c_bendesc_yn
	pbp_b14c_bendesc_amo_hec
	pbp_b14c_bendesc_amo_ntb
	pbp_b14c_bendesc_lim_ntb
	pbp_b14c_bendesc_dur_ntb
	pbp_b14c_bendesc_amo_sc
	pbp_b14c_bendesc_amo_mhc
	pbp_b14c_bendesc_typ_mhc
	pbp_b14c_bendesc_amo_edm
	pbp_b14c_bendesc_amo_tm
	pbp_b14c_bendesc_amo_rat
	pbp_b14c_rat_bendesc_ehc
	pbp_b14c_bendesc_amo_bsd
	pbp_b14c_bendesc_amo_cs
	pbp_b14c_bendesc_lim_cs
	pbp_b14c_bendesc_dur_cs
	pbp_b14c_bendesc_amo_isa
	pbp_b14c_bendesc_amo_prs
	pbp_b14c_bendesc_amo_mnt
	pbp_b14c_mnt_mcd_yn
	pbp_b14c_mnt_mcd_unit
	pbp_b14c_mnt_nmcd_yn
	pbp_b14c_mnt_nmcd_unit
	pbp_b14c_bendesc_amo_imr
	pbp_b14c_bendesc_amo_rp
	pbp_b14c_rp_bendesc_ehc
	pbp_b14c_bendesc_amo_wig
	pbp_b14c_bendesc_amo_wm
	pbp_b14c_bendesc_amo_at
	pbp_b14c_bendesc_lim_at
	pbp_b14c_bendesc_thp_msg
	pbp_b14c_thp_msg_unlimited
	pbp_b14c_thp_msg_period
	pbp_b14c_bendesc_adcs
	pbp_b14c_bendesc_hbpc
	pbp_b14c_bendesc_ihss
	pbp_b14c_bendesc_sce
	pbp_b14c_sce_type_chk
	pbp_b14c_maxplan_yn
	pbp_b14c_maxplan_per_hec
	pbp_b14c_maxplan_per_ntb
	pbp_b14c_maxplan_per_sc
	pbp_b14c_maxplan_per_mhc
	pbp_b14c_maxplan_per_edm
	pbp_b14c_maxplan_per_tm
	pbp_b14c_maxplan_per_rat
	pbp_b14c_maxplan_per_bsd
	pbp_b14c_maxplan_per_cs
	pbp_b14c_maxplan_per_isa
	pbp_b14c_maxplan_per_prs
	pbp_b14c_maxplan_per_mnt
	pbp_b14c_maxplan_per_imr
	pbp_b14c_maxplan_per_rp
	pbp_b14c_maxplan_per_wig
	pbp_b14c_maxplan_per_wm
	pbp_b14c_maxplan_per_at
	pbp_b14c_maxplan_per_thms
	pbp_b14c_maxplan_per_adcs
	pbp_b14c_maxplan_per_hbpc
	pbp_b14c_maxplan_per_ihss
	pbp_b14c_maxplan_per_sce
	pbp_b14c_maxenr_yn
	pbp_b14c_maxenr_per_hec
	pbp_b14c_maxenr_per_ntb
	pbp_b14c_maxenr_per_sc
	pbp_b14c_maxenr_per_mhc
	pbp_b14c_maxenr_per_edm
	pbp_b14c_maxenr_per_tm
	pbp_b14c_maxenr_per_rat
	pbp_b14c_maxenr_per_bsd
	pbp_b14c_maxenr_per_cs
	pbp_b14c_maxenr_per_isa
	pbp_b14c_maxenr_per_prs
	pbp_b14c_maxenr_per_mnt
	pbp_b14c_maxenr_per_imr
	pbp_b14c_maxenr_per_rp
	pbp_b14c_maxenr_per_wig
	pbp_b14c_maxenr_per_wm
	pbp_b14c_maxenr_per_at
	pbp_b14c_maxenr_per_thmg
	pbp_b14c_maxenr_per_adcs
	pbp_b14c_maxenr_per_hbpc
	pbp_b14c_maxenr_per_ihss
	pbp_b14c_maxenr_per_sce
	pbp_b14c_coins_yn
	pbp_b14c_ded_yn
	pbp_b14c_copay_yn
	pbp_b14c_auth_yn
	pbp_b14c_refer_yn
	pbp_b14d_maxenr_yn
	pbp_b14d_maxenr_per
	pbp_b14d_coins_yn
	pbp_b14d_ded_yn
	pbp_b14d_copay_yn
	pbp_b14d_auth_yn
	pbp_b14d_refer_yn
	pbp_b14e_maxenr_yn
	pbp_b14e_maxenr_ehc
	pbp_b14e_maxenr_per_glauc
	pbp_b14e_maxenr_per_diab
	pbp_b14e_maxenr_per_dre
	pbp_b14e_maxenr_per_ekg
	pbp_b14e_coins_yn
	pbp_b14e_coins_ehc
	pbp_b14e_ded_yn
	pbp_b14e_ded_ehc
	pbp_b14e_copay_yn
	pbp_b14e_copay_ehc
	pbp_b14e_auth_yn_glauc
	pbp_b14e_auth_yn_diab
	pbp_b14e_auth_yn_dre
	pbp_b14e_auth_yn_ekg
	pbp_b14e_refer_yn
	pbp_b14e_refer_ehc
/ missing;
run;

proc contents data = out.pbp_b14;
  title 'pbp_b14 data';
run;