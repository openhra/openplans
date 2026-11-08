#!/usr/bin/env python3
"""Regenerate unmodified CMS PY2026 cuts for the age-35 premium oracle plan.

Reads only the shared acquired cache. One real variant, five real benefit rows,
and its complete Rating Area 10 age-band group. No downloads or invented data.
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
kinds = ['plan-attributes', 'service-area', 'network', 'business-rules', 'rate', 'benefits-and-cost-sharing']
files = {f['kind']: f for f in manifest['files'] if f['year'] == 2026 and f['kind'] in kinds}
output = Path(__file__).parent / 'fixtures'
output.mkdir(exist_ok=True)

def records(kind):
    file = files[kind]
    with zipfile.ZipFile(cache / file['snapshot_id'] / 'payload') as archive:
        with io.TextIOWrapper(archive.open(file['members'][0]['name']), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            for row in reader:
                yield reader.line_num, row, reader.fieldnames

plan = '87226TX0100013'
selected = next(r for _, r, _ in records('plan-attributes') if r['StandardComponentId'] == plan)
provenance = {'publisher': manifest['publisher'], 'source_manifest': manifest_path.name, 'synthetic': False, 'files': []}
for kind in kinds:
    cut, lines = [], []
    for line, row, headers in records(kind):
        include = False
        if row['StateCode'] == 'TX':
            if kind == 'plan-attributes':
                include = row['PlanId'] == selected['PlanId']
            elif kind in ['service-area', 'network']:
                key = 'ServiceAreaId' if kind == 'service-area' else 'NetworkId'
                include = all(row[k] == selected[k] for k in ['IssuerId', key, 'MarketCoverage', 'DentalOnlyPlan'])
            elif kind == 'business-rules':
                include = row['StandardComponentId'] == plan
            elif kind == 'rate':
                include = row['PlanId'] == plan and row['RatingAreaId'] == 'Rating Area 10'
            elif kind == 'benefits-and-cost-sharing':
                include = row['PlanId'] == selected['PlanId'] and len(cut) < 5
        if include:
            cut.append(row)
            lines.append(line)
    text = io.StringIO(newline='')
    writer = csv.DictWriter(text, fieldnames=headers, lineterminator='\n')
    writer.writeheader()
    writer.writerows(cut)
    data = text.getvalue().encode()
    assert cut and len(data) < 200_000, kind
    (output / (kind + '.csv')).write_bytes(data)
    provenance['files'].append({'kind': kind, 'url': files[kind]['url'], 'source_archive_sha256': files[kind]['sha256'],
                                'cut_sha256': hashlib.sha256(data).hexdigest(), 'source_physical_end_lines': lines, 'rows': len(cut)})
    print(kind, len(cut), len(data))
(output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
