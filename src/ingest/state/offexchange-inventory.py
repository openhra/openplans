#!/usr/bin/env python3
"""Inventory the cached VT SBE bundle; no downloads or inferred plan identities."""
import argparse
from collections import Counter
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

SHA = 'a16f28e7d50ecf93c1d92335f116dd272cffbfc5c261088459bb866cc4aa6342'


def inventory(attributes, rates, filed):
    """Retain physical rows and literal source cells, including missing prices."""
    groups = {}
    for source_row, row in attributes:
        groups.setdefault(row['STANDARD COMPONENT ID'], []).append((source_row, row))
    result = []
    price_columns = ['INDIVIDUAL RATE', 'COUPLE', 'PRIMARY SUBSCRIBER AND ONE DEPENDENT',
                     'PRIMARY SUBSCRIBER AND TWO DEPENDENTS',
                     'PRIMARY SUBSCRIBER AND THREE OR MORE DEPENDENTS',
                     'COUPLE AND ONE DEPENDENT', 'COUPLE AND TWO DEPENDENTS',
                     'COUPLE AND THREE OR MORE DEPENDENTS']
    for hios, rows in sorted(groups.items()):
        facts = {key: sorted({row[key] for _, row in rows}) for key in
                 ['MARKET COVERAGE', 'DENTAL ONLY PLAN', 'QHP NONQHP TYPE ID',
                  'METAL LEVEL', 'PLAN MARKETING NAME']}
        prices = [{'source_row': line, 'effective': row['RATE EFFECTIVE DATE'],
                   'expiration': row['RATE EXPIRATION'], 'age': row['AGE'],
                   'rating_area': row['RATING AREA ID'],
                   'cells': {key: row[key] for key in price_columns}}
                  for line, row in rates if row['PLAN ID'] == hios]
        # A rate row is not a price when all its price cells are empty.
        has_price = any(cell.strip() for rate in prices for cell in rate['cells'].values())
        result.append({'hios_id': hios, 'market': facts['MARKET COVERAGE'],
                       'dental_only': facts['DENTAL ONLY PLAN'],
                       'exchange': facts['QHP NONQHP TYPE ID'],
                       'metal': facts['METAL LEVEL'], 'names': facts['PLAN MARKETING NAME'],
                       'attribute_rows': [line for line, _ in rows],
                       'filed_plan_keys': sorted(r['plan_key'] for r in filed if r['hios_id'] == hios),
                       'puf_rate_status': 'available' if has_price else 'unknown',
                       'puf_rate_reason': None if has_price else 'NO_PUBLIC_RATE_IN_REVIEWED_SOURCES',
                       'puf_rate_rows': prices})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(os.environ.get(
        'OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans'))))
    args = parser.parse_args()
    data = args.data_dir.resolve()
    root = data / 'raw/cms-sbe-puf'
    archive_path = root / SHA / 'payload'
    archive = archive_path.read_bytes()
    assert hashlib.sha256(archive).hexdigest() == SHA, 'Cached archive hash mismatch'
    meta = json.loads((root / (SHA + '.meta.json')).read_text())
    prepared = data / 'derived/state-rating/vt-2026.json'
    artifact = json.loads(prepared.read_text())
    for source in artifact['sources']:
        assert hashlib.sha256(Path(source['raw_path']).read_bytes()).hexdigest() == source['sha256']
    oracle = subprocess.run([sys.executable, str(Path(__file__).with_name('hios-oracle.py')),
                             str(prepared), str(archive_path), SHA],
                            capture_output=True, text=True, check=True)
    filed = json.loads(oracle.stdout)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        def read(kind):
            member, = [name for name in bundle.namelist() if re.fullmatch(r'VT' + kind + r'\d+\.csv', name)]
            reader = csv.DictReader(io.StringIO(bundle.read(member).decode('utf-8-sig')))
            return member, [(reader.line_num, row) for row in reader]
        attribute_member, attributes = read('Plans')
        rate_member, rates = read('Rates')
    plans = inventory(attributes, rates, filed)
    medical = [p for p in plans if p['market'] == ['Individual'] and p['dental_only'] == ['No']]
    exclusive = [p for p in medical if p['exchange'] == ['Off the Exchange']]
    counts = {'base_plans': len(plans), 'attribute_rows': len(attributes), 'rate_rows': len(rates),
              'individual_medical': len(medical), 'individual_medical_off_exchange_only': len(exclusive),
              'individual_medical_with_filed_rate': sum(bool(p['filed_plan_keys']) for p in medical),
              'individual_medical_with_puf_rate': sum(p['puf_rate_status'] == 'available' for p in medical)}
    assert counts == {'base_plans': 55, 'attribute_rows': 131, 'rate_rows': 55,
                      'individual_medical': 28, 'individual_medical_off_exchange_only': 0,
                      'individual_medical_with_filed_rate': 26, 'individual_medical_with_puf_rate': 28}
    report = {'status': 'DATA_GAP', 'source_url': meta['url'], 'sha256': SHA,
              'attribute_member': attribute_member, 'rate_member': rate_member,
              'counts': counts, 'plans': plans,
              'row_exchange_counts': dict(Counter(r['QHP NONQHP TYPE ID'] for _, r in attributes))}
    header = ('# P8g — Vermont off-exchange inventory\n\n'
              'Status: DATA_GAP. The cached CMS bundle does not contain the eight missing '
              'off-exchange-only Silver base identities. No such identities or premiums were invented.\n\n'
              f"Source: {meta['url']}\n\nSHA-256: `{SHA}`. Members: `{attribute_member}`, `{rate_member}`. "
              'Original archive and filed PDF hashes verified; cache-only, no network downloads.\n\n'
              '55 base plans / 131 attribute rows / 55 rate rows. All 28 individual medical base plans '
              'are marked Both. Twenty-six match the existing filed sheet; the two additional base plans '
              'are catastrophic (13627VT0340001 and 77566VT0040013), outside this off-exchange Silver task. '
              'All 55 base plans have public PUF rate cells. Rate evidence is separate from pricing authorization: '
              'VT never uses federal age math. Existing 26 filed-tier premiums keep their original source.\n\n'
              'The PUF cannot establish identities, prices, or offering flags for eight plans absent from it. '
              'An unlisted identity remains unknown in this inventory; absence here is not proof of market absence. '
              'The generic missing-rate branch is tested with a labelled synthetic removal; there is no real '
              'no-rate plan in this bundle. The JSON companion retains every physical attribute/rate row and price cell.\n\n'
              '| HIOS base ID | Market | Dental | Exchange | Metal | Filed rate | PUF rate | Name |\n'
              '| --- | --- | --- | --- | --- | --- | --- | --- |\n')
    def safe(value):
        return ', '.join(value).replace('|', '\\|')
    table = '\n'.join(f"| {p['hios_id']} | {safe(p['market'])} | {safe(p['dental_only'])} | "
                      f"{safe(p['exchange'])} | {safe(p['metal'])} | "
                      f"{'yes' if p['filed_plan_keys'] else 'not in main sheet'} | {p['puf_rate_status']} | {safe(p['names'])} |"
                      for p in plans)
    footer = ('\n\nImplementation: uniquely HIOS-matched filed plans now expose the CMS on/off-exchange '
              'flags with snapshot and physical-row provenance through the existing native and compatibility '
              'repositories. No compatibility files or exchange filters were changed. The native plan search '
              'has no on-exchange-only parameter; compatibility also has no explicit on-exchange-only filter '
              'at this revision. Adding one would need coordination with the compatibility lane.\n\n'
              'Incomplete: eight new off-exchange Silver catalog entries, their HTTP unknown-rate behavior, '
              'and on-exchange-only exclusion cannot be demonstrated against these sources. '
              'A public attribute source identifying those eight plans is required before adding them.\n\n'
              'Reproduce from openplans/: `python3 src/ingest/state/offexchange-inventory.py --data-dir /absolute/cache`. '
              'After `npm run build`, run `node src/ingest/state/offexchangecheck.mjs /absolute/cache` '
              'for isolated PGlite + loopback TCP HTTP checks; results are in `reports/p8g-vt-http.json`. '
              'This report does not claim a production Postgres run.\n')
    destination = data / 'reports'
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'p8g-vt-offexchange.json').write_text(json.dumps(report, indent=2) + '\n')
    (destination / 'p8g-vt-offexchange.md').write_text(header + table + footer)
    print('DATA_GAP: 55 VT base plans inventoried; 0 off-exchange-only medical plans; 26 filed matches')


if __name__ == '__main__':
    main()
