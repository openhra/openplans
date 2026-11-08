#!/usr/bin/env python3
"""Independent, offline identity oracle over original VT PDF extraction / CMS CSV facts."""
import csv
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import zipfile
from collections import Counter


def name_key(name, issuer):
    folded = ' '.join(name.lower().split())
    if issuer == '13627' and folded.startswith('bcbsvt '):
        folded = folded[len('bcbsvt '):]
    if issuer == '77566':
        match = re.fullmatch(r'\[(mvp vt(?: plus)?)( hdhp)?\] (.+)', folded)
        if match:
            folded = match[1] + ' ' + match[3] + (match[2] or '')
    return folded


def metal_key(metal):
    value = (metal or '').strip().lower()
    return 'bronze' if value == 'expanded bronze' else value if value in ('bronze', 'silver', 'gold', 'platinum') else None


prepared, archive_path, archive_sha = sys.argv[1:]
artifact = json.loads(Path(prepared).read_text())
archive = Path(archive_path).read_bytes()
assert hashlib.sha256(archive).hexdigest() == archive_sha
with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
    member, = [name for name in bundle.namelist() if re.fullmatch(r'VTPlans\d*\.csv', name)]
    rows = list(csv.DictReader(io.StringIO(bundle.read(member).decode('utf-8-sig'))))

candidates = {}
for row in rows:
    if (row['MARKET COVERAGE'].strip() != 'Individual' or row['DENTAL ONLY PLAN'].strip() != 'No'
            or row['QHP NONQHP TYPE ID'].strip() not in ('Both', 'On the Exchange')):
        continue
    issuer, hios = row['ISSUER ID'].strip(), row['STANDARD COMPONENT ID'].strip()
    assert re.fullmatch(issuer + r'VT\d{7}', hios)
    key = (issuer, metal_key(row['METAL LEVEL']), name_key(row['PLAN MARKETING NAME'], issuer))
    candidates.setdefault(key, set()).add(hios)

filed = []
for source in artifact['sources']:
    for row in source['records']:
        issuer = {'BCBSVT': '13627', 'MVP': '77566'}.get(row['issuer'])
        metals = set(re.findall(r'\b(platinum|gold|silver|bronze)\b', row['plan_name'].lower()))
        metal = next(iter(metals)) if len(metals) == 1 else None
        if row['metal'] is not None and metal_key(row['metal']) != metal:
            metal = None
        key = (issuer, metal, name_key(row['plan_name'], issuer))
        filed.append((row['issuer'] + ':' + row['plan_name'], key))
counts = Counter(key for _, key in filed)
result = []
for plan_key, key in filed:
    ids = sorted(candidates.get(key, ())) if key[0] and key[1] else []
    status = 'none' if not ids else 'ambiguous' if len(ids) > 1 or counts[key] > 1 else 'matched'
    result.append({'plan_key': plan_key, 'hios_id': ids[0] if status == 'matched' else None,
                   'hios_match': status, 'candidates': ids, 'tuple': key})
print(json.dumps(result))
