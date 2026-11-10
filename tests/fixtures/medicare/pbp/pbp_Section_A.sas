*pbp_Section_A.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_Section_A;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_a_last_data_entry_date       $10
	pbp_a_contract_partd_flag        $1
	pbp_a_ready_for_upload_date_tm   $50
	pbp_a_bpt_ma_date_time           $50
	pbp_a_bpt_pd_date_time           $50
	pbp_a_bpt_msa_date_time          $50
	pbp_a_bpt_esrd_date_time         $50
	pbp_a_platino_flag               $1
	pbp_a_snp_pct                    $1
	pbp_a_vbid_indicator             $1
	pbp_a_org_name                   $150
	pbp_a_org_marketing_name         $150
	pbp_a_org_website                $50
	pbp_a_plan_name                  $75
	pbp_a_org_type                   $2
	pbp_a_plan_type                  $2
	pbp_a_network_flag               $1
	pbp_a_ben_cov                    $1
	pbp_a_hospice_care_yn            $1
	pbp_a_plan_geog_name             $50
	pbp_a_segment_name               $50
	pbp_a_eghp_yn                    $1
	pbp_a_continue_yn                $1
	pbp_a_continue_costshare_yn      $1
	pbp_a_platino_yn                 $1
	pbp_a_special_need_flag          $1
	pbp_a_special_need_plan_type     $1
	pbp_a_snp_institutional_type     $1
	pbp_a_dsnp_zerodollar            $1
	pbp_a_snp_cond                   $33
	pbp_a_snp_state_cvg_yn           $1
	pbp_a_pharmacy_website           $100
	pbp_a_formulary_web_addr         $100
	pbp_a_phys_web_addr              $100
	pbp_a_curmbr_phone               $14
	pbp_a_curmbr_phone_ext           $7
	pbp_a_curmbr_loc_phone           $14
	pbp_a_curmbr_loc_phone_ext       $7
	pbp_a_prombr_phone               $14
	pbp_a_prombr_phone_ext           $7
	pbp_a_prombr_loc_phone           $14
	pbp_a_prombr_loc_phone_ext       $7
	pbp_a_pd_curmbr_phone            $14
	pbp_a_pd_curmbr_phone_ext        $7
	pbp_a_pd_curmbr_loc_phone        $14
	pbp_a_pd_curmbr_loc_phone_ext    $7
	pbp_a_pd_prombr_phone            $14
	pbp_a_pd_prombr_phone_ext        $7
	pbp_a_pd_prombr_loc_phone        $14
	pbp_a_pd_prombr_loc_phone_ext    $7
	pbp_a_ttytdd_curmbr_phone        $14
	pbp_a_ttytdd_curmbr_phone_ext    $7
	pbp_a_ttytdd_cur_loc_phone       $14
	pbp_a_ttytdd_cur_loc_phone_ext   $7
	pbp_a_ttytdd_prombr_phone        $14
	pbp_a_ttytdd_prombr_phone_ext    $7
	pbp_a_ttytdd_pro_loc_phone       $14
	pbp_a_ttytdd_pro_loc_phone_ext   $7
	pbp_a_pd_ttytdd_curmbr_phone     $14
	pbp_a_pd_ttytdd_curmbr_phn_ext   $7
	pbp_a_pd_ttytdd_cur_loc_phone    $14
	pbp_a_pd_ttytdd_cur_loc_phn_ex   $7
	pbp_a_pd_ttytdd_prombr_phone     $14
	pbp_a_pd_ttytdd_prombr_phn_ext   $7
	pbp_a_pd_ttytdd_pro_loc_phone    $14
	pbp_a_pd_ttytdd_pro_loc_phn_ex   $7
	pbp_a_ffs_bid_b_yn               $1
	pbp_a_ffs_bid_b_auth_yn          $1
	pbp_a_ffs_bid_b_auth_cats        $4000
	pbp_a_ffs_bid_b_ref_yn           $1
	pbp_a_ffs_bid_b_ref_cats         $4000
	pbp_a_ffs_bid_c_yn               $1
	pbp_a_ffs_bid_c_auth_yn          $1
	pbp_a_ffs_bid_c_auth_cats        $4000
	pbp_a_ffs_bid_c_ref_yn           $1
	pbp_a_ffs_bid_c_ref_cats         $4000
	pbp_a_ffs_bid_d_yn               $1
	pbp_a_tier_yn                    $1
	pbp_a_tier_bendesc_bens          $2
	pbp_a_tier_mc_bendesc_cats       $4000
	pbp_a_tier_nmc_bendesc_cats      $4000
