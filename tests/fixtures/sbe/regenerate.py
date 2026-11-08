#!/usr/bin/env python3
"""Cut real GA rows from the verified CMS bundle. No downloads; no invented prices."""
import csv, hashlib, io, json, os, pathlib, zipfile
cache = pathlib.Path(os.environ.get('OPENPLANS_DATA_DIR', str(pathlib.Path.home() / '.local/share/openplans')))
sha = '4e33017f3c9a05d38a6f765df26982f258eaa999bd39dc6b8221e191f9011933'
payload = cache / 'raw/cms-sbe-ga-2026' / sha / 'payload'
assert hashlib.sha256(payload.read_bytes()).hexdigest() == sha
out = pathlib.Path(__file__).parent
with zipfile.ZipFile(payload) as z:
    data = {n: list(csv.DictReader(io.TextIOWrapper(z.open(n), encoding='utf-8-sig'))) for n in z.namelist()}
    plans = next(v for k, v in data.items() if 'Plans' in k)
    # One complete medical base and one dental base, including every variant.
    chosen = [next(r for r in plans if r['DENTAL ONLY PLAN'] == flag)['STANDARD COMPONENT ID'] for flag in ['No', 'Yes']]
    selected = [r for r in plans if r['STANDARD COMPONENT ID'] in chosen]
    issuers = {r['ISSUER ID'] for r in selected}
    files = []
    for name, rows in data.items():
        if 'Plans' in name: cut = selected
        elif 'Rates' in name:
            areas = {plan: next(r['RATING AREA ID'] for r in rows if r['PLAN ID'] == plan) for plan in chosen}
            cut = [r for r in rows if r['PLAN ID'] in chosen and r['RATING AREA ID'] == areas[r['PLAN ID']]]
        elif 'Benefits' in name: cut = [r for r in rows if r['STANDARD COMPONENT ID'] in chosen]
        elif 'BusinessRules' in name: cut = [r for r in rows if r['ISSUER ID'] in issuers]
        else:
            field = 'NETWORK ID' if 'Networks' in name else 'SERVICE AREA ID'
            keys = {(r['ISSUER ID'], r[field]) for r in selected}
            cut = [r for r in rows if (r['ISSUER ID'], r[field]) in keys]
        with (out / name).open('w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n', quoting=csv.QUOTE_ALL); writer.writeheader(); writer.writerows(cut)
        assert (out / name).stat().st_size < 200_000
        files.append({'member': name, 'rows': len(cut), 'original_rows': [i+2 for i,r in enumerate(rows) if r in cut]})
(out / 'provenance.json').write_text(json.dumps({'source': 'cms_sbe_puf', 'url': 'https://www.cms.gov/files/zip/georgiasbepuf2026.zip', 'sha256': sha, 'plans': chosen, 'files': files}, indent=2) + '\n')
