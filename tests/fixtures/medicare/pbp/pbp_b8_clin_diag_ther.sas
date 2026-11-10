*pbp_b8_clin_diag_ther.sas;

libname out '.\sas_data_sets\PBP';
options pageno=1 linesize = 200 nocenter;

data pbp_b8;

length
	pbp_a_hnumber                    $5
	pbp_a_plan_identifier            $3
	pbp_a_ben_cov                    $1
	pbp_a_plan_type                  $2
	orgtype                          $2
	bid_id                           $13
	pbp_b8a_maxenr_yn                $1
	pbp_b8a_maxenr_per               $1
	pbp_b8a_maxenr_per_d             $4000
	pbp_b8a_coins_yn                 $1
	pbp_b8a_coins_ehc                $2
	pbp_b8a_ded_yn                   $1
	pbp_b8a_copay_yn                 $1
	pbp_b8a_copay_ehc                $2
	pbp_b8a_copay_max_yn             $1
	pbp_b8a_auth_yn                  $1
	pbp_b8a_refer_yn                 $1
	pbp_b8b_maxenr_yn                $1
	pbp_b8b_maxenr_per               $1
	pbp_b8b_maxenr_per_d             $4000
	pbp_b8b_coins_yn                 $1
	pbp_b8b_coins_ehc                $3
	pbp_b8b_ded_yn                   $1
	pbp_b8b_copay_yn                 $1
	pbp_b8b_copay_ehc                $3
	pbp_b8b_copay_max_yn             $1
	pbp_b8b_auth_yn                  $1
	pbp_b8b_refer_yn                 $1
;