;

infile '.\pbp\pbp_Section_A.txt' delimiter = '09'x
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
	pbp_a_last_data_entry_date
	pbp_a_contract_partd_flag
	pbp_a_ready_for_upload_date_tm
	pbp_a_bpt_ma_date_time
	pbp_a_bpt_pd_date_time
	pbp_a_bpt_msa_date_time
	pbp_a_bpt_esrd_date_time
	pbp_a_platino_flag
	pbp_a_snp_pct
	pbp_a_vbid_indicator
	pbp_a_org_name
	pbp_a_org_marketing_name
	pbp_a_org_website
	pbp_a_plan_name
	pbp_a_org_type
	pbp_a_plan_type
	pbp_a_network_flag
	pbp_a_ben_cov
	pbp_a_hospice_care_yn
	pbp_a_plan_geog_name
	pbp_a_segment_name
	pbp_a_eghp_yn
	pbp_a_est_memb
	pbp_a_continue_yn
	pbp_a_continue_costshare_yn
	pbp_a_platino_yn
	pbp_a_special_need_flag
	pbp_a_special_need_plan_type
	pbp_a_snp_institutional_type
	pbp_a_dsnp_zerodollar
	pbp_a_snp_cond
	pbp_a_snp_state_cvg_yn
	pbp_a_pharmacy_website
	pbp_a_formulary_web_addr
	pbp_a_phys_web_addr
	pbp_a_curmbr_phone
	pbp_a_curmbr_phone_ext
	pbp_a_curmbr_loc_phone
	pbp_a_curmbr_loc_phone_ext
	pbp_a_prombr_phone
	pbp_a_prombr_phone_ext
	pbp_a_prombr_loc_phone
	pbp_a_prombr_loc_phone_ext
	pbp_a_pd_curmbr_phone
	pbp_a_pd_curmbr_phone_ext
	pbp_a_pd_curmbr_loc_phone
	pbp_a_pd_curmbr_loc_phone_ext
	pbp_a_pd_prombr_phone
	pbp_a_pd_prombr_phone_ext
	pbp_a_pd_prombr_loc_phone
	pbp_a_pd_prombr_loc_phone_ext
	pbp_a_ttytdd_curmbr_phone
	pbp_a_ttytdd_curmbr_phone_ext
	pbp_a_ttytdd_cur_loc_phone
	pbp_a_ttytdd_cur_loc_phone_ext
	pbp_a_ttytdd_prombr_phone
	pbp_a_ttytdd_prombr_phone_ext
	pbp_a_ttytdd_pro_loc_phone
	pbp_a_ttytdd_pro_loc_phone_ext
	pbp_a_pd_ttytdd_curmbr_phone
	pbp_a_pd_ttytdd_curmbr_phn_ext
	pbp_a_pd_ttytdd_cur_loc_phone
	pbp_a_pd_ttytdd_cur_loc_phn_ex
	pbp_a_pd_ttytdd_prombr_phone
	pbp_a_pd_ttytdd_prombr_phn_ext
	pbp_a_pd_ttytdd_pro_loc_phone
	pbp_a_pd_ttytdd_pro_loc_phn_ex
	pbp_a_ffs_bid_b_yn
	pbp_a_ffs_bid_b_auth_yn
	pbp_a_ffs_bid_b_auth_cats
	pbp_a_ffs_bid_b_ref_yn
	pbp_a_ffs_bid_b_ref_cats
	pbp_a_ffs_bid_c_yn
	pbp_a_ffs_bid_c_auth_yn
	pbp_a_ffs_bid_c_auth_cats
	pbp_a_ffs_bid_c_ref_yn
	pbp_a_ffs_bid_c_ref_cats
	pbp_a_ffs_bid_d_yn
	pbp_a_tier_yn
	pbp_a_tier_bendesc_bens
	pbp_a_tier_mc_bendesc_cats
	pbp_a_tier_nmc_bendesc_cats
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
	pbp_a_last_data_entry_date       = 'Last Data Entry date'
	pbp_a_contract_partd_flag        = 'Contract Part D Flag'
	pbp_a_ready_for_upload_date_tm   = 'Plan Ready for Upload date/tm'
	pbp_a_bpt_ma_date_time           = 'MA BPT date/time'
	pbp_a_bpt_pd_date_time           = 'PD BPT date/time'
	pbp_a_bpt_msa_date_time          = 'MSA BPT date/time'
	pbp_a_bpt_esrd_date_time         = 'ESRD SNP BPT date/time'
	pbp_a_platino_flag               = 'PLATINO requirement met'
	pbp_a_snp_pct                    = 'SNP Percentage'
	pbp_a_vbid_indicator             = 'VBID Indicator'
	pbp_a_org_name                   = 'Organization Legal Name'
	pbp_a_org_marketing_name         = 'Organization Marketing Name'
	pbp_a_org_website                = 'Organization Web Site'
	pbp_a_plan_name                  = 'Plan Name'
	pbp_a_org_type                   = 'Organization Type'
	pbp_a_plan_type                  = 'Plan Type'
	pbp_a_network_flag               = 'Network Flag'
	pbp_a_ben_cov                    = 'Enrollee Type'
	pbp_a_hospice_care_yn            = 'Hospice Care YN'
	pbp_a_plan_geog_name             = 'Plan Geographic Name'
	pbp_a_segment_name               = 'Segment Name'
	pbp_a_eghp_yn                    = 'EGHP Plan YN'
	pbp_a_est_memb                   = 'CY 2026 Est Monthly Membership'
	pbp_a_continue_yn                = 'Continuation Area YN'
	pbp_a_continue_costshare_yn      = 'Continuation Area Same Cost YN'
	pbp_a_platino_yn                 = 'Participate in PLATINO'
	pbp_a_special_need_flag          = 'SNP Special Needs Plan YN'
	pbp_a_special_need_plan_type     = 'SNP Type'
	pbp_a_snp_institutional_type     = 'SNP Institutional Type'
	pbp_a_dsnp_zerodollar            = 'SNP Zero Dollar'
	pbp_a_snp_cond                   = 'SNP Conditions'
	pbp_a_snp_state_cvg_yn           = 'SNP State Coverage YN'
	pbp_a_pharmacy_website           = 'Pharm Web Address'
	pbp_a_formulary_web_addr         = 'Formulary Web Address'
	pbp_a_phys_web_addr              = 'Phys Web Address'
	pbp_a_curmbr_phone               = 'Cur Mbr Phone Num'
	pbp_a_curmbr_phone_ext           = 'Cur Mbr Phone Num Ext'
	pbp_a_curmbr_loc_phone           = 'Cur Mbr Local Phone Num'
	pbp_a_curmbr_loc_phone_ext       = 'Cur Mbr Local Phone Num Ext'
	pbp_a_prombr_phone               = 'Prosp Mbr Phone Num'
	pbp_a_prombr_phone_ext           = 'Prosp Mbr Phone Num Ext'
	pbp_a_prombr_loc_phone           = 'Prosp Mbr Phone Local Num'
	pbp_a_prombr_loc_phone_ext       = 'Prosp Mbr Phone Local Num Ext'
	pbp_a_pd_curmbr_phone            = 'Cur Mbr Part D Phone Num'
	pbp_a_pd_curmbr_phone_ext        = 'Cur Mbr Part D Phone Num Ext'
	pbp_a_pd_curmbr_loc_phone        = 'Cur Mbr Part D Local Phone Num'
	pbp_a_pd_curmbr_loc_phone_ext    = 'Cur Mbr Part D Local Phone Ext'
	pbp_a_pd_prombr_phone            = 'Prosp Mbr Part D Phone Num'
	pbp_a_pd_prombr_phone_ext        = 'Prosp Mbr Part D Phone Num Ext'
	pbp_a_pd_prombr_loc_phone        = 'Prosp Mbr Part D Loc Phone Num'
	pbp_a_pd_prombr_loc_phone_ext    = 'Prosp Mbr Part D Loc Phone Ext'
	pbp_a_ttytdd_curmbr_phone        = 'Cur Mbr TTY Num'
	pbp_a_ttytdd_curmbr_phone_ext    = 'Cur Mbr TTY Num Ext'
	pbp_a_ttytdd_cur_loc_phone       = 'Cur Mbr TTY Local Num'
	pbp_a_ttytdd_cur_loc_phone_ext   = 'Cur Mbr TTY Local Num Ext'
	pbp_a_ttytdd_prombr_phone        = 'Prosp Mbr TTY Num'
	pbp_a_ttytdd_prombr_phone_ext    = 'Prosp Mbr TTY Num Ext'
	pbp_a_ttytdd_pro_loc_phone       = 'Prosp Mbr TTY Num'
	pbp_a_ttytdd_pro_loc_phone_ext   = 'Prosp Mbr TTY Num Ext'
	pbp_a_pd_ttytdd_curmbr_phone     = 'Cur Mbr Part D TTY Num'
	pbp_a_pd_ttytdd_curmbr_phn_ext   = 'Cur Mbr Part D TTY Num Ext'
	pbp_a_pd_ttytdd_cur_loc_phone    = 'Cur Mbr Part D TTY Loc Num'
	pbp_a_pd_ttytdd_cur_loc_phn_ex   = 'Cur Mbr Part D TTY Loc Ext'
	pbp_a_pd_ttytdd_prombr_phone     = 'Prosp Mbr Part D TTY Num'
	pbp_a_pd_ttytdd_prombr_phn_ext   = 'Pro Mbr Part D TTY Num Ext'
	pbp_a_pd_ttytdd_pro_loc_phone    = 'Pro Mbr Part D TTY Loc Num'
	pbp_a_pd_ttytdd_pro_loc_phn_ex   = 'Pro Mbr Part D TTY Loc Ext'
	pbp_a_ffs_bid_b_yn               = 'FFS BID INN YN?'
	pbp_a_ffs_bid_b_auth_yn          = 'INN Authorization'
	pbp_a_ffs_bid_b_auth_cats        = 'INN Auth Cats'
	pbp_a_ffs_bid_b_ref_yn           = 'INN Referral'
	pbp_a_ffs_bid_b_ref_cats         = 'INN Ref Cats'
	pbp_a_ffs_bid_c_yn               = 'FFS Bid OON/POS/VT YN?'
	pbp_a_ffs_bid_c_auth_yn          = 'OON Authorization'
	pbp_a_ffs_bid_c_auth_cats        = 'OON Auth Cats'
	pbp_a_ffs_bid_c_ref_yn           = 'OON Referral'
	pbp_a_ffs_bid_c_ref_cats         = 'OON Ref Cats'
	pbp_a_ffs_bid_d_yn               = 'FFS Bid PLCS YN?'
	pbp_a_tier_yn                    = 'Tiered Benefit YN'
	pbp_a_tier_bendesc_bens          = 'Tiered Benefit Category Types'
	pbp_a_tier_mc_bendesc_cats       = 'MC Tiered Benefit Categories'
	pbp_a_tier_nmc_bendesc_cats      = 'Non-MC Tier Benefit Categories'
