#!/usr/bin/env python3
"""Regenerate a fact-only VT identity cut from the acquired public CMS bundle."""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get('OPENPLANS_DATA_DIR', Path.home() / '.local/share/openplans')))
args = parser.parse_args()
sha = 'a16f28e7d50ecf93c1d92335f116dd272cffbfc5c261088459bb866cc4aa6342'
member = 'VTPlans05052026.csv'
root = args.data_dir / 'raw/cms-sbe-puf'
metadata = json.loads((root / (sha + '.meta.json')).read_text())
raw = (root / sha / 'payload').read_bytes()
assert hashlib.sha256(raw).hexdigest() == sha
fields = {
    'BUSINESS YEAR': 'BusinessYear', 'STATE CODE': 'StateCode', 'ISSUER ID': 'IssuerId',
    'STANDARD COMPONENT ID': 'StandardComponentId', 'PLAN ID': 'PlanId',
    'MARKET COVERAGE': 'MarketCoverage', 'DENTAL ONLY PLAN': 'DentalOnlyPlan',
    'METAL LEVEL': 'MetalLevel', 'NETWORK ID': 'NetworkId', 'SERVICE AREA ID': 'ServiceAreaId',
    'PLAN MARKETING NAME': 'PlanMarketingName', 'ISSUER NAME': 'IssuerMarketPlaceMarketingName',
    'QHP NONQHP TYPE ID': 'QHPNonQHPTypeId',
}
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    reader = csv.DictReader(io.StringIO(archive.read(member).decode('utf-8-sig')))
    rows = []
    for row in reader:
        rows.append({'source_row': reader.line_num, 'values': {name: row[key] for key, name in fields.items()}})
fixture = {
    'kind': 'real-public-fact-cut', 'description': 'Identity fields only; all VT attribute rows, no invented plan facts.',
    'url': metadata['url'], 'sha256': sha, 'bytes': len(raw), 'retrieved_at': metadata['fetched_at'],
    'member': member, 'rows': rows,
}
out = Path(__file__).parent / 'fixtures/vt-hios-2026.json'
out.write_text(json.dumps(fixture, indent=2) + '\n')
print(str(out), len(rows), out.stat().st_size)
