*pbp_b18_hearing_exams_aids.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b18;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b18a_bendesc_yn              $1
	pbp_b18a_bendesc_ehc             $2
	pbp_b18a_bendesc_amo_rht         $1
	pbp_b18a_bendesc_lim_rht         $1
	pbp_b18a_bendesc_per_rht         $1
	pbp_b18a_bendesc_per_rht_d       $4000
	pbp_b18a_bendesc_amo_fha         $1
	pbp_b18a_bendesc_lim_fha         $1
	pbp_b18a_bendesc_per_fha         $1
	pbp_b18a_bendesc_per_fha_d       $4000
	pbp_b18a_maxplan_yn              $1
	pbp_b18a_maxplan_in_oon          $1
	pbp_b18a_maxplan_per             $1
	pbp_b18a_maxplan_per_d           $4000
	pbp_b18a_ded_yn                  $1
	pbp_b18a_ded_nmc_yn              $1
	pbp_b18a_maxenr_yn               $1
	pbp_b18a_maxenr_per              $1
	pbp_b18a_maxenr_per_d            $4000
	pbp_b18a_coins_yn                $1
	pbp_b18a_coins_ehc               $3
	pbp_b18a_copay_yn                $1
	pbp_b18a_copay_ehc               $3
	pbp_b18a_auth_yn                 $1
	pbp_b18a_refer_yn                $1
	pbp_b18b_bendesc_yn              $1
	pbp_b18b_bendesc_ehc             $4
	pbp_b18b_bendesc_amo_at          $1
	pbp_b18b_bendesc_lim_at          $1
	pbp_b18b_bendesc_per_at          $1
	pbp_b18b_bendesc_per_at_d        $4000
	pbp_b18b_bendesc_amo_ie          $1
	pbp_b18b_bendesc_lim_ie          $1
	pbp_b18b_bendesc_per_ie          $1
	pbp_b18b_bendesc_per_ie_d        $4000
	pbp_b18b_bendesc_amo_oe          $1
	pbp_b18b_bendesc_lim_oe          $1
	pbp_b18b_bendesc_per_oe          $1
	pbp_b18b_bendesc_per_oe_d        $4000
	pbp_b18b_bendesc_amo_ote         $1
	pbp_b18b_bendesc_lim_ote         $1
	pbp_b18b_bendesc_per_ote         $1
	pbp_b18b_bendesc_per_ote_d       $4000
	pbp_b18b_maxplan_yn              $1
	pbp_b18b_maxplan_perear          $1
	pbp_b18b_maxplan_type            $1
	pbp_b18b_maxplan_in_oon          $1
	pbp_b18b_maxplan_per             $1
	pbp_b18b_maxplan_per_d           $4000
	pbp_b18b_maxenr_yn               $1
	pbp_b18b_maxenr_type             $1
	pbp_b18b_maxenr_per              $1
	pbp_b18b_maxenr_per_d            $4000
	pbp_b18b_coins_yn                $1
	pbp_b18b_coins_ehc               $3
	pbp_b18b_copay_yn                $1
	pbp_b18b_copay_ehc               $3
	pbp_b18b_ded_yn                  $1
	pbp_b18b_auth_yn                 $1
	pbp_b18b_refer_yn                $1
	pbp_b18c_bendesc_amo             $1
	pbp_b18c_maxplan_yn              $1
	pbp_b18c_maxplan_aid_type        $1
	pbp_b18c_maxplan_in_oon          $1
	pbp_b18c_maxplan_per             $1
	pbp_b18c_maxplan_per_desc        $4000
	pbp_b18c_maxenr_yn               $1
	pbp_b18c_maxenr_per              $1
	pbp_b18c_maxenr_per_desc         $4000
	pbp_b18c_ded_yn                  $1
	pbp_b18c_bendesc_lim             $1
	pbp_b18c_bendesc_per             $1
	pbp_b18c_bendesc_desc            $4000
	pbp_b18c_coins_yn                $1
	pbp_b18c_copay_yn                $1
	pbp_b18c_auth_yn                 $1
	pbp_b18c_refer_yn                $1
;

