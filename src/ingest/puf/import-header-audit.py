#!/usr/bin/env python3
"""Regenerate the observed PY2026→2027 header contract from cached archives only.
MR URLs and crosswalks are audited but explicitly outside the six-file catalog import.
No data rows (including MR contact fields) are read into the artifact.
"""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

cache = Path(os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans')))
root = cache / 'raw/cms-exchange-puf'
manifest_path = sorted(root.glob('manifest-*.json'))[-1]
manifest = json.loads(manifest_path.read_text())
headers = {}
for file in manifest['files']:
    if file['year'] not in [2026, 2027] or file['status'] != 'ok':
        continue
    path = root / file['snapshot_id'] / 'payload'
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != file['sha256']:
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
