#!/usr/bin/env python3
"""Cut public child-only offering evidence from the pinned CMS archive."""
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
digest = '954e697885efcb709aed0be1de14075afe11704bf3447372960d08c879950af2'
archive_path = args.data_dir / 'raw' / 'cms-puf' / digest / 'payload'
if not archive_path.exists():
    matches = list((args.data_dir / 'raw').glob(f'*/{digest}/payload'))
    assert len(matches) == 1
    archive_path = matches[0]
assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == digest
selected = set('23018TX0020005 23018TX0020006 24349TX0010001 33602TX0500003 33602TX0500004 40540TX0050003 40540TX0050004 40540TX0070003 40540TX0070004 58609TX0010001'.split())
rows = []
with zipfile.ZipFile(archive_path) as archive:
    members = [name for name in archive.namelist() if name.lower().endswith('.csv')]
    assert len(members) == 1
    member = members[0]
    with archive.open(member) as file:
        for line, row in enumerate(csv.DictReader(io.TextIOWrapper(file, encoding='utf-8-sig')), 2):
            if row['StandardComponentId'] in selected:
                rows.append({'source_row': line, 'values': row})
assert {row['values']['StandardComponentId'] for row in rows} == selected
assert all(row['values']['ChildOnlyOffering'] == 'Allows Child-Only' for row in rows)
result = {'kind': 'real-public-row-cut', 'sha256': digest,
          'url': 'https://download.cms.gov/marketplace-puf/2026/plan-attributes-puf.zip',
          'member': member, 'rows': rows}
path = Path(__file__).with_name('dental-offering-public.json')
path.write_text(json.dumps(result, indent=2) + '\n')
assert path.stat().st_size < 200_000
print(f'{path.name}: {path.stat().st_size} bytes')
