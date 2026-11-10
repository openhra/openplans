#!/usr/bin/env python3
"""Cut unchanged public plan rows for the referral, variant-name and AV column tests.

Rows come from the pinned CMS federal Plan Attributes PUF and the CA state PUF (spaced
headers). Selection uses public cell patterns only and picks the first match in file order.
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

FEDERAL = ('cms-exchange-puf', '954e697885efcb709aed0be1de14075afe11704bf3447372960d08c879950af2',
           'https://download.cms.gov/marketplace-puf/2026/plan-attributes-puf.zip', 'plan-attributes-puf.csv')
CA = ('cms-sbe-puf', '8a6d606a6da66b6d61296416d720f0d6b7a2766b398f52757f6ebe3600c52225',
      'https://www.cms.gov/files/zip/californiasbpuf2026.zip', 'CAPlans05052026.csv')


# (label, source, predicate): each label takes the first matching row in file order.
cases = [
    ('federal-av-referral-yes', FEDERAL, lambda r: r['StateCode'] == 'AZ' and r['PlanId'].endswith('-01')
        and r['IssuerActuarialValue'].endswith('%') and r['IsReferralRequiredForSpecialist'] == 'Yes'
        and r['PlanVariantMarketingName']),
    ('federal-blank-av-referral-no', FEDERAL, lambda r: r['StateCode'] == 'FL' and r['PlanId'].endswith('-01')
        and r['IssuerActuarialValue'] == '' and r['IsReferralRequiredForSpecialist'] == 'No'),
    ('federal-variant-name-differs', FEDERAL, lambda r: r['StateCode'] == 'FL'
        and r['PlanVariantMarketingName'] not in ('', r['PlanMarketingName'])),
    ('ca-av-referral-yes-hsa', CA, lambda r: r['PLAN ID'].endswith('-01') and r['ISSUER ACTUARIAL VALUE'].endswith('%')
        and r['IS REFERRAL REQUIRED FOR SPECIALIST'] == 'Yes' and r['IS HSA ELIGIBLE'] == 'Yes'),
    ('ca-blank-av-blank-referral', CA, lambda r: r['PLAN ID'].endswith('-01') and r['ISSUER ACTUARIAL VALUE'] == ''
        and r['IS REFERRAL REQUIRED FOR SPECIALIST'] == ''),
]
out = {'kind': 'real-public-row-cut', 'rows': []}
for label, (group, digest, url, member), predicate in cases:
    path = args.data_dir / 'raw' / group / digest / 'payload'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    with zipfile.ZipFile(path) as archive, archive.open(member) as file:
        for line, row in enumerate(csv.DictReader(io.TextIOWrapper(file, encoding='utf-8-sig')), 2):
            if predicate(row):
                out['rows'].append({'label': label, 'sha256': digest, 'url': url, 'member': member,
                                    'source_row': line, 'values': row})
                break
        else:
            raise SystemExit(f'no public row for {label}')
path = Path(__file__).with_name('plan-columns-public.json')
path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + '\n')
assert path.stat().st_size < 200_000
print(f'{path.name}: {path.stat().st_size} bytes')
