*pbp_b10_amb_trans.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b10;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b10a_maxenr_yn               $1
	pbp_b10a_maxenr_ehc              $2
	pbp_b10a_maxenr_gas_per          $1
	pbp_b10a_maxenr_gas_per_d        $4000
	pbp_b10a_maxenr_aas_per          $1
	pbp_b10a_maxenr_aas_per_d        $4000
	pbp_b10a_coins_yn                $1
	pbp_b10a_coins_ehc               $2
	pbp_b10a_coins_wav_yn            $1
	pbp_b10a_ded_yn                  $1
	pbp_b10a_ded_ehc                 $2
	pbp_b10a_copay_yn                $1
	pbp_b10a_copay_ehc               $2
	pbp_b10a_copay_wav_yn            $1
	pbp_b10a_auth_yn                 $1
	pbp_b10b_bendesc_yn              $1
	pbp_b10b_bendesc_trn             $1
	pbp_b10b_bendesc_amo_pal         $1
	pbp_b10b_bendesc_lim_pal         $1
	pbp_b10b_bendesc_per_pal         $1
	pbp_b10b_bendesc_per_pal_d       $4000
	pbp_b10b_bendesc_tt_pal          $1
	pbp_b10b_bendesc_tt_pal_d        $4000
	pbp_b10b_bendesc_mt_pal          $6
	pbp_b10b_bendesc_mt_pal_d        $4000
	pbp_b10b_bendesc_amo_al          $1
	pbp_b10b_bendesc_lim_al          $1
	pbp_b10b_bendesc_per_al          $1
	pbp_b10b_bendesc_per_al_d        $4000
	pbp_b10b_bendesc_tt_al           $1
	pbp_b10b_bendesc_tt_al_d         $4000
	pbp_b10b_bendesc_mt_al           $6
	pbp_b10b_bendesc_mt_al_d         $4000
	pbp_b10b_maxplan_yn              $1
	pbp_b10b_maxplan_per             $1
	pbp_b10b_maxplan_per_d           $4000
	pbp_b10b_maxenr_yn               $1
	pbp_b10b_maxenr_per              $1
	pbp_b10b_maxenr_per_d            $4000
	pbp_b10b_coins_yn                $1
	pbp_b10b_ded_yn                  $1
	pbp_b10b_copay_yn                $1
	pbp_b10b_auth_yn                 $1
	pbp_b10b_refer_yn                $1
;