infile '.\pbp\pbp_b18_hearing_exams_aids.txt' delimiter = '09'x
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
	pbp_b18a_bendesc_yn
	pbp_b18a_bendesc_ehc
	pbp_b18a_bendesc_amo_rht
	pbp_b18a_bendesc_lim_rht
	pbp_b18a_bendesc_numv_cl
	pbp_b18a_bendesc_per_rht
	pbp_b18a_bendesc_per_rht_d
	pbp_b18a_bendesc_amo_fha
	pbp_b18a_bendesc_lim_fha
	pbp_b18a_bendesc_numv_fha
	pbp_b18a_bendesc_per_fha
	pbp_b18a_bendesc_per_fha_d
	pbp_b18a_maxplan_yn
	pbp_b18a_maxplan_in_oon
	pbp_b18a_maxplan_amt
	pbp_b18a_maxplan_per
	pbp_b18a_maxplan_per_d
	pbp_b18a_ded_yn
	pbp_b18a_ded_amt
	pbp_b18a_ded_nmc_yn
	pbp_b18a_ded_nmc_amt
	pbp_b18a_maxenr_yn
	pbp_b18a_maxenr_amt
	pbp_b18a_maxenr_per
	pbp_b18a_maxenr_per_d
	pbp_b18a_coins_yn
	pbp_b18a_coins_ehc
	pbp_b18a_med_coins_pct
	pbp_b18a_med_coins_pct_max
	pbp_b18a_coins_pct_rht
	pbp_b18a_coins_pct_max_rht
	pbp_b18a_coins_pct_fha
	pbp_b18a_coins_pct_max_fha
	pbp_b18a_copay_yn
	pbp_b18a_copay_ehc
	pbp_b18a_copay_amt
	pbp_b18a_med_copay_amt_max
	pbp_b18a_copay_amt_rht
	pbp_b18a_copay_amt_max_rht
	pbp_b18a_copay_amt_fha
	pbp_b18a_copay_amt_max_fha
	pbp_b18a_auth_yn
	pbp_b18a_refer_yn
	pbp_b18b_bendesc_yn
	pbp_b18b_bendesc_ehc
	pbp_b18b_bendesc_amo_at
	pbp_b18b_bendesc_lim_at
	pbp_b18b_bendesc_numv_at
	pbp_b18b_bendesc_per_at
	pbp_b18b_bendesc_per_at_d
	pbp_b18b_bendesc_amo_ie
	pbp_b18b_bendesc_lim_ie
	pbp_b18b_bendesc_numv_ie
	pbp_b18b_bendesc_per_ie
	pbp_b18b_bendesc_per_ie_d
	pbp_b18b_bendesc_amo_oe
	pbp_b18b_bendesc_lim_oe
	pbp_b18b_bendesc_numv_oe
	pbp_b18b_bendesc_per_oe
	pbp_b18b_bendesc_per_oe_d
	pbp_b18b_bendesc_amo_ote
	pbp_b18b_bendesc_lim_ote
	pbp_b18b_bendesc_numv_ote
	pbp_b18b_bendesc_per_ote
	pbp_b18b_bendesc_per_ote_d
	pbp_b18b_maxplan_yn
	pbp_b18b_maxplan_perear
	pbp_b18b_maxplan_type
	pbp_b18b_maxplan_in_oon
	pbp_b18b_maxplan_amt
	pbp_b18b_maxplan_per
	pbp_b18b_maxplan_per_d
	pbp_b18b_maxenr_yn
	pbp_b18b_maxenr_type
	pbp_b18b_maxenr_amt
	pbp_b18b_maxenr_per
	pbp_b18b_maxenr_per_d
	pbp_b18b_coins_yn
	pbp_b18b_coins_ehc
	pbp_b18b_coins_pct_at_min
	pbp_b18b_coins_pct_at_max
	pbp_b18b_coins_pct_ie_min
	pbp_b18b_coins_pct_ie_max
	pbp_b18b_coins_pct_oe_min
	pbp_b18b_coins_pct_oe_max
	pbp_b18b_coins_pct_ote_min
	pbp_b18b_coins_pct_ote_max
	pbp_b18b_copay_yn
	pbp_b18b_copay_ehc
	pbp_b18b_copay_at_min_amt
	pbp_b18b_copay_at_max_amt
	pbp_b18b_copay_amt_per_ie_min
	pbp_b18b_copay_amt_per_ie_max
	pbp_b18b_copay_amt_p2_ie_min
	pbp_b18b_copay_amt_p2_ie_max
	pbp_b18b_copay_amt_per_oe_min
	pbp_b18b_copay_amt_per_oe_max
	pbp_b18b_copay_amt_p2_oe_min
	pbp_b18b_copay_amt_p2_oe_max
	pbp_b18b_copay_amt_per_ote_min
	pbp_b18b_copay_amt_per_ote_max
	pbp_b18b_copay_amt_p2_ote_min
	pbp_b18b_copay_amt_p2_ote_max
	pbp_b18b_ded_yn
	pbp_b18b_ded_amt
	pbp_b18b_auth_yn
	pbp_b18b_refer_yn
	pbp_b18c_bendesc_amo
	pbp_b18c_maxplan_yn
	pbp_b18c_maxplan_aid_type
	pbp_b18c_maxplan_in_oon
	pbp_b18c_maxplan_amt
	pbp_b18c_maxplan_per
	pbp_b18c_maxplan_per_desc
	pbp_b18c_maxenr_yn
	pbp_b18c_maxenr_amt
	pbp_b18c_maxenr_per
	pbp_b18c_maxenr_per_desc
	pbp_b18c_ded_yn
	pbp_b18c_ded_amt
	pbp_b18c_bendesc_lim
	pbp_b18c_bendesc_num
	pbp_b18c_bendesc_per
	pbp_b18c_bendesc_desc
	pbp_b18c_coins_yn
	pbp_b18c_coins_pct
	pbp_b18c_coins_pct_min
	pbp_b18c_coins_pct_max
	pbp_b18c_copay_yn
	pbp_b18c_copay_amt
	pbp_b18c_copay_amt_min
	pbp_b18c_copay_amt_max
	pbp_b18c_auth_yn
	pbp_b18c_refer_yn
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
	pbp_b18a_bendesc_yn              = 'Hearing Exams Ben YN'
	pbp_b18a_bendesc_ehc             = 'Hearing Exams (18a) Ben'
	pbp_b18a_bendesc_amo_rht         = 'Hearing Exams RHT Ben Desc AMO'
	pbp_b18a_bendesc_lim_rht         = 'Hearing Exams RHT Ben Desc Lim'
	pbp_b18a_bendesc_numv_cl         = 'Hearing Exams RHT Ben Desc Num'
	pbp_b18a_bendesc_per_rht         = 'Hearing Exams RHT Ben Desc Per'
	pbp_b18a_bendesc_per_rht_d       = 'Hearing Exams RHT Per Desc'
	pbp_b18a_bendesc_amo_fha         = 'Hearing Exams FHA Ben Desc AMO'
	pbp_b18a_bendesc_lim_fha         = 'Hearing Exams FHA Ben Desc Lim'
	pbp_b18a_bendesc_numv_fha        = 'Hearing Exams FHA Ben Desc Num'
	pbp_b18a_bendesc_per_fha         = 'Hearing Exams FHA Ben Desc Per'
	pbp_b18a_bendesc_per_fha_d       = 'Hearing Exams FHA Per Desc'
	pbp_b18a_maxplan_yn              = 'Hearing Exams Max Plan YN'
	pbp_b18a_maxplan_in_oon          = 'Hearing Exams INN or OON'
	pbp_b18a_maxplan_amt             = 'Hearing Exams Max Plan Amt'
	pbp_b18a_maxplan_per             = 'Hearing Exams Max Plan Per'
	pbp_b18a_maxplan_per_d           = 'Hearing Exams Max Per Desc'
	pbp_b18a_ded_yn                  = 'Hearing Exams Deduct MC YN'
	pbp_b18a_ded_amt                 = 'Hearing Exams Deduct MC Amt'
	pbp_b18a_ded_nmc_yn              = 'Hearing Exams Deduct NMC YN'
	pbp_b18a_ded_nmc_amt             = 'Hearing Exams Deduct NMC Amt'
	pbp_b18a_maxenr_yn               = 'Hearing Exams Max Enr YN'
	pbp_b18a_maxenr_amt              = 'Hearing Exams Max Enr Amt'
	pbp_b18a_maxenr_per              = 'Hearing Exams Max Enr Per'
	pbp_b18a_maxenr_per_d            = 'Hearing Exams Max Enr Per Desc'
	pbp_b18a_coins_yn                = 'Hearing Exams Coinsurance YN'
	pbp_b18a_coins_ehc               = 'Hearing Exam Benefits Coins'
	pbp_b18a_med_coins_pct           = 'Hearing Exams MC Coins Min Pct'
	pbp_b18a_med_coins_pct_max       = 'Hearing Exams MC Coins Max Pct'
	pbp_b18a_coins_pct_rht           = 'Hearing Exms RHT Min Coins Pct'
	pbp_b18a_coins_pct_max_rht       = 'Hearing Exms RHT Max Coins Pct'
	pbp_b18a_coins_pct_fha           = 'Hearing Exms FHA Min Coins Pct'
	pbp_b18a_coins_pct_max_fha       = 'Hearing Exms FHA Max Coins Pct'
	pbp_b18a_copay_yn                = 'Hearing Exams Copayment YN'
	pbp_b18a_copay_ehc               = 'Hearing Exam Benefits Copay'
	pbp_b18a_copay_amt               = 'Hearing Exams MC Min Copay Amt'
	pbp_b18a_med_copay_amt_max       = 'Hearing Exams MC Max Copay Amt'
	pbp_b18a_copay_amt_rht           = 'Hearing Exms RHT Min Copay Amt'
	pbp_b18a_copay_amt_max_rht       = 'Hearing Exms RHT Max Copay Amt'
	pbp_b18a_copay_amt_fha           = 'Hearing Exms FHA Min Copay Amt'
	pbp_b18a_copay_amt_max_fha       = 'Hearing Exms FHA Max Copay Amt'
	pbp_b18a_auth_yn                 = 'Hearing Exams Auth YN'
	pbp_b18a_refer_yn                = 'Hearing Exams Referral YN'
	pbp_b18b_bendesc_yn              = 'Hearing Aids Ben YN'
	pbp_b18b_bendesc_ehc             = 'Hearing Aids (18b) Ben'
	pbp_b18b_bendesc_amo_at          = 'Hearing Aids AT Ben AMO'
	pbp_b18b_bendesc_lim_at          = 'Hearing Aids AT Ben Lim'
	pbp_b18b_bendesc_numv_at         = 'Hearing Aids AT Ben Num'
	pbp_b18b_bendesc_per_at          = 'Hearing Aids AT Ben Per'
	pbp_b18b_bendesc_per_at_d        = 'Hearing Aids AT Per Desc'
	pbp_b18b_bendesc_amo_ie          = 'Hearing Aids IE Ben AMO'
	pbp_b18b_bendesc_lim_ie          = 'Hearing Aids IE Ben Lim'
	pbp_b18b_bendesc_numv_ie         = 'Hearing Aids IE Ben Num'
	pbp_b18b_bendesc_per_ie          = 'Hearing Aids IE Ben Per'
	pbp_b18b_bendesc_per_ie_d        = 'Hear Aids IE Per Desc'
	pbp_b18b_bendesc_amo_oe          = 'Hearing Aids OE Ben AMO'
	pbp_b18b_bendesc_lim_oe          = 'Hearing Aids OE Ben Lim'
	pbp_b18b_bendesc_numv_oe         = 'Hearing Aids OE Ben Num'
	pbp_b18b_bendesc_per_oe          = 'Hearing Aids OE Ben Per'
	pbp_b18b_bendesc_per_oe_d        = 'Hear Aids OE Per Desc'
	pbp_b18b_bendesc_amo_ote         = 'Hearing Aids OTE Ben AMO'
	pbp_b18b_bendesc_lim_ote         = 'Hearing Aids OTE Ben Lim'
	pbp_b18b_bendesc_numv_ote        = 'Hearing Aids OTE Ben Num'
	pbp_b18b_bendesc_per_ote         = 'Hearing Aids OTE Ben Per'
	pbp_b18b_bendesc_per_ote_d       = 'Hear Aids OTE Per Desc'
	pbp_b18b_maxplan_yn              = 'Hearing Aids Max Plan YN'
	pbp_b18b_maxplan_perear          = 'Hearing Aids Maxplan Per Ear'
	pbp_b18b_maxplan_type            = 'Hearing Aids Max Plan Type'
	pbp_b18b_maxplan_in_oon          = 'Hearing Aids INN or OON'
	pbp_b18b_maxplan_amt             = 'Hearing Aids Max Plan Amt'
	pbp_b18b_maxplan_per             = 'Hearing Aids Max Plan Per'
	pbp_b18b_maxplan_per_d           = 'Hearing Aids Maxplan Ear Desc'
	pbp_b18b_maxenr_yn               = 'Hearing Aids Max Enr YN'
	pbp_b18b_maxenr_type             = 'Hearing Aids Max Enr Type'
	pbp_b18b_maxenr_amt              = 'Hearing Aids Max Enr Amt'
	pbp_b18b_maxenr_per              = 'Hearing Aids Max Enr Per'
	pbp_b18b_maxenr_per_d            = 'Hearing Aids Max Enr Per Desc'
	pbp_b18b_coins_yn                = 'Hearing Aids Coinsurance YN'
	pbp_b18b_coins_ehc               = 'Hearing Aids Benefits Coins'
	pbp_b18b_coins_pct_at_min        = 'Hearing Aids AT Min Coins Pct'
	pbp_b18b_coins_pct_at_max        = 'Hearing Aids AT Max Coins Pct'
	pbp_b18b_coins_pct_ie_min        = 'Hearing Aids IE Min Coins Pct'
	pbp_b18b_coins_pct_ie_max        = 'Hearing Aids IE Max Coins Pct'
	pbp_b18b_coins_pct_oe_min        = 'Hearing Aids OE Min Coins Pct'
	pbp_b18b_coins_pct_oe_max        = 'Hearing Aids OE Max Coins Pct'
	pbp_b18b_coins_pct_ote_min       = 'Hearing Aids OTE Min Coins Pct'
	pbp_b18b_coins_pct_ote_max       = 'Hearing Aids OTE Max Coins Pct'
	pbp_b18b_copay_yn                = 'Hearing Aids Copayment YN'
	pbp_b18b_copay_ehc               = 'Hearing Aids Benefits Copay'
	pbp_b18b_copay_at_min_amt        = 'Hearing Aids AT Min Copay Amt'
	pbp_b18b_copay_at_max_amt        = 'Hearing Aids AT Max Copay Amt'
	pbp_b18b_copay_amt_per_ie_min    = 'Hearing Aids IE Min Copay Amt'
	pbp_b18b_copay_amt_per_ie_max    = 'Hearing Aids IE Max Copay Amt'
	pbp_b18b_copay_amt_p2_ie_min     = 'Hearing Aids 2 IE Min Copay'
	pbp_b18b_copay_amt_p2_ie_max     = 'Hearing Aids 2 IE Max Copay'
	pbp_b18b_copay_amt_per_oe_min    = 'Hearing Aids OE Min Copay Amt'
	pbp_b18b_copay_amt_per_oe_max    = 'Hearing Aids OE Max Copay Amt'
	pbp_b18b_copay_amt_p2_oe_min     = 'Hearing Aids 2 OE Min Copay'
	pbp_b18b_copay_amt_p2_oe_max     = 'Hearing Aids 2 OE Max Copay'
	pbp_b18b_copay_amt_per_ote_min   = 'Hearing Aids OTE Min Copay Amt'
	pbp_b18b_copay_amt_per_ote_max   = 'Hearing Aids OTE Max Copay Amt'
	pbp_b18b_copay_amt_p2_ote_min    = 'Hearing Aids 2 OTE Min Copay'
	pbp_b18b_copay_amt_p2_ote_max    = 'Hearing Aids 2 OTE Max Copay'
	pbp_b18b_ded_yn                  = 'Hearing Aids Deductible YN'
	pbp_b18b_ded_amt                 = 'Hearing Aids Deductible Amt'
	pbp_b18b_auth_yn                 = 'Hearing Aids Auth YN'
	pbp_b18b_refer_yn                = 'Hearing Aids Referral YN'
	pbp_b18c_bendesc_amo             = 'OTC Hear Aids Ben AMO'
	pbp_b18c_maxplan_yn              = 'OTC Hear Aids Max Plan YN'
	pbp_b18c_maxplan_aid_type        = 'OTC Hear Aids Max Aid Type'
	pbp_b18c_maxplan_in_oon          = 'OTC Hear Aids INN or OON'
	pbp_b18c_maxplan_amt             = 'OTC Hear Aids Max Plan Amt'
	pbp_b18c_maxplan_per             = 'OTC Hear Aids Max Plan Per'
	pbp_b18c_maxplan_per_desc        = 'OTC Hear Aids Max Plan Desc'
	pbp_b18c_maxenr_yn               = 'OTC Hear Aids Max Enr YN'
	pbp_b18c_maxenr_amt              = 'OTC Hear Aids Max Enr Amt'
	pbp_b18c_maxenr_per              = 'OTC Hear Aids Max Enr Per'
	pbp_b18c_maxenr_per_desc         = 'OTC Hear Aids Max Enr Other'
	pbp_b18c_ded_yn                  = 'OTC Hear Aids Deductible YN'
	pbp_b18c_ded_amt                 = 'OTC Hear Aids Deductible Amt'
	pbp_b18c_bendesc_lim             = 'OTC Hear Aids Ben Desc Lim YN'
	pbp_b18c_bendesc_num             = 'OTC Hear Aids Ben Desc Num'
	pbp_b18c_bendesc_per             = 'OTC Hear Aids Ben Desc Per'
	pbp_b18c_bendesc_desc            = 'OTC Hear Aids Ben Per Desc'
	pbp_b18c_coins_yn                = 'OTC Hear Aids Coins YN'
	pbp_b18c_coins_pct               = 'OTC Hear Aids Coins Pct'
	pbp_b18c_coins_pct_min           = 'OTC Hear Aids Min Coins Pct'
	pbp_b18c_coins_pct_max           = 'OTC Hear Aids Max Coins Pct'
	pbp_b18c_copay_yn                = 'OTC Hear Aids Copayment YN'
	pbp_b18c_copay_amt               = 'OTC Hear Aids Copay Amt'
	pbp_b18c_copay_amt_min           = 'OTC Hear Aids Min Copay Amt'
	pbp_b18c_copay_amt_max           = 'OTC Hear Aids Max Copay Amt'
	pbp_b18c_auth_yn                 = 'OTC Hear Aids Auth YN'
	pbp_b18c_refer_yn                = 'OTC Hear Aids Referral YN'
