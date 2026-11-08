#!/usr/bin/env python3
"""Cut TX registry rows (first three columns ONLY) from P1a's real CMS snapshot.
No contact columns or contact shared strings are copied. Uses stdlib, no network.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile

cache = Path(os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans')))
out = Path(__file__).resolve().parent
manifest_path = sorted((cache / 'raw/cms-exchange-puf').glob('manifest-*.json'))[-1]
manifest = json.loads(manifest_path.read_text())
record, = [f for f in manifest['files'] if f['year'] == 2026 and f['kind'] == 'machine-readable-url']
archive = cache / 'raw/cms-exchange-puf' / record['snapshot_id'] / 'payload'
raw = archive.read_bytes()
assert hashlib.sha256(raw).hexdigest() == record['sha256']
with zipfile.ZipFile(io.BytesIO(raw)) as z:
    workbook = z.read('machine-readable-url-puf.xlsx')
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(io.BytesIO(workbook)) as z:
    strings = [''.join(item.itertext()) for item in ET.fromstring(z.read('xl/sharedStrings.xml'))]
    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    rows = []
    for row in sheet.findall('.//s:row', ns):
        values = {}
        for cell in row.findall('s:c', ns):
            column = ''.join(c for c in cell.attrib['r'] if c.isalpha())
            if column not in ('A', 'B', 'C'):
                continue
            value = cell.findtext('s:v', default='', namespaces=ns)
            values[column] = strings[int(value)] if cell.attrib.get('t') == 's' else value
        if not rows or values.get('A') == 'TX':
            rows.append([values.get(c, '') for c in ('A', 'B', 'C')])
# Normalize selected cells as inline strings. This is a real-data cut, not a fabricated registry.
root = ET.Element('worksheet', xmlns=ns['s'])
data = ET.SubElement(root, 'sheetData')
for number, values in enumerate(rows, 1):
    row = ET.SubElement(data, 'row', r=str(number))
    for col, value in zip('ABC', values):
        cell = ET.SubElement(row, 'c', r=f'{col}{number}', t='inlineStr')
        ET.SubElement(ET.SubElement(cell, 'is'), 't').text = value
entries = {
    'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="TX registry cut" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': ET.tostring(root, encoding='unicode'),
}
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as z:
    for name, body in entries.items():
        info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(info, body)
cut = buffer.getvalue()
(out / 'tx-2026-registry.xlsx.hex').write_text(cut.hex() + '\n')
(out / 'tx-2026-registry.provenance.json').write_text(json.dumps({
    'publisher': 'Centers for Medicare & Medicaid Services', 'url': record['url'],
    'source_archive_sha256': record['sha256'], 'source_workbook_sha256': hashlib.sha256(workbook).hexdigest(),
    'fixture_sha256': hashlib.sha256(cut).hexdigest(), 'year': 2026, 'state': 'TX',
    'issuer_rows': len(rows) - 1, 'columns': rows[0], 'omitted': 'all columns after URL Submitted',
    'regenerate': 'python3 tests/fixtures/qhp/regenerate.py',
}, indent=2) + '\n')
print(f'cut {len(rows)-1} TX rows; {len(cut)} bytes; no contact columns')