infile '.\pbp\pbp_b10_amb_trans.txt' delimiter = '09'x
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
	pbp_b10a_maxenr_yn
	pbp_b10a_maxenr_ehc
	pbp_b10a_maxenr_gas_amt
	pbp_b10a_maxenr_gas_per
	pbp_b10a_maxenr_gas_per_d
	pbp_b10a_maxenr_aas_amt
	pbp_b10a_maxenr_aas_per
	pbp_b10a_maxenr_aas_per_d
	pbp_b10a_coins_yn
	pbp_b10a_coins_ehc
	pbp_b10a_coins_gas_pct_min
	pbp_b10a_coins_gas_pct_max
	pbp_b10a_coins_aas_pct_min
	pbp_b10a_coins_aas_pct_max
	pbp_b10a_coins_wav_yn
	pbp_b10a_ded_yn
	pbp_b10a_ded_ehc
	pbp_b10a_ded_gas_amt
	pbp_b10a_ded_aas_amt
	pbp_b10a_copay_yn
	pbp_b10a_copay_ehc
	pbp_b10a_copay_gas_amt_min
	pbp_b10a_copay_gas_amt_max
	pbp_b10a_copay_aas_amt_min
	pbp_b10a_copay_aas_amt_max
	pbp_b10a_copay_wav_yn
	pbp_b10a_auth_yn
	pbp_b10b_bendesc_yn
	pbp_b10b_bendesc_trn
	pbp_b10b_bendesc_amo_pal
	pbp_b10b_bendesc_lim_pal
	pbp_b10b_bendesc_amt_pal
	pbp_b10b_bendesc_per_pal
	pbp_b10b_bendesc_per_pal_d
	pbp_b10b_bendesc_tt_pal
	pbp_b10b_bendesc_tt_pal_d
	pbp_b10b_bendesc_amt_pal_days
	pbp_b10b_bendesc_mt_pal
	pbp_b10b_bendesc_mt_pal_d
	pbp_b10b_bendesc_amo_al
	pbp_b10b_bendesc_lim_al
	pbp_b10b_bendesc_amt_al
	pbp_b10b_bendesc_per_al
	pbp_b10b_bendesc_per_al_d
	pbp_b10b_bendesc_tt_al
	pbp_b10b_bendesc_tt_al_d
	pbp_b10b_bendesc_amt_al_days
	pbp_b10b_bendesc_mt_al
	pbp_b10b_bendesc_mt_al_d
	pbp_b10b_maxplan_yn
	pbp_b10b_maxplan_amt
	pbp_b10b_maxplan_per
	pbp_b10b_maxplan_per_d
	pbp_b10b_maxenr_yn
	pbp_b10b_maxenr_amt
	pbp_b10b_maxenr_per
	pbp_b10b_maxenr_per_d
	pbp_b10b_coins_yn
	pbp_b10b_coins_pct_min
	pbp_b10b_coins_pct_max
	pbp_b10b_ded_yn
	pbp_b10b_ded_amt
	pbp_b10b_copay_yn
	pbp_b10b_copay_amt_min
	pbp_b10b_copay_amt_max
	pbp_b10b_auth_yn
	pbp_b10b_refer_yn
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
	pbp_b10a_maxenr_yn               = 'Ambulance Max Enr YN'
	pbp_b10a_maxenr_ehc              = 'Ambulance maxenr benefits'
	pbp_b10a_maxenr_gas_amt          = 'Ambulance Grnd Max Enr Amt'
	pbp_b10a_maxenr_gas_per          = 'Ambulance Grnd Max Enr Per'
	pbp_b10a_maxenr_gas_per_d        = 'Ambulance Grnd Max Enr Per Des'
	pbp_b10a_maxenr_aas_amt          = 'Ambulance Air Max Enr Amt'
	pbp_b10a_maxenr_aas_per          = 'Ambulance Air Max Enr Per'
	pbp_b10a_maxenr_aas_per_d        = 'Ambulance Air Max Enr Per Desc'
	pbp_b10a_coins_yn                = 'Ambulance Coinsurance YN'
	pbp_b10a_coins_ehc               = 'Ambulance coins benefits'
	pbp_b10a_coins_gas_pct_min       = 'Ambulance Grnd Coins Min Pct'
	pbp_b10a_coins_gas_pct_max       = 'Ambulance Grnd Coins Max Pct'
	pbp_b10a_coins_aas_pct_min       = 'Ambulance Air MC Min Coins Pct'
	pbp_b10a_coins_aas_pct_max       = 'Ambulance Air MC Max Coins Pct'
	pbp_b10a_coins_wav_yn            = 'Ambulance Coins Waved YN'
	pbp_b10a_ded_yn                  = 'Ambulance Deductible YN'
	pbp_b10a_ded_ehc                 = 'Ambulance deductible benefits'
	pbp_b10a_ded_gas_amt             = 'Ambulance Grnd Deductible Amt'
	pbp_b10a_ded_aas_amt             = 'Ambulance Air Deductible Amt'
	pbp_b10a_copay_yn                = 'Ambulance Copayment YN'
	pbp_b10a_copay_ehc               = 'Ambulance copay benefits'
	pbp_b10a_copay_gas_amt_min       = 'Ambulance Grnd Copay Min Amt'
	pbp_b10a_copay_gas_amt_max       = 'Ambulance Grnd Copay Max Amt'
	pbp_b10a_copay_aas_amt_min       = 'Ambulance Air MC Min Copay Amt'
	pbp_b10a_copay_aas_amt_max       = 'Ambulance Air MC Max Copay Amt'
	pbp_b10a_copay_wav_yn            = 'Ambulance Copay Waved YN'
	pbp_b10a_auth_yn                 = 'Ambulance Auth YN'
	pbp_b10b_bendesc_yn              = 'Transport Ben Desc YN'
	pbp_b10b_bendesc_trn             = 'Transport Ben Desc Enhance'
	pbp_b10b_bendesc_amo_pal         = 'Transport PAL Ben Desc MO'
	pbp_b10b_bendesc_lim_pal         = 'Transport PAL Ben Desc Lim YN'
	pbp_b10b_bendesc_amt_pal         = 'Transport PAL Ben Desc Num'
	pbp_b10b_bendesc_per_pal         = 'Transport PAL Ben Desc Per'
	pbp_b10b_bendesc_per_pal_d       = 'Transport PAL Ben Per Desc'
	pbp_b10b_bendesc_tt_pal          = 'Transport PAL Ben Desc Type'
	pbp_b10b_bendesc_tt_pal_d        = 'Transport PAL Ben Desc'
	pbp_b10b_bendesc_amt_pal_days    = 'Transport PAL Num Days'
	pbp_b10b_bendesc_mt_pal          = 'Transport PAL Ben Desc Mode'
	pbp_b10b_bendesc_mt_pal_d        = 'Transport PAL Ben Desc'
	pbp_b10b_bendesc_amo_al          = 'Transport AL Ben Desc MO'
	pbp_b10b_bendesc_lim_al          = 'Transport AL Ben Desc Lim YN'
	pbp_b10b_bendesc_amt_al          = 'Transport AL Ben Desc Num'
	pbp_b10b_bendesc_per_al          = 'Transport AL Ben Desc Per'
	pbp_b10b_bendesc_per_al_d        = 'Transport AL Ben Desc Per'
	pbp_b10b_bendesc_tt_al           = 'Transport AL Ben Desc Type'
	pbp_b10b_bendesc_tt_al_d         = 'Transport AL Ben Desc'
	pbp_b10b_bendesc_amt_al_days     = 'Transport AL Num Days'
	pbp_b10b_bendesc_mt_al           = 'Transport AL Ben Desc Mode'
	pbp_b10b_bendesc_mt_al_d         = 'Transport AL Ben Desc'
	pbp_b10b_maxplan_yn              = 'Transport Max Plan YN'
	pbp_b10b_maxplan_amt             = 'Transport Max Plan Amt'
	pbp_b10b_maxplan_per             = 'Transport Max Plan Per'
	pbp_b10b_maxplan_per_d           = 'Transport Max Plan Per Desc'
	pbp_b10b_maxenr_yn               = 'Transport Max Enr YN'
	pbp_b10b_maxenr_amt              = 'Transport Max Enr Amt'
	pbp_b10b_maxenr_per              = 'Transport Max Enr Per'
	pbp_b10b_maxenr_per_d            = 'Transport Max Enr Per Desc'
	pbp_b10b_coins_yn                = 'Transport Coinsurance YN'
	pbp_b10b_coins_pct_min           = 'Transport Coins Min Pct'
	pbp_b10b_coins_pct_max           = 'Transport Coins Max Pct'
	pbp_b10b_ded_yn                  = 'Transport Deductible YN'
	pbp_b10b_ded_amt                 = 'Transport Deductible Amt'
	pbp_b10b_copay_yn                = 'Transport Copayment YN'
	pbp_b10b_copay_amt_min           = 'Transport Copay Min Amt'
	pbp_b10b_copay_amt_max           = 'Transport Copay Max Amt'
	pbp_b10b_auth_yn                 = 'Transport Enrollee Auth'
	pbp_b10b_refer_yn                = 'Transport Referral YN'
