#!/usr/bin/env python3
"""Cut unchanged public rows for the plan-level and benefit-row column tests.

Rows come from the pinned CMS 2026 Plan Attributes and Benefits and Cost Sharing PUFs.
Plans are picked by public cell patterns only: the first standard on-exchange variant
(-01) in file order that matches each predicate.
"""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--data-dir', type=Path, default=os.environ.get('OPENPLANS_DATA_DIR'))
args = parser.parse_args()
if args.data_dir is None:
    parser.error('--data-dir or OPENPLANS_DATA_DIR is required')

ATTRIBUTES = ('954e697885efcb709aed0be1de14075afe11704bf3447372960d08c879950af2',
              'https://download.cms.gov/marketplace-puf/2026/plan-attributes-puf.zip', 'plan-attributes-puf.csv')
BENEFITS = ('aa2d6874704bc951ed28792af3e65a4bd5b48eb3dbc086325f5ce053f08d8682',
            'https://download.cms.gov/marketplace-puf/2026/benefits-and-cost-sharing-puf.zip',
            'benefits-and-cost-sharing-puf.csv')
BENEFIT_NAMES = {
    'Routine Dental Services (Adult)', 'Infertility Treatment', 'Prenatal and Postnatal Care',
    'Outpatient Facility Fee (e.g., Ambulatory Surgery Center)',
    'Delivery and All Inpatient Services for Maternity Care',
    'Non-Preferred Generic', 'Non-Preferred Generic Drugs', 'Non-Preferred Specialty Drugs',
    'Non Preferred Specialty Drugs', 'Primary Care Visit to Treat an Injury or Illness', 'Specialist Visit',
    'Emergency Room Services',
}


def rows(source):
    digest, _, member = source
    path = args.data_dir / 'raw' / 'cms-exchange-puf' / digest / 'payload'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    with zipfile.ZipFile(path) as archive, archive.open(member) as file:
        yield from enumerate(csv.DictReader(io.TextIOWrapper(file, encoding='utf-8-sig')), 2)


medical = lambda r: r['PlanId'].endswith('-01') and r['DentalOnlyPlan'] == 'No' and r['MarketCoverage'] == 'Individual'
attribute_cases = [
    ('standardized-integrated-full-ehb', lambda r: medical(r) and r['DesignType'].startswith('Design ')
        and r['MedicalDrugDeductiblesIntegrated'] == 'Yes' and r['EHBPercentTotalPremium'] == '1'
        and r['PlanExpirationDate'] == '12/31/2026'),
    ('non-standard-separate-fractional-ehb', lambda r: medical(r) and r['DesignType'] == 'Not Applicable'
        and r['MedicalDrugDeductiblesIntegrated'] == 'No' and r['EHBPercentTotalPremium'] not in ('', '1')
        and r['PlanExpirationDate'] == ''),
    ('dental-only-blank-design', lambda r: r['DentalOnlyPlan'] == 'Yes' and r['DesignType'] == ''
        and r['EHBPercentTotalPremium'] == ''),
]
attribute_rows, picked = [], {}
for line, row in rows(ATTRIBUTES):
    for label, predicate in attribute_cases:
        if label not in picked and predicate(row):
            picked[label] = row['PlanId']
            attribute_rows.append({'label': label, 'source_row': line, 'values': row})
    if len(picked) == len(attribute_cases):
        break
assert len(picked) == len(attribute_cases), picked

# Benefit rows for the first standardized plan, the first plan that covers adult dental
# and infertility treatment, and the first plan that publishes a non-preferred generic row.
by_plan = {}
for line, row in rows(BENEFITS):
    if row['PlanId'].endswith('-01') and row['BenefitName'] in BENEFIT_NAMES:
        by_plan.setdefault(row['PlanId'], []).append({'source_row': line, 'values': row})
covered = lambda plan, name: any(r['values']['BenefitName'] == name and r['values']['IsCovered'] == 'Covered'
                                 for r in by_plan[plan])
named = lambda plan, name: any(r['values']['BenefitName'] == name for r in by_plan[plan])
rich = next(p for p in by_plan if covered(p, 'Routine Dental Services (Adult)')
            and covered(p, 'Infertility Treatment'))
nonpreferred = next(p for p in by_plan if named(p, 'Non-Preferred Generic'))
benefit_plans = {'standardized-integrated-full-ehb': picked['standardized-integrated-full-ehb'],
                 'covered-dental-infertility': rich, 'nonpreferred-generic': nonpreferred}
out = {
    'kind': 'real-public-row-cut',
    'attributes': {'sha256': ATTRIBUTES[0], 'url': ATTRIBUTES[1], 'member': ATTRIBUTES[2], 'rows': attribute_rows},
    'benefits': {'sha256': BENEFITS[0], 'url': BENEFITS[1], 'member': BENEFITS[2],
                 'plans': [{'label': label, 'plan_id': plan, 'rows': by_plan[plan]}
                           for label, plan in benefit_plans.items()]},
}
path = Path(__file__).with_name('plan-puf-columns-public.json')
path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n')
assert path.stat().st_size < 200_000
print(f'{path.name}: {path.stat().st_size} bytes')