;

run;

proc sort data = pbp_b18 out=out.pbp_b18;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b18(obs = 10);
  title 'pbp_b18_hearing_exams_aids file ';
run;

proc means data = out.pbp_b18;
  title 'pbp_b18_hearing_exams_aids file ';
run;

proc freq data = out.pbp_b18;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b18a_bendesc_yn
	pbp_b18a_bendesc_ehc
	pbp_b18a_bendesc_amo_rht
	pbp_b18a_bendesc_lim_rht
	pbp_b18a_bendesc_per_rht
	pbp_b18a_bendesc_amo_fha
	pbp_b18a_bendesc_lim_fha
	pbp_b18a_bendesc_per_fha
	pbp_b18a_maxplan_yn
	pbp_b18a_maxplan_in_oon
	pbp_b18a_maxplan_per
	pbp_b18a_ded_yn
	pbp_b18a_ded_nmc_yn
	pbp_b18a_maxenr_yn
	pbp_b18a_maxenr_per
	pbp_b18a_coins_yn
	pbp_b18a_coins_ehc
	pbp_b18a_copay_yn
	pbp_b18a_copay_ehc
	pbp_b18a_auth_yn
	pbp_b18a_refer_yn
	pbp_b18b_bendesc_yn
	pbp_b18b_bendesc_ehc
	pbp_b18b_bendesc_amo_at
	pbp_b18b_bendesc_lim_at
	pbp_b18b_bendesc_per_at
	pbp_b18b_bendesc_amo_ie
	pbp_b18b_bendesc_lim_ie
	pbp_b18b_bendesc_per_ie
	pbp_b18b_bendesc_amo_oe
	pbp_b18b_bendesc_lim_oe
	pbp_b18b_bendesc_per_oe
	pbp_b18b_bendesc_amo_ote
	pbp_b18b_bendesc_lim_ote
	pbp_b18b_bendesc_per_ote
	pbp_b18b_maxplan_yn
	pbp_b18b_maxplan_perear
	pbp_b18b_maxplan_type
	pbp_b18b_maxplan_in_oon
	pbp_b18b_maxplan_per
	pbp_b18b_maxenr_yn
	pbp_b18b_maxenr_type
	pbp_b18b_maxenr_per
	pbp_b18b_coins_yn
	pbp_b18b_coins_ehc
	pbp_b18b_copay_yn
	pbp_b18b_copay_ehc
	pbp_b18b_ded_yn
	pbp_b18b_auth_yn
	pbp_b18b_refer_yn
	pbp_b18c_bendesc_amo
	pbp_b18c_maxplan_yn
	pbp_b18c_maxplan_aid_type
	pbp_b18c_maxplan_in_oon
	pbp_b18c_maxplan_per
	pbp_b18c_maxenr_yn
	pbp_b18c_maxenr_per
	pbp_b18c_ded_yn
	pbp_b18c_bendesc_lim
	pbp_b18c_bendesc_per
	pbp_b18c_coins_yn
	pbp_b18c_copay_yn
	pbp_b18c_auth_yn
	pbp_b18c_refer_yn
/ missing;
run;

proc contents data = out.pbp_b18;
  title 'pbp_b18 data';
run;