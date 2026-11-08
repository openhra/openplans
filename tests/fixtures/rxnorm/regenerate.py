#!/usr/bin/env python3
"""Cut real CPC rows. Usage: python3 regenerate.py /absolute/path/to/rxnorm-acquired.json"""
import collections
import hashlib
import json
from pathlib import Path
import sys
import zipfile

acquired = json.loads(Path(sys.argv[1]).read_text())
archive = Path(acquired['path'])
root = Path(__file__).resolve().parent
with zipfile.ZipFile(archive) as z:
    members = {Path(name).name: name for name in z.namelist() if name.endswith('.RRF')}
    def rows(name):
        with z.open(members[name]) as file:
            for raw in file:
                text = raw.decode('utf-8').rstrip('\r\n')
                yield text.split('|')[:-1], raw
    names = {'metformin', 'lisinopril', 'atorvastatin', 'lipitor'}
    selected = set()
    buckets = collections.Counter()
    for f, _ in rows('RXNCONSO.RRF'):
        if f[11] != 'RXNORM':
            continue
        name = f[14].lower()
        if name in names and f[12] in ('IN', 'BN'):
            selected.add(f[0])
        if f[12] in ('SCD', 'SBD') and '/' not in name:
            for drug in names:
                if (name.startswith(drug + ' ') or '[' + drug + ']' in name) and buckets[(drug, f[12])] < 2:
                    selected.add(f[0])
                    buckets[(drug, f[12])] += 1
    forward = {'has_ingredient', 'has_precise_ingredient', 'tradename_of', 'consists_of', 'contains', 'has_part', 'form_of', 'has_dose_form'}
    # Add components/ingredients/dose forms needed to prove the selected drug paths.
    for _ in range(3):
        extra = {f[0] for f, _ in rows('RXNREL.RRF') if f[10] == 'RXNORM' and f[4] in selected and f[7] in forward and f[0]}
        selected |= extra
    for name in ('RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSAT.RRF'):
        output = []
        ndc_counts = collections.Counter()
        for f, raw in rows(name):
            keep = f[0] in selected
            if name == 'RXNREL.RRF':
                keep = keep and f[4] in selected
            if name == 'RXNSAT.RRF':
                keep = keep and f[8] == 'NDC'
                key = (f[0], f[9])
                if keep:
                    keep = ndc_counts[key] < 3 or f[10] == '00071015523'
                    ndc_counts[key] += 1
            if keep:
                output.append(raw)
        data = b''.join(output)
        if len(data) >= 200_000:
            raise ValueError(f'{name} exceeds fixture budget: {len(data)}')
        (root / name).write_bytes(data)
    provenance = {'publisher': 'National Library of Medicine', 'source': 'RxNorm Current Prescribable Content',
                  'source_url': acquired['url'], 'release_version': acquired['version'],
                  'archive_sha256': acquired['metadata']['sha256'],
                  'selection': 'RXNORM IN/BN exact names plus first two single-drug SCD/SBD names per drug; three forward relation hops; up to three NDC attributes per concept/source, plus 00071015523 if present',
                  'rxcuis': sorted(selected), 'files': {name: {'sha256': hashlib.sha256((root / name).read_bytes()).hexdigest(), 'bytes': (root / name).stat().st_size} for name in members if (root / name).exists()}}
    (root / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
