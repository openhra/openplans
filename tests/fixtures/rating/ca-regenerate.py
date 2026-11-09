#!/usr/bin/env python3
"""Regenerate public CA PY2026 rating cuts from pinned cached publications."""
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

CACHE = Path(os.environ['OPENPLANS_DATA_DIR'])
OUT = Path(__file__).with_name('ca-2026')
ARCHIVE_HASH = '8a6d606a6da66b6d61296416d720f0d6b7a2766b398f52757f6ebe3600c52225'
RULE_HASH = 'b9605306aab2fda5f626295d89ed9d0f3803b3ff4627300c0907efa974b84122'
GEO_HASH = 'e7332722aa6904f5993dd42951d3236e8ef85a29883de37dc8b41d9b9cb68800'
FULL_HASH = '863554201284af38fb70c70c8be49b3f6cf3f11257d3a6f3576866e1246f1263'
NET_HASH = '33dc05b7710daa30cb9157769e91ced0e58f71b24a8245a9640e58023c40245a'
PLANS = {'18126CA0010001', '27603CA1500005', '70285CA1250001'}
RATE_ROWS = {130, 283, 4567, 55847, 55866, 55868}
RATE_GROUPS = {
    ('18126CA0010001', 'Rating Area 16'),
    ('18126CA0010001', 'Rating Area 19'),
    ('27603CA1500005', 'Rating Area 7'),
    ('70285CA1250001', 'Rating Area 7'),
}


def selected_rate(row):
    return (
        (row['PLAN ID'], row['RATING AREA ID']) in RATE_GROUPS
        and row['RATE EFFECTIVE DATE'] == '2026-01-01'
        and row['RATE EXPIRATION'] == '2026-12-31'
    )


def payload(kind, digest):
    p = CACHE / 'raw' / kind / digest / 'payload'
    assert hashlib.sha256(p.read_bytes()).hexdigest() == digest
    return p


def write_json(name, value):
    data = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
    assert len(data) < 200_000
    (OUT / name).write_bytes(data)


def cells(path, sheet, coordinates):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            shared = [
                ''.join(n.itertext())
                for n in ET.fromstring(z.read('xl/sharedStrings.xml'))
            ]
        root = ET.fromstring(z.read(sheet))
        out = {}
        for c in root.findall('.//s:c', ns):
            if c.attrib['r'] not in coordinates:
                continue
            v = c.find('s:v', ns)
            if v is not None:
                out[c.attrib['r']] = shared[int(v.text)] if c.attrib.get('t') == 's' else v.text
        assert set(out) == set(coordinates)
        return out


OUT.mkdir(exist_ok=True)
source = payload('cms-sbe-puf', ARCHIVE_HASH)
manifest = {'url': 'https://www.cms.gov/files/zip/californiasbpuf2026.zip',
            'sourceSha256': ARCHIVE_HASH, 'files': []}
with zipfile.ZipFile(source) as z:
    data = {}
    headers = {}
    for name in z.namelist():
        reader = csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8-sig'))
        headers[name] = reader.fieldnames
        data[name] = list(reader)
    selected = [r for r in data['CAPlans05052026.csv'] if r['STANDARD COMPONENT ID'] in PLANS]
    issuers = {r['ISSUER ID'] for r in selected}
    for name, rows in data.items():
        if 'Plans' in name:
            keep = lambda r, n: r['STANDARD COMPONENT ID'] in PLANS
        elif 'Rates' in name:
            keep = lambda r, n: selected_rate(r)
        elif 'Benefits' in name:
            # One original row per variant exercises linkage without a large benefits cut.
            first_variant_rows = {}
            for number, record in enumerate(rows, 2):
                if record['STANDARD COMPONENT ID'] in PLANS:
                    first_variant_rows.setdefault(record['PLAN ID'], number)
            keep = lambda r, n: n in first_variant_rows.values()
        elif 'BusinessRules' in name:
            keep = lambda r, n: r['ISSUER ID'] in issuers
        else:
            key = 'NETWORK ID' if 'Networks' in name else 'SERVICE AREA ID'
            keys = {(r['ISSUER ID'], r[key]) for r in selected}
            keep = lambda r, n: (r['ISSUER ID'], r[key]) in keys
        cut = [(n, r) for n, r in enumerate(rows, 2) if keep(r, n)]
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=headers[name], lineterminator='\n', quoting=csv.QUOTE_ALL)
        writer.writeheader()
        writer.writerows(r for _, r in cut)
        b = output.getvalue().encode()
        assert len(b) < 200_000, (name, len(b))
        (OUT / name).write_bytes(b)
        manifest['files'].append({'member': name, 'sourceRows': [n for n, _ in cut], 'cutSha256': hashlib.sha256(b).hexdigest()})
        if 'Rates' in name:
            assert len(cut) == 204
            cut = [(n, r) for n, r in cut if n in RATE_ROWS]
            assert {n for n, _ in cut} == RATE_ROWS
            write_json('rates.json', {'sourceSha256': ARCHIVE_HASH, 'sourceFile': name,
                                     'rows': [{'sourceRowNumber': n, 'raw': r} for n, r in cut]})
write_json('provenance.json', manifest)
rule = payload('prem0-public', RULE_HASH).read_text()
start = rule.index('<td>California</td>')
row = rule[rule.rfind('<tr>', 0, start):rule.index('</tr>', start) + 5]
assert row.count('<td>1:1</td>') == 2
write_json('tobacco-rule.json', {'sourceSha256': RULE_HASH, 'url': 'https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-rating', 'rowHtml': row})
geo = payload('prem0-public', GEO_HASH)
coordinates = [f'{c}{n}' for n in [1881, 2624, 956] for c in 'BCDE']
# Preserve the original Pivot worksheet cells.
write_json('geography.json', {'sourceSha256': GEO_HASH, 'url': 'https://hbex.coveredca.com/financial-reports/2026%20Products%20by%20Zip%20Code%207-30-25.xlsx', 'sheet': 'Pivot', 'cells': cells(geo, 'xl/worksheets/sheet2.xml', coordinates)})
coordinates = [f'{c}{n}' for n in [11305, 16915, 24361, 24743, 24762, 24764] for c in 'ABCD']
for name, digest, url in [('full', FULL_HASH, 'https://www.coveredca.com/pdfs/2026%20QHP%20Individual%20Product%20Prices.xlsx'), ('without-non-ehb', NET_HASH, 'https://hbex.coveredca.com/financial-reports/2026%20QHP%20Individual%20Rates%20Without%20Non-EHB.xlsx')]:
    write_json(name + '.json', {'sourceSha256': digest, 'url': url, 'sheet': '2026 QHP Individual Rates', 'cells': cells(payload('prem0-public', digest), 'xl/worksheets/sheet1.xml', coordinates)})
print('CA fixture: 204 import rows, 6 focused rate rows; pinned rule, gross and geography cells; PASS')
