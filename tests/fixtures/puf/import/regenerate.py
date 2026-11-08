#!/usr/bin/env python3
"""Offline, unmodified cuts of the newest acquired CMS TX PY2026/PY2027 PUF archives (--year).

One variant each for a county medical plan, a statewide dental plan and a partial
county medical plan. Rates retain a complete real 51-band group per base plan.
Other-state rows prove streaming state filtering. Row offsets and archive SHA-256
are retained in provenance.json. No invented premiums or benefit assertions.
"""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile

root = Path(os.environ.get('OPENPLANS_DATA_DIR') or (Path.home() / '.local' / 'share' / 'openplans')) / 'raw/cms-exchange-puf'
manifest_path = sorted(root.glob('manifest-*.json'))[-1]
manifest = json.loads(manifest_path.read_text())
parser = argparse.ArgumentParser()
parser.add_argument('--year', type=int, choices=[2026, 2027], default=2026)
year = parser.parse_args().year
output = Path(__file__).parent if year == 2026 else Path(__file__).parent.parent / 'import-2027'
output.mkdir(exist_ok=True)
kinds = ['plan-attributes', 'service-area', 'network', 'business-rules', 'rate', 'benefits-and-cost-sharing']
files = {f['kind']: f for f in manifest['files'] if f['year'] == year and f['kind'] in kinds}

def records(kind):
    file = files[kind]
    with zipfile.ZipFile(root / file['snapshot_id'] / 'payload') as archive:
        with io.TextIOWrapper(archive.open(file['members'][0]['name']), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            for row in reader:
                yield reader.line_num, row, reader.fieldnames

selected = {}
for number, row, _ in records('plan-attributes'):
    if row['StateCode'] == 'TX' and row['MarketCoverage'] == 'Individual' and row['IssuerId'] in ['11718', '12846', '66252'] and row['IssuerId'] not in selected:
        selected[row['IssuerId']] = row
plans = {r['StandardComponentId'] for r in selected.values()}
variants = {r['PlanId'] for r in selected.values()}
areas = {(r['IssuerId'], r['ServiceAreaId'], r['MarketCoverage'], r['DentalOnlyPlan']) for r in selected.values()}
networks = {(r['IssuerId'], r['NetworkId'], r['MarketCoverage'], r['DentalOnlyPlan']) for r in selected.values()}
rate_groups = {}
benefit_counts = {}
provenance = {'plan_year': year, 'publisher': manifest['publisher'], 'source_manifest': manifest_path.name, 'synthetic': False, 'files': []}
for kind in kinds:
    cut = []
    source_rows = []
    other_state = False
    for number, row, headers in records(kind):
        include = False
        if row['StateCode'] != 'TX':
            if not other_state:
                include = True
                other_state = True
        elif kind == 'plan-attributes':
            include = row['PlanId'] in variants
        elif kind == 'service-area':
            include = (row['IssuerId'], row['ServiceAreaId'], row['MarketCoverage'], row['DentalOnlyPlan']) in areas
        elif kind == 'network':
            include = (row['IssuerId'], row['NetworkId'], row['MarketCoverage'], row['DentalOnlyPlan']) in networks
        elif kind == 'business-rules':
            include = row['StandardComponentId'] in plans
        elif kind == 'rate' and row['PlanId'] in plans:
            group = tuple(row[k] for k in ['RatingAreaId', 'Tobacco', 'RateEffectiveDate', 'RateExpirationDate'])
            rate_groups.setdefault(row['PlanId'], group)
            include = rate_groups[row['PlanId']] == group
        elif kind == 'benefits-and-cost-sharing' and row['PlanId'] in variants:
            n = benefit_counts.get(row['PlanId'], 0)
            include = n < 5
            benefit_counts[row['PlanId']] = n + 1
        if include:
            cut.append(row)
            source_rows.append(number)
    text = io.StringIO(newline='')
    writer = csv.DictWriter(text, fieldnames=headers, lineterminator='\n')
    writer.writeheader()
    writer.writerows(cut)
    data = text.getvalue().encode()
    if len(data) >= 200_000:
        raise ValueError('Fixture exceeds 200 KB: ' + kind)
    name = kind + '.csv'
    (output / name).write_bytes(data)
    provenance['files'].append({'kind': kind, 'file': name, 'url': files[kind]['url'], 'source_archive_sha256': files[kind]['sha256'],
                                'cut_sha256': hashlib.sha256(data).hexdigest(), 'source_physical_end_lines': source_rows, 'rows': len(cut)})
    print(name, len(cut), len(data))
(output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