infile '.\pbp\pbp_b8_clin_diag_ther.txt' delimiter = '09'x
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
	pbp_b8a_maxenr_yn
	pbp_b8a_maxenr_amt
	pbp_b8a_maxenr_per
	pbp_b8a_maxenr_per_d
	pbp_b8a_coins_yn
	pbp_b8a_coins_ehc
	pbp_b8a_coins_pct_dmc
	pbp_b8a_coins_pct_dmc_max
	pbp_b8a_coins_pct_lab
	pbp_b8a_coins_pct_lab_max
	pbp_b8a_ded_yn
	pbp_b8a_ded_amt
	pbp_b8a_copay_yn
	pbp_b8a_copay_ehc
	pbp_b8a_copay_min_dmc_amt
	pbp_b8a_copay_max_dmc_amt
	pbp_b8a_lab_copay_amt
	pbp_b8a_lab_copay_amt_max
	pbp_b8a_copay_max_yn
	pbp_b8a_auth_yn
	pbp_b8a_refer_yn
	pbp_b8b_maxenr_yn
	pbp_b8b_maxenr_amt
	pbp_b8b_maxenr_per
	pbp_b8b_maxenr_per_d
	pbp_b8b_coins_yn
	pbp_b8b_coins_ehc
	pbp_b8b_coins_pct_drs
	pbp_b8b_coins_pct_drs_max
	pbp_b8b_coins_pct_tmc
	pbp_b8b_coins_pct_tmc_max
	pbp_b8b_coins_pct_cmc
	pbp_b8b_coins_pct_cmc_max
	pbp_b8b_ded_yn
	pbp_b8b_ded_amt
	pbp_b8b_copay_yn
	pbp_b8b_copay_ehc
	pbp_b8b_copay_amt_drs
	pbp_b8b_copay_amt_drs_max
	pbp_b8b_copay_amt_tmc
	pbp_b8b_copay_amt_tmc_max
	pbp_b8b_copay_mc_amt
	pbp_b8b_copay_mc_amt_max
	pbp_b8b_copay_max_yn
	pbp_b8b_auth_yn
	pbp_b8b_refer_yn
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
	pbp_b8a_maxenr_yn                = 'Outpnt C/D/T Max Enr YN'
	pbp_b8a_maxenr_amt               = 'Outpnt C/D/T Max Enr Amt'
	pbp_b8a_maxenr_per               = 'Outpnt C/D/T Max Enr Per'
	pbp_b8a_maxenr_per_d             = 'Outpnt C/D/T Max Enr Per Desc'
	pbp_b8a_coins_yn                 = 'Outpnt C/D/T Coinsurance YN'
	pbp_b8a_coins_ehc                = 'Outpnt C/D/T Coins Services'
	pbp_b8a_coins_pct_dmc            = 'Outpnt Diag MC Min Coins Pct'
	pbp_b8a_coins_pct_dmc_max        = 'Outpnt Diag MC Max Coins Pct'
	pbp_b8a_coins_pct_lab            = 'Outpnt Lab Svcs Min Coins Pct'
	pbp_b8a_coins_pct_lab_max        = 'Outpnt Lab Svcs Max Coins Pct'
	pbp_b8a_ded_yn                   = 'Outpnt C/D/T Deductible YN'
	pbp_b8a_ded_amt                  = 'Outpnt C/D/T Deductible Amt'
	pbp_b8a_copay_yn                 = 'Outpnt C/D/T Copayment YN'
	pbp_b8a_copay_ehc                = 'Outpnt C/D/T Copayment Svcs'
	pbp_b8a_copay_min_dmc_amt        = 'Outpnt Diag Min MC Copay Amt'
	pbp_b8a_copay_max_dmc_amt        = 'Outpnt Diag Max MC Copay Amt'
	pbp_b8a_lab_copay_amt            = 'Outpnt LabSvc Min MC Copay Amt'
	pbp_b8a_lab_copay_amt_max        = 'Outpnt LabSvc Max MC Copay Amt'
	pbp_b8a_copay_max_yn             = 'Outpnt C/D/T Max Copay Applies'
	pbp_b8a_auth_yn                  = 'Outpnt C/D/T Auth YN'
	pbp_b8a_refer_yn                 = 'Outpnt C/D/T Referral YN'
	pbp_b8b_maxenr_yn                = 'Outpnt Diag/Rad Max Enr YN'
	pbp_b8b_maxenr_amt               = 'Outpnt Diag/Rad Max Enr Amt'
	pbp_b8b_maxenr_per               = 'Outpnt Diag/Rad Max Enr Per'
	pbp_b8b_maxenr_per_d             = 'Outpnt Diag/Rad Enr Per Desc'
	pbp_b8b_coins_yn                 = 'Outpnt Diag/Rad Coins YN'
	pbp_b8b_coins_ehc                = 'Outpnt Diag/Rad Coins'
	pbp_b8b_coins_pct_drs            = 'Outpnt Diag MC Min Coin Pct'
	pbp_b8b_coins_pct_drs_max        = 'Outpnt Diag MC Max Coin Pct'
	pbp_b8b_coins_pct_tmc            = 'Outpnt Rad tx MC Min Coin Pct'
	pbp_b8b_coins_pct_tmc_max        = 'Outpnt Rad tx MC Max Coin Pct'
	pbp_b8b_coins_pct_cmc            = 'Outpnt X-Rays MC Min Coins Pct'
	pbp_b8b_coins_pct_cmc_max        = 'Outpnt X-Rays MC Max Coins Pct'
	pbp_b8b_ded_yn                   = 'Outpnt Diag/Rad Deductible YN'
	pbp_b8b_ded_amt                  = 'Outpnt Diag/Rad Deductible Amt'
	pbp_b8b_copay_yn                 = 'Outpnt Diag/Rad Copayment YN'
	pbp_b8b_copay_ehc                = 'Outpnt Diag/Rad Copay Services'
	pbp_b8b_copay_amt_drs            = 'Outpnt Diag MC Min Copay Amt'
	pbp_b8b_copay_amt_drs_max        = 'Outpnt Diag MC Max Copay Amt'
	pbp_b8b_copay_amt_tmc            = 'Outpnt Rad tx MC Min Copay Amt'
	pbp_b8b_copay_amt_tmc_max        = 'Outpnt Rad tx Max MC Copay Amt'
	pbp_b8b_copay_mc_amt             = 'Outpnt X-Rays MC Min Copay Amt'
	pbp_b8b_copay_mc_amt_max         = 'Outpnt X-Rays MC Max Copay Amt'
	pbp_b8b_copay_max_yn             = 'Outpnt Diag/Rad Max Copay YN'
	pbp_b8b_auth_yn                  = 'Outpnt Diag/Rad Auth YN'
	pbp_b8b_refer_yn                 = 'Outpnt Diag/Rad Referral YN'
;

run;

proc sort data = pbp_b8 out=out.pbp_b8;
  by Pbp_a_hnumber pbp_a_plan_identifier segment_id;
run;

proc print data = out.pbp_b8(obs = 10);
  title 'pbp_b8_clin_diag_ther file ';
run;

proc means data = out.pbp_b8;
  title 'pbp_b8_clin_diag_ther file ';
run;

proc freq data = out.pbp_b8;
table
	pbp_a_ben_cov
	pbp_a_plan_type
	orgtype
	pbp_b8a_maxenr_yn
	pbp_b8a_maxenr_per
	pbp_b8a_coins_yn
	pbp_b8a_coins_ehc
	pbp_b8a_ded_yn
	pbp_b8a_copay_yn
	pbp_b8a_copay_ehc
	pbp_b8a_copay_max_yn
	pbp_b8a_auth_yn
	pbp_b8a_refer_yn
	pbp_b8b_maxenr_yn
	pbp_b8b_maxenr_per
	pbp_b8b_coins_yn
	pbp_b8b_coins_ehc
	pbp_b8b_ded_yn
	pbp_b8b_copay_yn
	pbp_b8b_copay_ehc
	pbp_b8b_copay_max_yn
	pbp_b8b_auth_yn
	pbp_b8b_refer_yn
/ missing;
run;

proc contents data = out.pbp_b8;
  title 'pbp_b8 data';
run;