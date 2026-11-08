#!/usr/bin/env python3
"""Cut real CMS TX PY2026 rows for captured Harris plan identifiers (no prices copied).

The optional oracle is read only through OPENPLANS_REFERENCE_CAPTURES_DIR. Once generated,
provenance.json retains the selection for regeneration without the oracle.
All archives come from OPENPLANS_DATA_DIR; this script never downloads anything.
"""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile

cache = Path(os.environ.get('OPENPLANS_DATA_DIR') or (Path.home() / '.local' / 'share' / 'openplans')) / 'raw/cms-exchange-puf'
manifest_path = sorted(cache.glob('manifest-*.json'))[-1]
manifest = json.loads(manifest_path.read_text())
output = Path(__file__).parent / 'fixtures'
output.mkdir(exist_ok=True)
oracle = os.environ.get('OPENPLANS_REFERENCE_CAPTURES_DIR')
if oracle:
    ids = {r['id'] for p in (Path(oracle) / 'plans/search/48201/individual').glob('*.json') for r in json.loads(p.read_text())['plans']}
else:
    ids = set(json.loads((output / 'provenance.json').read_text())['selected_public_plans'])
kinds = ['plan-attributes', 'service-area', 'network', 'business-rules', 'rate', 'benefits-and-cost-sharing']
files = {f['kind']: f for f in manifest['files'] if f['year'] == 2026 and f['kind'] in kinds}

def records(kind):
    f = files[kind]
    with zipfile.ZipFile(cache / f['snapshot_id'] / 'payload') as archive:
        with io.TextIOWrapper(archive.open(f['members'][0]['name']), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            for row in reader:
                yield reader.line_num, row, reader.fieldnames

selected = {}
for line, row, _ in records('plan-attributes'):
    plan = row['StandardComponentId']
    if row['StateCode'] == 'TX' and plan in ids and plan not in selected:
        selected[plan] = row
variants = {r['PlanId'] for r in selected.values()}
areas = {tuple(r[k] for k in ['IssuerId', 'ServiceAreaId', 'MarketCoverage', 'DentalOnlyPlan']) for r in selected.values()}
networks = {tuple(r[k] for k in ['IssuerId', 'NetworkId', 'MarketCoverage', 'DentalOnlyPlan']) for r in selected.values()}
provenance = {'publisher': manifest['publisher'], 'source_manifest': manifest_path.name, 'synthetic': False,
              'selection': 'One real variant, complete Rating Area 10 age-band rates and selected published benefits per public Harris capture plan',
              'selected_public_plans': sorted(selected), 'files': []}
for kind in kinds:
    cut, lines, benefits = [], [], {}
    for line, row, headers in records(kind):
        include = False
        if row['StateCode'] == 'TX':
            if kind == 'plan-attributes':
                include = row['PlanId'] in variants
            elif kind in ['service-area', 'network']:
                key = 'ServiceAreaId' if kind == 'service-area' else 'NetworkId'
                include = tuple(row[k] for k in ['IssuerId', key, 'MarketCoverage', 'DentalOnlyPlan']) in (areas if kind == 'service-area' else networks)
            elif kind == 'business-rules':
                include = row['StandardComponentId'] in selected
            elif kind == 'rate':
                include = row['PlanId'] in selected and row['RatingAreaId'] == 'Rating Area 10'
            elif kind == 'benefits-and-cost-sharing':
                plan = row['PlanId']
                include = plan in variants and row['BenefitName'] in {
                    'Primary Care Visit to Treat an Injury or Illness', 'Specialist Visit',
                    'Generic Drugs', 'Urgent Care Centers or Facilities', 'Chiropractic Care'}
                if include:
                    benefits[plan] = benefits.get(plan, 0) + 1
        if include:
            cut.append(row)
            lines.append(line)
    text = io.StringIO(newline='')
    writer = csv.DictWriter(text, fieldnames=headers, lineterminator='\n')
    writer.writeheader()
    writer.writerows(cut)
    data = text.getvalue().encode()
    assert cut, kind
    parts = []
    if len(data) < 200_000:
        (output / (kind + '.csv')).write_bytes(data)
    else:
        # Split only at CSV record boundaries; each committed cut stays small.
        for at in range(0, len(cut), 1000):
            part_text = io.StringIO(newline='')
            part_writer = csv.DictWriter(part_text, fieldnames=headers, lineterminator='\n')
            part_writer.writeheader()
            part_writer.writerows(cut[at:at + 1000])
            part_data = part_text.getvalue().encode()
            assert len(part_data) < 200_000, kind
            name = f'{kind}-{len(parts) + 1:03}.csv'
            (output / name).write_bytes(part_data)
            parts.append({'file': name, 'sha256': hashlib.sha256(part_data).hexdigest()})
        (output / (kind + '.csv')).unlink(missing_ok=True)
    provenance['files'].append({'kind': kind, 'url': files[kind]['url'], 'source_archive_sha256': files[kind]['sha256'],
                                'cut_sha256': hashlib.sha256(data).hexdigest(), 'parts': parts, 'source_physical_end_lines': lines, 'rows': len(cut)})
    print(kind, len(cut), len(data), flush=True)
(output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
