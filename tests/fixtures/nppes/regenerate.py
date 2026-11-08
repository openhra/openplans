#!/usr/bin/env python3
"""Cut only public NPPES fields from hash-verified cached V2 artifacts; no network/dependencies.
Run after acquiring the monthly and deactivation ZIPs with src/ingest/nppes/acquire.ts.
"""
import csv
import hashlib
import io
import json
import os
import re
from xml.sax.saxutils import escape
from collections import Counter
from pathlib import Path
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans')))
cache = DATA / 'raw/cms-nppes'
metas = [json.loads(p.read_text()) for p in sorted(cache.glob('*.meta.json'))]
monthly = next(m for m in metas if '_Weekly_' not in m['url'] and 'Data_Dissemination_' in m['url'] and m['url'].endswith('_V2.zip'))
deact_meta = next(m for m in metas if 'Deactivated_NPI_Report_' in m['url'] and m['url'].endswith('_V2.zip'))
def archive(meta):
    path = cache / meta['snapshot_id'] / 'payload'
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''): h.update(chunk)
    assert h.hexdigest() == meta['sha256']
    return zipfile.ZipFile(path)
z = archive(monthly)
dz = archive(deact_meta)
x = zipfile.ZipFile(io.BytesIO(dz.read(dz.namelist()[0])))
ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
strings = [''.join(e.itertext()) for e in ET.fromstring(x.read('xl/sharedStrings.xml'))]
deactivations = {}
for event, elem in ET.iterparse(x.open('xl/worksheets/sheet1.xml'), events=('end',)):
    if elem.tag != ns + 'row': continue
    values = []
    for cell in elem:
        v = cell.find(ns + 'v')
        values.append(strings[int(v.text)] if cell.attrib.get('t') == 's' else (v.text if v is not None else ''))
    if len(values) == 2 and values[0].isdigit(): deactivations[values[0]] = values[1]
    elem.clear()
main = next(n for n in z.namelist() if n.startswith('npidata_') and 'fileheader' not in n.lower())
secondary = next(n for n in z.namelist() if n.startswith('pl_') and 'fileheader' not in n.lower())
def reader(name): return csv.DictReader(io.TextIOWrapper(z.open(name), encoding='utf-8-sig', newline=''))
counts = Counter(); tx_secondary = set(); secondary_rows = 0
for r in reader(secondary):
    npi = r['NPI']; counts[npi] += 1; secondary_rows += 1
    if r['Provider Secondary Practice Location Address - State Name'] == 'TX': tx_secondary.add(npi)
multi_candidates = {n for n in tx_secondary if counts[n] == 2}
selected = {}; labels = {}; total = kept = primary_tx = secondary_only = 0
expected_addresses = expected_taxonomies = expected_secondary = incomplete_primary = 0
all_deactivated = []; deactivation_only = None
rdr = reader(main); header = rdr.fieldnames
for r in rdr:
    total += 1; npi = r['NPI']
    tx = r['Provider Business Practice Location Address State Name'] == 'TX'
    keep = tx or npi in tx_secondary
    if tx: primary_tx += 1
    if keep:
        kept += 1
        expected_secondary += counts[npi]
        for kind in ('Mailing', 'Practice Location'):
            values = [r[f'Provider First Line Business {kind} Address'], r[f'Provider Second Line Business {kind} Address'],
                      r[f'Provider Business {kind} Address City Name'], r[f'Provider Business {kind} Address State Name'],
                      r[f'Provider Business {kind} Address Postal Code'], r[f'Provider Business {kind} Address Country Code (If outside U.S.)'],
                      r[f'Provider Business {kind} Address Telephone Number']]
            if any(values): expected_addresses += 1
            if any(values) and not any(values[i] for i in (0, 2, 4)): incomplete_primary += 1
        expected_taxonomies += sum(bool(r[f'Healthcare Provider Taxonomy Code_{i}']) for i in range(1, 16))
        if not tx: secondary_only += 1
    role = None
    if keep and r['Entity Type Code'] == '1' and 'individual' not in labels: role = 'individual'
    if keep and r['Entity Type Code'] == '2' and 'organization' not in labels: role = 'organization'
    if keep and npi in multi_candidates and 'three_practices' not in labels: role = 'three_practices'
    if keep and not tx and 'secondary_tx_only' not in labels: role = 'secondary_tx_only'
    if keep and npi in deactivations and not r['NPI Reactivation Date']:
        all_deactivated.append(npi)
        if 'deactivated' not in labels: role = 'deactivated'
    if not keep and r['Entity Type Code'] and 'out_of_state' not in labels: role = 'out_of_state'
    # Monthly file publishes redacted deactivated identities too; preserve one exact row as evidence.
    if npi in deactivations and not r['Entity Type Code'] and deactivation_only is None:
        deactivation_only = r
    if role:
        selected[npi] = r; labels[role] = npi
    if total % 2_000_000 == 0: print('scanned', total, 'kept', kept, flush=True)
