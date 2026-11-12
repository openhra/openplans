#!/usr/bin/env python3
"""Verify or regenerate Vermont metal evidence from cached admitted publications."""
import argparse
import csv
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile
from prepare import vt_records

SBE_SHA = 'a16f28e7d50ecf93c1d92335f116dd272cffbfc5c261088459bb866cc4aa6342'
RATE_SHA = '8353a9b2d90f2b4b23173c154e0de8ef426b90ec8a897eed965f4b97c82f68c3'
RATE_URL = 'https://info.healthconnect.vermont.gov/sites/vhc/files/documents/2026_PlanDesigns_FinalRates.pdf'
PACKAGE = Path(__file__).resolve().parents[3]
CUT = PACKAGE / 'data/rating-rules/vt-plan-metals-2026.json'


def verified(path, digest):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Cached publication hash mismatch: ' + str(path))
    return data


def name_key(name, issuer):
    # Same exact formatting aliases as vt-hios-exact-v1. Metal comes only from CMS.
    name = ' '.join(name.lower().split())
    if issuer == '13627' and name.startswith('bcbsvt '):
        name = name[7:]
    if issuer == '77566':
        match = re.fullmatch(r'\[(mvp vt(?: plus)?)( hdhp)?\] (.+)', name)
        if match:
            name = match[1] + ' ' + match[3] + (match[2] or '')
    return name


def metal_cut(cache):
    artifact = json.loads((cache / 'derived/state-rating/vt-2026.json').read_text())
    source, = artifact['sources']
    if (artifact['state'] != 'VT' or artifact['plan_year'] != 2026
            or source['sha256'] != RATE_SHA or source['url'] != RATE_URL):
        raise ValueError('Unexpected VT filed publication')
    verified(Path(source['raw_path']), RATE_SHA)
    records = vt_records(Path(source['raw_path']))
    if records != source['records']:
        raise ValueError('Filed artifact differs from original PDF cells')
    archive = verified(cache / 'raw/cms-sbe-puf' / SBE_SHA / 'payload', SBE_SHA)
    member = 'VTPlans05052026.csv'
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        reader = csv.DictReader(io.StringIO(bundle.read(member).decode('utf-8-sig')))
        rows = [(reader.line_num, row) for row in reader
                if row['BUSINESS YEAR'] == '2026' and row['STATE CODE'] == 'VT'
                and row['MARKET COVERAGE'] == 'Individual' and row['DENTAL ONLY PLAN'] == 'No']
    plans = []
    for record in records:
        issuer = {'BCBSVT': '13627', 'MVP': '77566'}[record['issuer']]
        matched = [(n, row) for n, row in rows if row['ISSUER ID'] == issuer
                   and name_key(row['PLAN MARKETING NAME'], issuer) == name_key(record['plan_name'], issuer)]
        ids = {row['STANDARD COMPONENT ID'] for _, row in matched}
        metals = {row['METAL LEVEL'] for _, row in matched}
        if len(ids) != 1 or len(metals) != 1:
            raise ValueError('Missing or ambiguous literal CMS identity/metal')
        plans.append(dict(plan_key=record['issuer'] + ':' + record['plan_name'],
                          source_record=record['source_record'],
                          prices={k: int(Decimal(v) * 100) for k, v in record['prices'].items()},
                          hios_id=next(iter(ids)), metal=next(iter(metals)),
                          attributes=[dict(source_row=n, plan_id=row['PLAN ID'], metal=row['METAL LEVEL'],
                                           exchange=row['QHP NONQHP TYPE ID'],
                                           child_only_offering=row['CHILD ONLY OFFERING'],
                                           ehb_fraction=row['EHB PERCENT PREMIUM']) for n, row in matched]))
    return dict(schema_version='vt-plan-metals-v1', plan_year=2026, rate_url=source['url'],
                rate_sha256=RATE_SHA, bundle_url='https://www.cms.gov/files/zip/vermontsbepuf2026.zip',
                bundle_sha256=SBE_SHA, member=member, plans=plans)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('OPENPLANS_DATA_DIR', Path.home() / '.local/share/openplans')))
    parser.add_argument('--write', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    cut = metal_cut(args.data_dir)
    if args.write:
        CUT.write_text(json.dumps(cut, indent=2) + '\n')
    elif json.loads(CUT.read_text()) != cut:
        raise ValueError('VT metal source cut differs from cached publications')
    silver = sorted((p for p in cut['plans'] if p['metal'] == 'Silver'), key=lambda p: (p['prices']['single'], p['plan_key']))
    ehb = lambda p: int((Decimal(p['prices']['single']) * Decimal('0.99')).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
    if any(a['ehb_fraction'] != '99%' for p in silver for a in p['attributes']):
        raise ValueError('Review changed Silver EHB fractions')
    report = dict(status='PASS', plans=len(cut['plans']), unknown=0, rating_area='Vermont',
                  silver=[dict(plan_key=p['plan_key'], hios_id=p['hios_id'], monthly_cents=p['prices']['single']) for p in silver],
                  gross_lcsp_cents=silver[0]['prices']['single'], gross_second_silver_cents=silver[1]['prices']['single'],
                  ehb_lcsp_cents=ehb(silver[0]), ehb_second_silver_cents=ehb(silver[1]))
    if args.report:
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