;

run;

proc sort data = pbp_b10 out=out.pbp_b10;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b10(obs = 10);
  title 'pbp_b10_amb_trans file ';
run;

proc means data = out.pbp_b10;
  title 'pbp_b10_amb_trans file ';
run;

proc freq data = out.pbp_b10;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b10a_maxenr_yn
	pbp_b10a_maxenr_ehc
	pbp_b10a_maxenr_gas_per
	pbp_b10a_maxenr_aas_per
	pbp_b10a_coins_yn
	pbp_b10a_coins_ehc
	pbp_b10a_coins_wav_yn
	pbp_b10a_ded_yn
	pbp_b10a_ded_ehc
	pbp_b10a_copay_yn
	pbp_b10a_copay_ehc
	pbp_b10a_copay_wav_yn
	pbp_b10a_auth_yn
	pbp_b10b_bendesc_yn
	pbp_b10b_bendesc_trn
	pbp_b10b_bendesc_amo_pal
	pbp_b10b_bendesc_lim_pal
	pbp_b10b_bendesc_per_pal
	pbp_b10b_bendesc_tt_pal
	pbp_b10b_bendesc_amo_al
	pbp_b10b_bendesc_lim_al
	pbp_b10b_bendesc_per_al
	pbp_b10b_bendesc_tt_al
	pbp_b10b_maxplan_yn
	pbp_b10b_maxplan_per
	pbp_b10b_maxenr_yn
	pbp_b10b_maxenr_per
	pbp_b10b_coins_yn
	pbp_b10b_ded_yn
	pbp_b10b_copay_yn
	pbp_b10b_auth_yn
	pbp_b10b_refer_yn
/ missing;
run;

proc contents data = out.pbp_b10;
  title 'pbp_b10 data';
run;