if 'deactivated' not in labels and deactivation_only:
    npi = deactivation_only['NPI']; selected[npi] = deactivation_only; labels['redacted_deactivated'] = npi
with (ROOT / 'providers-v2.csv').open('w', newline='') as f:
    w = csv.DictWriter(f, header, quoting=csv.QUOTE_ALL, lineterminator='\n'); w.writeheader(); w.writerows(selected.values())
with (ROOT / 'practice-locations.csv').open('w', newline='') as f:
    rdr = reader(secondary); w = csv.DictWriter(f, rdr.fieldnames, quoting=csv.QUOTE_ALL, lineterminator='\n'); w.writeheader()
    for r in rdr:
        if r['NPI'] in selected: w.writerow(r)
with (ROOT / 'deactivations.csv').open('w', newline='') as f:
    w = csv.writer(f, quoting=csv.QUOTE_ALL, lineterminator='\n'); w.writerow(['NPI', 'NPPES Deactivation Date'])
    for npi in selected:
        if npi in deactivations: w.writerow([npi, deactivations[npi]])
manifest = {'source': monthly['url'], 'sha256': monthly['sha256'], 'deactivation_source': deact_meta['url'],
            'deactivation_sha256': deact_meta['sha256'], 'data_date': '-'.join(re.search(r'-(\d{4})(\d{2})(\d{2})\.csv$', main).groups()), 'labels': labels,
            'rule': 'Keep if primary or ANY secondary practice location is TX; mailing state does not qualify.',
            'redacted_deactivated': 'Keep a redacted NPI only if a published secondary practice establishes TX; identity fields remain null. Preserve previously observed identities on status-only updates.',
            'fields': 'Exact published columns and values only; endpoint file and contact-email fields excluded.'}
# Synthetic ZIP/OOXML containers around exact real cuts, to exercise production archive readers offline.
# Empty PDF is a filename marker only; it is explicitly synthetic, never claimed as source documentation.
def bundle(entries):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as target:
        for name, value in entries.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 2, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
            target.writestr(info, value)
    return out.getvalue()
synthetic = bundle({main: (ROOT / 'providers-v2.csv').read_bytes(), secondary: (ROOT / 'practice-locations.csv').read_bytes(),
                    'NPPES_Data_Dissemination_Readme_v.2.pdf': b''})
(ROOT / 'synthetic-bundle-v2.zip.hex').write_text(synthetic.hex() + '\n')
records = list(csv.reader((ROOT / 'deactivations.csv').open()))
worksheet = '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
for i, record in enumerate(records, 1):
    worksheet += f'<row r="{i}">' + ''.join(f'<c r="{chr(65+j)}{i}" t="inlineStr"><is><t>{escape(value)}</t></is></c>' for j, value in enumerate(record)) + '</row>'
worksheet += '</sheetData></worksheet>'
workbook = bundle({'xl/workbook.xml': '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': worksheet})
(ROOT / 'synthetic-deactivation-v2.zip.hex').write_text(bundle({'NPPES Deactivated NPI Report 20261102.xlsx': workbook}).hex() + '\n')
manifest['containers'] = 'synthetic ZIP/OOXML containers around exact real CSV cuts; empty PDF is only a V2 filename marker'
(ROOT / 'provenance.json').write_text(json.dumps(manifest, indent=2) + '\n')
report = {'main_rows': total, 'secondary_rows': secondary_rows, 'primary_tx': primary_tx,
          'tx_any_practice': kept, 'secondary_tx_only': secondary_only, 'tx_secondary_npis': len(tx_secondary),
          'tx_npis_in_deactivation_report_without_reactivation': len(all_deactivated), 'fixture_labels': labels,
          'expected_addresses': expected_addresses + expected_secondary, 'expected_secondary_addresses': expected_secondary,
          'expected_taxonomies': expected_taxonomies, 'incomplete_primary_or_mailing_addresses': incomplete_primary}
(DATA / 'reports/p3a-nppes-raw-counts.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report), flush=True)
for path in ROOT.glob('*.csv'): assert path.stat().st_size < 200_000
