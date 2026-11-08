#!/usr/bin/env python3
"""Offline TX comparison of immutable acquired PUFs; no inferred rates or plan crosswalks."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from statistics import median
from raw_csv import csv_rows, cents


def comparison(cache, manifest):
    years = {}
    for year in [2026, 2027]:
        files = {f['kind']: f for f in manifest['files'] if f['year'] == year and f['status'] == 'ok'}
        path = lambda kind: cache / 'raw/cms-exchange-puf' / files[kind]['snapshot_id'] / 'payload'
        for kind in ['plan-attributes', 'rate']:
            digest = hashlib.sha256()
            with path(kind).open('rb') as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(chunk)
            if digest.hexdigest() != files[kind]['sha256']:
                raise ValueError('Comparison archive hash mismatch')
        attributes = [r for _, r in csv_rows(path('plan-attributes'), year)]
        plans = {r['StandardComponentId']: r for r in attributes}
        medical = {p: r for p, r in plans.items() if r['MarketCoverage'] == 'Individual' and r['DentalOnlyPlan'] == 'No'
                   and any(v['QHPNonQHPTypeId'] in ['Both', 'On the Exchange'] for v in attributes if v['StandardComponentId'] == p)}
        issuers = lambda rows: {r['IssuerId']: r['IssuerMarketPlaceMarketingName'] for r in rows.values()}
        metals = lambda rows: {m: sum(r['MetalLevel'] == m for r in rows.values()) for m in sorted({r['MetalLevel'] for r in rows.values()})}
        by_area = {}
        for _, r in csv_rows(path('rate'), year):
            if r['PlanId'] not in medical or r['Age'] != '40':
                continue
            effective = r['RateEffectiveDate']
            expiration = r['RateExpirationDate']
            # ISO dates in both observed years. Fail rather than silently sort other formats.
            if not effective.startswith(str(year)) or not expiration.startswith(str(year)):
                raise ValueError('Unexpected source date format')
            if not effective <= f'{year}-01-01' <= expiration:
                continue
            value = cents(r['IndividualRate'])
            if value is None:
                raise ValueError('Missing age-40 individual premium')
            key = (r['PlanId'], r['RatingAreaId'])
            if key in by_area:
                raise ValueError('Ambiguous age-40 non-tobacco rate')
            by_area[key] = value
        areas = {area: [v for (p, a), v in by_area.items() if a == area] for area in sorted({a for p, a in by_area})}
        years[year] = {'catalog_base_plans': len(plans), 'catalog_issuers': issuers(plans), 'catalog_metal_counts': metals(plans),
                       'medical_base_plans': len(medical), 'medical_issuers': issuers(medical), 'medical_metal_counts': metals(medical),
                       'areas': {a: {'plans': len(v), 'median_cents': median(v)} for a, v in areas.items()}}
    old, new = years[2026], years[2027]
    changes = {}
    for scope in ['catalog', 'medical']:
        a, b = old[f'{scope}_issuers'], new[f'{scope}_issuers']
        changes[scope] = {'entering': {i: b[i] for i in sorted(b.keys() - a.keys())},
                          'leaving': {i: a[i] for i in sorted(a.keys() - b.keys())}}
    premiums = []
    for a in sorted(old['areas'].keys() | new['areas'].keys(), key=lambda a: int(a.rsplit(' ', 1)[1])):
        before, after = old['areas'].get(a), new['areas'].get(a)
        premiums.append({'area': a, '2026': before, '2027': after,
                         'change_cents': after['median_cents'] - before['median_cents'] if before and after else None,
                         'change_percent': round((after['median_cents'] / before['median_cents'] - 1) * 100, 2) if before and after else None})
    return {'scope': 'TX individual on-exchange medical base plans; age 40, non-tobacco, January 1 filed premium. Difference of cross-sectional medians, not matched-plan renewal increases. Dental and SHOP included only in catalog totals.',
            'years': years, 'issuer_changes': changes, 'premiums': premiums,
            'source_hashes': {str(y): {f['kind']: f['sha256'] for f in manifest['files'] if f['year'] == y} for y in [2026, 2027]}}


def markdown(report):
    years = report['years']
    # JSON roundtrip accepts string or integer year keys.
    old, new = years.get('2026', years.get(2026)), years.get('2027', years.get(2027))
    lines = ['# TX PY2026 → PY2027', '', report['scope'], '', '## Issuers', '', json.dumps(report['issuer_changes'], indent=2), '',
             '| Metal | 2026 medical plans | 2027 medical plans |', '| --- | ---: | ---: |']
    for metal in sorted(old['medical_metal_counts'].keys() | new['medical_metal_counts'].keys()):
        lines.append(f"| {metal} | {old['medical_metal_counts'].get(metal, 0)} | {new['medical_metal_counts'].get(metal, 0)} |")
    lines += ['', '| Rating area | 2026 plans | 2027 plans | 2026 median ($) | 2027 median ($) | Change ($) | Change (%) |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for r in report['premiums']:
        a, b = r['2026'], r['2027']
        lines.append(f"| {r['area']} | {a['plans'] if a else 'unknown'} | {b['plans'] if b else 'unknown'} | {a['median_cents']/100 if a else 'unknown'} | {b['median_cents']/100 if b else 'unknown'} | {r['change_cents']/100 if a and b else 'unknown'} | {r['change_percent']} |")
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache', type=Path, default=Path(os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans'))))
    args = parser.parse_args()
    manifest = json.loads(sorted((args.cache / 'raw/cms-exchange-puf').glob('manifest-*.json'))[-1].read_text())
    report = comparison(args.cache, manifest)
    stem = args.cache / 'reports/tx-2026-2027-comparison'
    stem.parent.mkdir(parents=True, exist_ok=True)
    stem.with_suffix('.json').write_text(json.dumps(report, indent=2) + '\n')
    stem.with_suffix('.md').write_text(markdown(report))
    print(stem.with_suffix('.md'))
