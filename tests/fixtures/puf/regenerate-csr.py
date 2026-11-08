#!/usr/bin/env python3
"""Unmodified TX 2026 silver variant cuts; immutable acquired archives only."""
import csv, hashlib, io, json, os, zipfile
from pathlib import Path
cache = Path(os.environ.get('OPENPLANS_DATA_DIR') or (Path.home() / '.local' / 'share' / 'openplans'))
root = cache / 'raw/cms-exchange-puf'
manifest_path = sorted(root.glob('manifest-*.json'))[-1]
manifest = json.loads(manifest_path.read_text())
files = {f['kind']: f for f in manifest['files'] if f['year'] == 2026}
output = Path(__file__).parent / 'csr'
output.mkdir(exist_ok=True)
base = '11718TX0140019'
provenance = {'synthetic': False, 'plan_year': 2026, 'base_plan_id': base, 'source_manifest': manifest_path.name, 'files': []}
selected = None
rate_group = None
for kind in ['plan-attributes', 'benefits-and-cost-sharing', 'service-area', 'network', 'business-rules', 'rate']:
    f = files[kind]
    path = root / f['snapshot_id'] / 'payload'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == f['sha256']
    rows, lines = [], []
    with zipfile.ZipFile(path) as archive:
        with io.TextIOWrapper(archive.open(f['members'][0]['name']), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            for row in reader:
                include = False
                if kind in ['plan-attributes', 'benefits-and-cost-sharing', 'business-rules']:
                    include = row['StandardComponentId'] == base
                elif kind in ['service-area', 'network']:
                    field = 'ServiceAreaId' if kind == 'service-area' else 'NetworkId'
                    include = all(row[k] == selected[k] for k in ['IssuerId', 'StateCode', 'MarketCoverage', 'DentalOnlyPlan', field])
                elif kind == 'rate' and row['PlanId'] == base:
                    group = tuple(row[k] for k in ['RatingAreaId', 'Tobacco', 'RateEffectiveDate', 'RateExpirationDate'])
                    if rate_group is None: rate_group = group
                    include = rate_group == group
                if include:
                    if kind == 'plan-attributes': selected = row
                    rows.append(row)
                    lines.append(reader.line_num)
            headers = reader.fieldnames
    data = io.StringIO(newline='')
    writer = csv.DictWriter(data, fieldnames=headers, lineterminator='\n')
    writer.writeheader(); writer.writerows(rows)
    value = data.getvalue().encode()
    assert 0 < len(rows) and len(value) < 200_000
    (output / (kind + '.csv')).write_bytes(value)
    provenance['files'].append({'kind': kind, 'url': f['url'], 'source_archive_sha256': f['sha256'],
      'cut_sha256': hashlib.sha256(value).hexdigest(), 'rows': len(rows), 'source_physical_end_lines': lines})
    print(kind, len(rows), len(value))
(output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
