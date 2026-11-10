#!/usr/bin/env python3
"""Independent raw-CSV expectations for the CMS Plan ID Crosswalk PUF (stdlib only).

Reads the acquired archive named by the manifest, never the importer, and writes the row
count, per-state counts, the distinct prior/successor ID sets and every successor's
ancestor set as JSON.
"""
import argparse
import csv
import hashlib
import io
import json
from pathlib import Path
import zipfile

NO_PLAN = '00000XX0000000'
parser = argparse.ArgumentParser()
parser.add_argument('--cache', required=True)
parser.add_argument('--manifest', required=True)
parser.add_argument('--year', type=int, required=True)
parser.add_argument('--output', required=True)
args = parser.parse_args()
manifest = json.loads(Path(args.manifest).read_text())
entries = [f for f in manifest['files'] if f['year'] == args.year and f['kind'] == 'plan-id-crosswalk']
if len(entries) != 1 or entries[0]['status'] != 'ok':
    raise SystemExit('Expected exactly one acquired crosswalk archive')
entry = entries[0]
payload = Path(args.cache) / 'raw' / 'cms-exchange-puf' / entry['snapshot_id'] / 'payload'
digest = hashlib.sha256(payload.read_bytes()).hexdigest()
if digest != entry['sha256']:
    raise SystemExit('Archive hash differs from the manifest')
prior_col, successor_col = f'PlanID_{args.year - 1}', f'PlanID_{args.year}'
rows, per_state, priors, successors, ancestors = 0, {}, set(), set(), {}
with zipfile.ZipFile(payload) as archive:
    names = archive.namelist()
    if len(names) != 1:
        raise SystemExit('Expected one CSV member')
    with io.TextIOWrapper(archive.open(names[0]), encoding='utf-8-sig', newline='') as stream:
        for row in csv.DictReader(stream):
            rows += 1
            per_state[row['State']] = per_state.get(row['State'], 0) + 1
            prior, successor = row[prior_col], row[successor_col]
            priors.add(prior)
            if successor != NO_PLAN:
                successors.add(successor)
                ancestors.setdefault(successor, set()).add(prior)
pairs = sorted(f'{s}<{p}' for s, ps in ancestors.items() for p in ps)
Path(args.output).write_text(json.dumps({
    'year': args.year,
    'sha256': digest,
    'url': entry['url'],
    'rows': rows,
    'per_state': dict(sorted(per_state.items())),
    'prior_plans': sorted(priors),
    'successor_plans': sorted(successors),
    'pairs_sha256': hashlib.sha256('\n'.join(pairs).encode()).hexdigest(),
    'pairs': len(pairs),
    'ancestors': {s: sorted(ps) for s, ps in sorted(ancestors.items())},
}))
