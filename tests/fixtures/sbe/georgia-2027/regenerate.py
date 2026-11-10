#!/usr/bin/env python3
"""Cut real Georgia Access PY2027 rows from the admitted cache, byte for byte.

Lines are copied verbatim (trailing commas and the publisher's unescaped quotes kept),
so the cut reproduces what the importer reads. No downloads; nothing invented.
"""
import csv, hashlib, json, os, pathlib
cache = pathlib.Path(os.environ.get('OPENPLANS_DATA_DIR', str(pathlib.Path.home() / '.local/share/openplans'))) / 'raw/georgia-access-puf'
out = pathlib.Path(__file__).parent
# One Ambetter medical base whose benefits include unescaped quotes, one dental base.
chosen = ['58081GA0010005', '13535GA0140001']
files = {
    'plan-attributes': '5160028a1f62a45005bb8ec170e86afaaad9577f89c4f213aaab3dc3a7456e6d',
    'service-area': 'f07312e1191dbd7b6d780690b1f61dd3ed25213835cf3a5277e149bfc2ce661e',
    'network': '48a366f3d6307058b6328b4c309dfd52f53a0967892b6cbf2fbaf243e3eae721',
    'business-rules': '1c172842c10d239bfa8030a7aae855af1119d2a7f04ffd9dabdc24079f5234a8',
    'rate': '7414bdf18d4d6a30ee9d4dcbc56a7b426814f1d57cfe06a623779df6ba9b9c9c',
    'benefits-and-cost-sharing': 'c5888113c30420afc99a8910032eb1d5c24dc0cc87278741eaffbc6c6920d266',
}
def records(path):
    """Yield (row dict, raw text) using Python's lenient reader to find record spans."""
    text = path.read_text(encoding='utf-8')
    lines = text.split('\n')
    reader = csv.reader(lines)
    header = next(reader); start = 1
    for row in reader:
        end = reader.line_num
        if not row: start = end; continue
        if len(row) == len(header) + 1 and row[-1] == '': row = row[:-1]
        yield header, dict(zip(header, row)), '\n'.join(lines[start:end])
        start = end
provenance = {'source': 'georgia_access_puf', 'plans': chosen, 'files': []}
plans = [r for _, r, _ in records(cache / files['plan-attributes'] / 'payload') if r['StandardComponentId'] in chosen]
issuers = {r['IssuerId'] for r in plans}
areas = {}
for kind, sha in files.items():
    payload = cache / sha / 'payload'
    assert hashlib.sha256(payload.read_bytes()).hexdigest() == sha
    meta = json.loads((cache / f'{sha}.meta.json').read_text())
    header_line = payload.read_text(encoding='utf-8').split('\n', 1)[0]
    kept, rows = [], []
    for header, r, raw in records(payload):
        if kind in ('plan-attributes', 'benefits-and-cost-sharing'): keep = r['StandardComponentId'] in chosen
        elif kind == 'business-rules': keep = r['StandardComponentId'] in chosen
        elif kind == 'rate':
            keep = r['PlanId'] in chosen and areas.setdefault(r['PlanId'], r['RatingAreaId']) == r['RatingAreaId']
        else:
            field = 'NetworkId' if kind == 'network' else 'ServiceAreaId'
            keep = (r['IssuerId'], r[field]) in {(p['IssuerId'], p[field]) for p in plans}
        if keep: kept.append(raw); rows.append(r)
    name = meta['url'].rsplit('/', 1)[1]
    (out / name).write_text(header_line + '\n' + '\n'.join(kept) + '\n', encoding='utf-8')
    assert (out / name).stat().st_size < 200_000
    provenance['files'].append({'kind': kind, 'name': name, 'url': meta['url'], 'sha256': sha, 'rows': len(kept)})
(out / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
