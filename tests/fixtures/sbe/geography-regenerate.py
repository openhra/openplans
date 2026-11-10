#!/usr/bin/env python3
"""Regenerate fact-only geography cuts from already cached public sources."""
import csv, hashlib, io, json, os, pathlib, re, zipfile
cache = pathlib.Path(os.environ.get('OPENPLANS_DATA_DIR', str(pathlib.Path.home() / '.local/share/openplans')))
out = pathlib.Path(__file__).parent / 'geography'
out.mkdir(exist_ok=True)
def source(kind, url):
    entries = [json.loads(p.read_text()) for p in (cache / 'raw' / kind).glob('*.meta.json')]
    m = sorted((m for m in entries if m['url'] == url), key=lambda m: m['fetched_at'])[-1]
    p = cache / 'raw' / kind / m['sha256'] / 'payload'
    assert hashlib.sha256(p.read_bytes()).hexdigest() == m['sha256']
    return p, m
relpath, relmeta = source('census-zcta-county-2020', 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt')
centpath, centmeta = source('census-zcta-gazetteer-2021', 'https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2021_Gazetteer/2021_Gaz_zcta_national.zip')
with relpath.open() as f:
    reader = csv.DictReader(f, delimiter='|'); relheader = reader.fieldnames; relationships = list(reader)
with zipfile.ZipFile(centpath) as z:
    reader = csv.DictReader(io.TextIOWrapper(z.open('2021_Gaz_zcta_national.txt')), delimiter='\t'); centheader = reader.fieldnames; centers = list(reader)
provenance = {'description': 'Unmodified factual public rows; synthetic acquisition wrappers in tests describe the cut hashes. Original physical rows are recorded here.', 'states': {}}
for state, fips in [('CA', '06'), ('GA', '13'), ('IL', '17'), ('MA', '25'), ('NM', '35')]:
    p, m = source('cms-rating-areas', 'https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/' + state.lower() + '-gra')
    table = next(t for t in re.findall(r'<table\b[^>]*>.*?</table>', p.read_text(), re.I | re.S) if 'Rating Area ID' in t)
    area_prefixes = set(re.findall(r'\b\d{3}\b', table))
    chosen = {}
    for r in relationships:
        if r['GEOID_COUNTY_20'].startswith(fips) and r['GEOID_ZCTA5_20']:
            chosen.setdefault(r['GEOID_COUNTY_20'], r['GEOID_ZCTA5_20'])
    selected = set(chosen.values())
    if state == 'CA': selected.update(['90001', '90601', '90620'])
    elif state == 'MA':
        border = {}
        for r in relationships:
            zip = r['GEOID_ZCTA5_20']
            if r['GEOID_COUNTY_20'].startswith(fips) and zip and zip[:3] not in area_prefixes: border.setdefault(zip[:3], zip)
        selected.update(border.values())
    rel = [r for r in relationships if r['GEOID_ZCTA5_20'] in selected]
    cent = [r for r in centers if r['GEOID'] in selected]
    scope = {}
    for kind, name, rows, headers, delimiter, original in [('relationship', state.lower() + '-relationships.txt', rel, relheader, '|', relmeta), ('centroids', state.lower() + '-centroids.txt', cent, centheader, '\t', centmeta)]:
        with (out / name).open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=headers, delimiter=delimiter, lineterminator='\n', quoting=csv.QUOTE_ALL); writer.writeheader(); writer.writerows(rows)
        original_rows = relationships if kind == 'relationship' else centers
        scope[kind] = {'file': name, 'original': original, 'original_rows': [i+2 for i,r in enumerate(original_rows) if r in rows]}
    name = state.lower() + '-gra.html'; (out / name).write_text(table + '\n')
    scope['ratingAreas'] = {'file': name, 'original': m, 'cut': 'Only the complete factual rating-area table, no surrounding site content.'}
    for v in scope.values():
        b = (out / v['file']).read_bytes(); v['sha256'] = hashlib.sha256(b).hexdigest(); v['bytes'] = len(b)
        assert len(b) < 200_000
    provenance['states'][state] = scope
(out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