;

run;

proc sort data = pbp_Section_A out=out.pbp_Section_A;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_Section_A(obs = 10);
  title 'pbp_Section_A file ';
run;

proc means data = out.pbp_Section_A;
  title 'pbp_Section_A file ';
run;

proc freq data = out.pbp_Section_A;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_a_contract_partd_flag
	pbp_a_platino_flag
	pbp_a_snp_pct
	pbp_a_vbid_indicator
	pbp_a_org_type
	pbp_a_plan_type
	pbp_a_network_flag
	pbp_a_ben_cov
	pbp_a_hospice_care_yn
	pbp_a_eghp_yn
	pbp_a_continue_yn
	pbp_a_continue_costshare_yn
	pbp_a_platino_yn
	pbp_a_special_need_flag
	pbp_a_special_need_plan_type
	pbp_a_snp_institutional_type
	pbp_a_dsnp_zerodollar
	pbp_a_snp_state_cvg_yn
	pbp_a_ffs_bid_b_yn
	pbp_a_ffs_bid_b_auth_yn
	pbp_a_ffs_bid_b_ref_yn
	pbp_a_ffs_bid_c_yn
	pbp_a_ffs_bid_c_auth_yn
	pbp_a_ffs_bid_c_ref_yn
	pbp_a_ffs_bid_d_yn
	pbp_a_tier_yn
	pbp_a_tier_bendesc_bens
/ missing;
run;

proc contents data = out.pbp_Section_A;
  title 'pbp_Section_A data';
run;