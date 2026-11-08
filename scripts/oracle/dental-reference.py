#!/usr/bin/env python3
"""Cache-only, independent Decimal/CSV SADP oracle. Does not import application rating code.
Finite basis: every raw row, every 0..63 age plus 64/65/80/120 terminal-band probes,
both tobacco flags, both interval boundaries; all eight family columns and 3+ counts.
Mixed-age families exercise the additive path, child cap, and relationship evidence.
"""
import argparse
import csv
import hashlib
import io
import json
import re
import zipfile
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

FIELDS = ['IndividualRate', 'Couple', 'PrimarySubscriberAndOneDependent', 'PrimarySubscriberAndTwoDependents',
          'PrimarySubscriberAndThreeOrMoreDependents', 'CoupleAndOneDependent', 'CoupleAndTwoDependents', 'CoupleAndThreeOrMoreDependents']


def cents(text):
    if text == '':
        return None
    if not re.fullmatch(r'\d+(?:\.\d{1,2})?', text):
        raise ValueError('Invalid filed amount')
    return int(Decimal(text) * 100)


def rows(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != 1 or not names[0].lower().endswith('.csv'):
            raise ValueError('Expected single CSV member')
        with io.TextIOWrapper(archive.open(names[0]), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            reader.fieldnames
            while True:
                line = reader.line_num + 1
                row = next(reader, None)
                if row is None:
                    return
                yield line, row


def collect(cache, manifest, output, summary_path):
    source = json.loads(manifest.read_text())
    summary = {'year': 2026, 'state': 'TX', 'sources': {}, 'tx_rate_rows': 0, 'tx_individual_rate_rows': 0,
               'tx_shop_rate_rows': 0, 'tx_family_option_rows': 0, 'family_option_rows_other_states': 0, 'plans': {}, 'harris_ids': []}
    paths = {}
    for kind in ['plan-attributes', 'business-rules', 'service-area', 'rate']:
        candidates = [r for r in source['files'] if r['kind'] == kind and r['year'] == 2026 and r['status'] == 'ok']
        if len(candidates) != 1:
            raise ValueError('Missing or ambiguous acquired archive')
        metadata = candidates[0]
        if not re.fullmatch('[a-f0-9]{64}', metadata['snapshot_id']):
            raise ValueError('Invalid source identity')
        path = cache / 'raw/cms-exchange-puf' / metadata['snapshot_id'] / 'payload'
        with path.open('rb') as stream:
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
            sha = digest.hexdigest()
        if sha != metadata['sha256'] or path.stat().st_size != metadata['bytes']:
            raise ValueError('Acquisition SHA/bytes mismatch')
        paths[kind] = path
        summary['sources'][kind] = {'path': str(path), 'sha256': sha, 'url': metadata['url']}
    attributes, business, areas = defaultdict(list), defaultdict(list), []
    for line, r in rows(paths['plan-attributes']):
        if r['DentalOnlyPlan'] == 'Yes':
            attributes[r['StandardComponentId']].append({'raw': r, 'source_row': line})
    for line, r in rows(paths['business-rules']):
        if r['DentalOnlyPlan'] == 'Yes':
            business[r['StandardComponentId']].append({'raw': r, 'source_row': line})
    for line, r in rows(paths['service-area']):
        if r['StateCode'] == 'TX' and r['DentalOnlyPlan'] == 'Yes' and (r['County'] == '48201' or r['CoverEntireState'] == 'Yes'):
            areas.append(r)
    for pid, records in attributes.items():
        r = records[0]['raw']
        if r['StateCode'] != 'TX':
            continue
        summary['plans'][pid] = {'market': r['MarketCoverage'], 'attributes': records, 'business': business[pid]}
        if r['MarketCoverage'] == 'Individual' and any(a['IssuerId'] == r['IssuerId'] and a['ServiceAreaId'] == r['ServiceAreaId'] and a['MarketCoverage'] == 'Individual' for a in areas):
            summary['harris_ids'].append(pid)
    groups = defaultdict(list)
    with output.open('w') as out:
        for line, r in rows(paths['rate']):
            attrs = attributes.get(r['PlanId'])
            if not attrs:
                continue
            is_tx = r['StateCode'] == 'TX'
            if not is_tx and r['Age'] != 'Family Option':
                continue
            if is_tx:
                summary['tx_rate_rows'] += 1
                summary['tx_individual_rate_rows' if attrs[0]['raw']['MarketCoverage'] == 'Individual' else 'tx_shop_rate_rows'] += 1
                summary['tx_family_option_rows'] += int(r['Age'] == 'Family Option')
            else:
                summary['family_option_rows_other_states'] += 1
            item = {'source_row': line, 'plan': r['PlanId'], 'state': r['StateCode'], 'area': r['RatingAreaId'],
                    'age': r['Age'], 'tobacco': r['Tobacco'], 'effective': r['RateEffectiveDate'], 'expiration': r['RateExpirationDate'],
                    'market': attrs[0]['raw']['MarketCoverage'], 'prices': {k: cents(r[k]) for k in FIELDS},
                    'tobacco_price': cents(r['IndividualTobaccoRate'])}
            if not is_tx:
                item.update(raw=r, business=business[r['PlanId']])
            else:
                groups[(r['PlanId'], r['RatingAreaId'], r['RateEffectiveDate'], r['RateExpirationDate'])].append(r)
            out.write(json.dumps(item, separators=(',', ':')) + '\n')
    cases = []
    for (pid, area, effective, expiration), rate_rows in groups.items():
        if any(r['Age'] == 'Family Option' for r in rate_rows):
            continue
        br = business[pid]
        caps = {r['raw']['MaximumUnderageDependent'] for r in br}
        cap = int(next(iter(caps))) if len(caps) == 1 and next(iter(caps)) in ['1', '2', '3'] else 3
        for adult_ages, child_ages in [([35], []), ([35,40], [10,17]), ([], [10]),
                                      ([35,40], [0,14,15,18,20,21]), ([35], [10,15,18,20])]:
            members = [{'id': f'a{i}', 'age': age, 'relationship': 'subscriber' if i == 0 else 'spouse', 'tobaccoUse': True} for i, age in enumerate(adult_ages)]
            members += [{'id': f'c{i}', 'age': age, 'relationship': 'child', 'tobaccoUse': False} for i, age in enumerate(child_ages)]
            counted = {m['id'] for m in sorted([m for m in members if m['relationship'] == 'child' and m['age'] < 21], key=lambda m: -m['age'])[:cap]}
            total, pediatric, charged = 0, 0, []
            for m in members:
                if m['relationship'] == 'child' and m['age'] < 21 and m['id'] not in counted:
                    continue
                band = '0-14' if m['age'] < 15 else '64 and over' if m['age'] >= 64 else str(m['age'])
                selected = [r for r in rate_rows if r['Age'] == band]
                if len(selected) != 1:
                    raise ValueError('Incomplete or ambiguous independent rate group')
                r = selected[0]
                value = cents(r['IndividualRate'] if r['Tobacco'] == 'No Preference' or not m['tobaccoUse'] else r['IndividualTobaccoRate'])
                if value is None:
                    raise ValueError('Mixed household case needs a published price')
                total += value
                pediatric += value if m['age'] < 19 else 0
                charged.append(m['id'])
            fractions = {r['raw']['EHBPediatricDentalApportionmentQuantity'] for r in attributes[pid]}
            fraction = next(iter(fractions)) if len(fractions) == 1 else ''
            ehb = int((Decimal(pediatric) * Decimal(fraction)).quantize(Decimal('1'), rounding='ROUND_HALF_UP')) if re.fullmatch(r'(?:0(?:\.\d+)?|1(?:\.0+)?)', fraction) else None
            cases.append({'plan':pid,'state':'TX','market':attributes[pid][0]['raw']['MarketCoverage'],'area':area,
                          'age':'mixed','tobacco':'No Preference','effective':effective,'expiration':expiration,'members':members,
                          'expected_cents':total,'pediatric_gross_cents':pediatric,'pediatric_ehb_cents':ehb,'charged_ids':charged})
    summary['household_cases'] = cases
    summary['harris_ids'].sort()
    summary_path.write_text(json.dumps(summary, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['cache', 'manifest', 'output', 'summary']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    collect(args.cache, args.manifest, args.output, args.summary)
