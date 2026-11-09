#!/usr/bin/env python3
"""Cut unchanged public rows for column/variant mapping tests from cached CMS archives."""
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
sources = [
    ('cms-exchange-puf', '954e697885efcb709aed0be1de14075afe11704bf3447372960d08c879950af2', 'https://download.cms.gov/marketplace-puf/2026/plan-attributes-puf.zip', 'plan-attributes-puf.csv', 'plan-attributes', '87226TX0100013'),
    ('cms-exchange-puf', '954e697885efcb709aed0be1de14075afe11704bf3447372960d08c879950af2', 'https://download.cms.gov/marketplace-puf/2026/plan-attributes-puf.zip', 'plan-attributes-puf.csv', 'plan-attributes', '11718TX0140016'),
    ('cms-exchange-puf', 'aa2d6874704bc951ed28792af3e65a4bd5b48eb3dbc086325f5ce053f08d8682', 'https://download.cms.gov/marketplace-puf/2026/benefits-and-cost-sharing-puf.zip', 'benefits-and-cost-sharing-puf.csv', 'benefits-and-cost-sharing', '87226TX0100013'),
    ('cms-sbe-puf', 'add2693a835b2f042e43c1bbf1207020ac484c5d18b2cbc0cda49700bb9a30ad', 'https://www.cms.gov/files/zip/newyorksbepuf2026.zip', 'NYPlans05052026.csv', 'plan-attributes', '11177NY0220001'),
    ('cms-sbe-puf', 'add2693a835b2f042e43c1bbf1207020ac484c5d18b2cbc0cda49700bb9a30ad', 'https://www.cms.gov/files/zip/newyorksbepuf2026.zip', 'NYBenefits05052026.csv', 'benefits-and-cost-sharing', '11177NY0220001'),
    ('cms-sbe-puf', 'a16f28e7d50ecf93c1d92335f116dd272cffbfc5c261088459bb866cc4aa6342', 'https://www.cms.gov/files/zip/vermontsbepuf2026.zip', 'VTPlans05052026.csv', 'plan-attributes', '13627VT0340003'),
    ('cms-sbe-puf', 'a16f28e7d50ecf93c1d92335f116dd272cffbfc5c261088459bb866cc4aa6342', 'https://www.cms.gov/files/zip/vermontsbepuf2026.zip', 'VTBenefits05052026.csv', 'benefits-and-cost-sharing', '13627VT0340003'),
]
benefits = {'Primary Care Visit to Treat an Injury or Illness', 'Emergency Room Services', 'Generic Drugs', 'Chiropractic Care'}
out = {'kind': 'real-public-row-cut', 'sources': []}
for group, digest, url, member, kind, base in sources:
    path = args.data_dir / 'raw' / group / digest / 'payload'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    rows = []
    with zipfile.ZipFile(path) as archive, archive.open(member) as file:
        for line, row in enumerate(csv.DictReader(io.TextIOWrapper(file, encoding='utf-8-sig')), 2):
            if (row.get('PlanId') or row.get('PLAN ID')) not in {base+'-01', base+'-05'}:
                continue
            if kind == 'benefits-and-cost-sharing' and (row.get('BenefitName') or row.get('BENEFIT NAME')) not in benefits:
                continue
            rows.append({'source_row': line, 'values': row})
    assert rows
    out['sources'].append({'sha256': digest, 'url': url, 'member': member, 'kind': kind, 'base': base, 'rows': rows})
path = Path(__file__).with_name('mapping-public.json')
path.write_text(json.dumps(out, indent=2)+'\n')
assert path.stat().st_size < 200_000
print(f'{path.name}: {path.stat().st_size} bytes')
