#!/usr/bin/env python3
"""Regenerate observed CMS header contracts from cached archives only.
Use --year 2025 for the six-file PY2025 contract; the default compares PY2026 and PY2027.
MR URLs and crosswalks are audited but explicitly outside the six-file catalog import.
No data rows (including MR contact fields) are read into the artifact.
"""
import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--year', type=int, choices=[2025])
selected_year = parser.parse_args().year
kinds = ['plan-attributes', 'service-area', 'network', 'business-rules', 'rate', 'benefits-and-cost-sharing']

cache = Path(os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans')))
root = cache / 'raw/cms-exchange-puf'
manifest_path = sorted(root.glob('manifest-*.json'))[-1]
manifest = json.loads(manifest_path.read_text())
headers = {}
for file in manifest['files']:
    if file['year'] not in ([selected_year] if selected_year else [2026, 2027]) or file['status'] != 'ok':
        continue
    if selected_year and file['kind'] not in kinds:
        continue
    path = root / file['snapshot_id'] / 'payload'
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != file['sha256'] or path.stat().st_size != file['bytes']:
        raise ValueError('Archive hash mismatch')
    with zipfile.ZipFile(path) as archive:
        name = archive.namelist()[0]
        if name.endswith('.csv'):
            with io.TextIOWrapper(archive.open(name), encoding='utf-8-sig', newline='') as stream:
                columns = next(csv.reader(stream))
        else:
            ns = {'x': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            with zipfile.ZipFile(io.BytesIO(archive.read(name))) as xlsx:
                strings = [''.join(si.itertext()) for si in ET.fromstring(xlsx.read('xl/sharedStrings.xml')).findall('x:si', ns)]
                first = ET.fromstring(xlsx.read('xl/worksheets/sheet1.xml')).find('x:sheetData/x:row', ns)
                columns = [strings[int(c.find('x:v', ns).text)] for c in first]
    headers[file['year'], file['kind']] = {'columns': columns, 'sha256': file['sha256'], 'url': file['url']}
if selected_year:
    if set(kind for year, kind in headers) != set(kinds):
        raise ValueError('All six PY2025 archives are required')
    report = {'plan_year': selected_year, 'source_manifest': manifest_path.name,
              'files': {kind: headers[selected_year, kind] for kind in kinds}}
    output = Path(__file__).resolve().parents[3] / 'tests/fixtures/puf/headers-2025.json'
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(output)
    raise SystemExit(0)
report = {'source_manifest': manifest_path.name, 'generated_on': '2026-11-07', 'files': {}}
for kind in sorted({k for y, k in headers}):
    old, new = headers[2026, kind], headers[2027, kind]
    report['files'][kind] = {'2026': old, '2027': new,
        'added': sorted(set(new['columns']) - set(old['columns'])), 'removed': sorted(set(old['columns']) - set(new['columns'])),
        'handling': 'raw plan_attribute JSON; required in PY2027' if kind == 'plan-attributes' else
                    'not a catalog import; year-suffixed crosswalk columns deliberately excluded' if kind == 'plan-id-crosswalk' else
                    'not a catalog import; MR URL ingestion owns this XLSX' if kind == 'machine-readable-url' else 'unchanged catalog schema'}
output = Path(__file__).resolve().parents[3] / 'tests/fixtures/puf/headers-2026-2027.json'
output.write_text(json.dumps(report, indent=2) + '\n')
print(output)
