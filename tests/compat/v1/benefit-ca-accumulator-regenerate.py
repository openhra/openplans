#!/usr/bin/env python3
"""Cut an unchanged CA Plan Attributes row from the pinned CMS publication."""
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
digest = '8a6d606a6da66b6d61296416d720f0d6b7a2766b398f52757f6ebe3600c52225'
archive_path = args.data_dir / 'raw' / 'cms-sbe-puf' / digest / 'payload'
assert hashlib.sha256(archive_path.read_bytes()).hexdigest() == digest
member = 'CAPlans05052026.csv'
rows = []
with zipfile.ZipFile(archive_path) as archive, archive.open(member) as file:
    for line, row in enumerate(csv.DictReader(io.TextIOWrapper(file, encoding='utf-8-sig')), 2):
        if row['PLAN ID'] == '70285CA1270001-01':
            rows.append({'source_row': line, 'values': row})
assert len(rows) == 1
result = {'kind': 'real-public-row-cut', 'sha256': digest,
          'url': 'https://www.cms.gov/files/zip/californiasbpuf2026.zip', 'member': member, 'rows': rows}
path = Path(__file__).with_name('benefit-ca-accumulator-public.json')
path.write_text(json.dumps(result, indent=2) + '\n')
assert path.stat().st_size < 200_000
print(f'{path.name}: {path.stat().st_size} bytes')
