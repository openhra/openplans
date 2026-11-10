#!/usr/bin/env python3
"""Offline, unmodified cut of the newest acquired CMS PY2026 Plan ID Crosswalk PUF.

Keeps the first three county rows of every prior-to-successor pair whose successor is a
plan in ../import (the TX catalog cut), one row without a successor, and one row of
another state. Physical CSV line numbers and the archive SHA-256 go to provenance.json.
"""
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
file = next(f for f in manifest['files'] if f['year'] == 2026 and f['kind'] == 'plan-id-crosswalk')
here = Path(__file__).parent
with open(here.parent / 'import' / 'plan-attributes.csv', newline='') as stream:
    successors = {row['StandardComponentId'] for row in csv.DictReader(stream) if row['StateCode'] == 'TX'}

kept, lines, pairs = [], [], {}
no_successor = other_state = False
with zipfile.ZipFile(root / file['snapshot_id'] / 'payload') as archive:
    with io.TextIOWrapper(archive.open(file['members'][0]['name']), encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        header = reader.fieldnames
        for row in reader:
            pair = (row['PlanID_2025'], row['PlanID_2026'])
            keep = False
            if row['PlanID_2026'] in successors and pairs.get(pair, 0) < 3:
                pairs[pair] = pairs.get(pair, 0) + 1
                keep = True
            elif row['PlanID_2026'] == '00000XX0000000' and not no_successor:
                no_successor = keep = True
            elif row['State'] == 'AK' and not other_state:
                other_state = keep = True
            if keep:
                kept.append(row)
                lines.append(reader.line_num)

out = io.StringIO()
writer = csv.DictWriter(out, fieldnames=header, lineterminator='\n')
writer.writeheader()
writer.writerows(kept)
data = out.getvalue().encode()
(here / 'plan-id-crosswalk.csv').write_bytes(data)
(here / 'provenance.json').write_text(json.dumps({
    'publisher': 'Centers for Medicare & Medicaid Services',
    'source_manifest': manifest_path.name,
    'synthetic': False,
    'url': file['url'],
    'source_archive_sha256': file['sha256'],
    'cut_sha256': hashlib.sha256(data).hexdigest(),
    'source_physical_end_lines': lines,
    'rows': len(kept),
    'pairs': sorted(f'{a}->{b}' for a, b in pairs),
}, indent=2) + '\n')
