#!/usr/bin/env python3
"""Cut unchanged Census rows for state API tests from the shared, pinned cache."""
import csv
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans')))
digest = '3ed41278d637dc249e0323306f68be8a6c234e3090f4de88ef328dee71aeaaaf'
directory = root / 'raw/census-zcta-county-2020' / digest
source = next(p for p in directory.iterdir() if p.is_file() and p.name != 'meta.json')
body = source.read_bytes()
assert hashlib.sha256(body).hexdigest() == digest
rows = []
ny_counties = {}
for line, row in enumerate(csv.DictReader(body.decode().splitlines(), delimiter='|'), 2):
    if row['GEOID_COUNTY_20'].startswith('36'):
        ny_counties[row['GEOID_COUNTY_20']] = row['NAMELSAD_COUNTY_20'].removesuffix(' County')
    if row['GEOID_ZCTA5_20'] in ['10001', '05401', '05602']:
        rows.append(dict(source_row=line, values=row))
assert {r['values']['GEOID_ZCTA5_20'] for r in rows} == {'10001', '05401', '05602'}
output = dict(source_url='https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt',
              source_sha256=digest, ny_counties=ny_counties, rows=rows)
Path(__file__).with_name('state-geography.json').write_text(json.dumps(output, indent=2)+'\n')
