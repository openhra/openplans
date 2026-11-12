#!/usr/bin/env python3
"""Verify or regenerate the small NY identity cut using cached public files only."""
import argparse
from collections import Counter
import csv
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import io
import json
import os
from pathlib import Path
import re
import zipfile
from prepare import ooxml_sheets, ny_records

SBE_SHA = 'add2693a835b2f042e43c1bbf1207020ac484c5d18b2cbc0cda49700bb9a30ad'
PACKAGE = Path(__file__).resolve().parents[3]
CUT = PACKAGE / 'data/rating-rules/ny-plan-identities-2026.json'


def verified(path, sha):
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != sha:
        raise ValueError('Cached publication hash mismatch: ' + str(path))
    return data


def read_attributes(cache):
    raw = verified(cache / 'raw/cms-sbe-puf' / SBE_SHA / 'payload', SBE_SHA)
    with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
        member = 'NYPlans05052026.csv'
        reader = csv.DictReader(io.StringIO(bundle.read(member).decode('utf-8-sig')))
        return member, [(reader.line_num, row) for row in reader]


def identity_cut(cache, artifact):
    member, attributes = read_attributes(cache)
    ids = {r['STANDARD COMPONENT ID'] for _, r in attributes
           if r['BUSINESS YEAR'] == '2026' and r['STATE CODE'] == 'NY'
           and r['MARKET COVERAGE'] == 'Individual' and r['DENTAL ONLY PLAN'] == 'No'}
    publications = []
    for source in artifact['sources']:
        verified(Path(source['raw_path']), source['sha256'])
        if ny_records(Path(source['raw_path'])) != source['records']:
            raise ValueError('Filed artifact differs from original rate cells')
        missing = {r['plan_id'] for r in source['records'] if r['plan_id'] not in ids}
        if not missing:
            continue
        url = source['url'].replace('/45010883/', '/45010894/').replace('_ApprRatesTemplate', '_FinalExhibits')
        metas = [p for p in (cache / 'raw/state-rating').glob('*.meta.json')
                 if json.loads(p.read_text()).get('url') == url]
        metadata, = metas
        meta = json.loads(metadata.read_text())
        raw = verified(Path(str(metadata)[:-10]), meta['sha256'])
        with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
            workbook, = [n for n in bundle.namelist() if '_23_' in n and n.endswith('.xlsm')]
            rows = ooxml_sheets(bundle.read(workbook))['23']
        if any('NY' in cells.get(4, '') and not re.fullmatch(r'\d{5}NY\d{9}', cells[4]) for cells in rows.values()):
            raise ValueError('Unreviewed current HIOS variant format')
        columns = [3, 4, 6, 7, 16, *range(70, 78)]
        facts = [{'source_row': line, 'cells': {str(c): cells.get(c, '') for c in columns}}
                 for line, cells in rows.items()
                 if re.fullmatch(r'\d{5}NY\d{9}', cells.get(4, '')) and cells[4][:14] in missing]
        publications.append(dict(rate_url=source['url'], rate_sha256=source['sha256'],
                                 url=url, sha256=meta['sha256'], member=workbook,
                                 headers={str(c): rows[3][c] for c in columns}, rows=facts))
    return dict(schema_version='ny-plan-identities-v1', plan_year=2026, publications=publications)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('OPENPLANS_DATA_DIR', Path.home() / '.local/share/openplans')))
    parser.add_argument('--write', action='store_true', help='regenerate the committed source cut')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    cache = args.data_dir.resolve()
    artifact = json.loads((cache / 'derived/state-rating/ny-2026.json').read_text())
    assert (artifact['schema_version'], artifact['state'], artifact['plan_year']) == ('state-rates-v1', 'NY', 2026)
    cut = identity_cut(cache, artifact)
    if args.write:
        CUT.write_text(json.dumps(cut, indent=2) + '\n')
    if json.loads(CUT.read_text()) != cut:
        raise ValueError('Reviewed NY identity cut differs from cached source fields')
    member, attributes = read_attributes(cache)
    by_id = {}
    for line, row in attributes:
        if (row['BUSINESS YEAR'], row['STATE CODE'], row['MARKET COVERAGE'], row['DENTAL ONLY PLAN']) == ('2026', 'NY', 'Individual', 'No'):
            by_id.setdefault(row['STANDARD COMPONENT ID'], []).append((line, row))
    regions, sources, evidence = {}, {}, []
    for source in artifact['sources']:
        totals = Counter()
        for row in source['records']:
            region = regions.setdefault(row['region'], Counter())
            region['total'] += 1
            if row['plan_id'] in by_id:
                region['before_matched'] += 1
                region['after_matched'] += 1
                facts = by_id[row['plan_id']]
                if {r['METAL LEVEL'] for _, r in facts} == {'Silver'}:
                    region['silver_plan_count'] += 1
                    assert all(r['CHILD ONLY OFFERING'] in {'Allows Adult and Child-Only', 'Allows Adult-Only'} for _, r in facts)
                    cents = int(Decimal(row['prices']['single']) * 100)
                    shares = {r['EHB PERCENT PREMIUM'].strip() for _, r in facts}
                    before = {v for v in shares if re.fullmatch(r'(0(?:\.\d{1,12})?|1(?:\.0{1,12})?)', v)}
                    region['ehb_known_before'] += int(len(before) == 1 and before == shares)
                    normalized = {Decimal(v.rstrip('%').strip()) / (100 if v.endswith('%') or Decimal(v) > 1 else 1)
                                  for v in shares}
                    assert len(normalized) == 1 and all(0 <= v <= 1 for v in normalized)
                    region['ehb_known_after'] += 1
                    ehb_cents = int((Decimal(cents) * next(iter(normalized))).quantize(Decimal('1'), rounding=ROUND_HALF_UP))
                    old_ehb = region.get('ehb_lcsp_cents', ehb_cents + 1)
                    if ehb_cents < old_ehb:
                        region['ehb_lcsp_cents'] = ehb_cents
                        region['ehb_lcsp_ids'] = [row['plan_id']]
                    elif ehb_cents == old_ehb:
                        region['ehb_lcsp_ids'].append(row['plan_id'])
                    old = region.get('gross_lcsp_cents', cents + 1)
                    if cents < old:
                        region['gross_lcsp_cents'] = cents
                        region['gross_lcsp_ids'] = [row['plan_id']]
                    elif cents == old:
                        region['gross_lcsp_ids'].append(row['plan_id'])
                continue
            totals['before_unmatched'] += 1
            region['before_unmatched'] += 1
            publication, = [p for p in cut['publications'] if p['rate_url'] == source['url']]
            column = str(69 + int(row['region'][-1]))
            matches = [r for r in publication['rows'] if r['cells']['4'][:14] == row['plan_id']]
            priced = [r for r in matches if r['cells'][column] and Decimal(r['cells'][column]).quantize(Decimal('.01'), rounding=ROUND_HALF_UP) == Decimal(row['prices']['single'])]
            metals = {r['cells']['6'] for r in matches}
            assert priced and len(metals) == 1 and next(iter(metals)) in {'Bronze', 'Silver', 'Gold', 'Platinum', 'Catastrophic'}
            assert all(r['cells']['3'] == 'Individual' and r['cells']['16'] == 'No' for r in matches)
            off = all(r['cells']['7'] == 'Off' for r in matches)
            assert off or metals == {'Catastrophic'}
            region['after_matched'] += 1
            region['off_exchange' if off else 'catastrophic'] += 1
            totals['mapped'] += 1
            evidence.append(dict(plan_id=row['plan_id'], region=row['region'], filed_source_record=row['source_record'],
                                 source_url=publication['url'], source_sha256=publication['sha256'], member=publication['member'],
                                 source_rows=[r['source_row'] for r in matches], price_rows=[r['source_row'] for r in priced],
                                 identity_column='E', metal_column='G', exchange_column='H', region_price_column='B' + chr(65 + int(column) - 52),
                                 current_hios_ids=[r['cells']['4'] for r in matches],
                                 exchange_cells=[r['cells']['7'] for r in matches],
                                 region_price_values=[r['cells'][column] for r in priced], filed_single=row['prices']['single'],
                                 metal=next(iter(metals)), off_exchange=off))
        sources[source['url']] = dict(totals)
    for region in regions.values():
        region['gross_lcsp_ids'].sort()
        region['ehb_lcsp_ids'].sort()
        region['after_unmatched'] = 0
    report = dict(status='PASS', sbe_sha256=SBE_SHA, sbe_member=member, regions=dict(sorted(regions.items())), sources=sources, evidence=evidence)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({k: v for k, v in report.items() if k != 'evidence'}))


if __name__ == '__main__':
    main()
