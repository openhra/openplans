#!/usr/bin/env python3
"""Prepare VT PY2026 reflective Silver tiers from public state-hosted filings.

Only explicit 2026 Approved Rates are selected from the 2027 memos. Poppler is
preparation-only; neither PDF tools nor network access are runtime dependencies.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request
import urllib.robotparser

from prepare import sha

UA = 'openplans/0.4.1 (public health-plan source discovery; +https://plans.openhra.com/)'
HOST = 'https://ratereview.vermont.gov'
PUBLICATIONS = {
    'BCBSVT': dict(url=HOST + '/sites/dfr/files/documents/BCBSVT-Ind-Actuarial%20Memo-COMBINED.pdf',
                   sha256='0c6e85368bf739e620eb84bc3ddae4e7b111d1e18ae5de217067d69a781192a9', page=82),
    'MVP': dict(url=HOST + '/sites/dfr/files/documents/MVP%20Ind%20Actuarial%20Memo-COMBINED.pdf',
                sha256='b0eefb0470e5e84519ea14ad2a2d38680eaa6f8a01467b59c2b50fe74faec595', page=51),
}
TIERS = ['single', 'couple', 'adult_children', 'family']
BCBS_NAMES = ['Vermont Preferred Silver - Reflective', 'Vermont Select Silver CDHP - Reflective',
              'Standard Silver - Reflective', 'Standard Silver CDHP - Reflective']
# These are the complete published column labels, not asserted marketing names.
MVP_COLUMNS = [(3, 'Non-Standard Silver Reflective Non-HDHP'), (5, 'Non-Standard Silver Reflective HDHP'),
               (11, 'Standard Silver Reflective Non-HDHP'), (13, 'Standard Silver Reflective HDHP')]


def record(issuer, name, prices, coordinate, raw):
    if set(prices) != set(TIERS) or any(not re.fullmatch(r'[0-9]+\.[0-9]{2}', p) or float(p) <= 0 for p in prices.values()):
        raise ValueError('Missing approved 2026 tier; never synthesize a premium')
    return dict(plan_id=None, issuer=issuer, plan_name=name, region='Vermont', prices=prices,
                child_only='No', metal='Silver', exchange='Off', source_record=coordinate,
                raw={**prices, 'rate_year': '2026', 'rate_status': 'Approved', **raw})


def bcbs_cut(text):
    if 'EXHIBIT 9-IND' not in text or 'INDIVIDUAL MARKET' not in text:
        raise ValueError('Unexpected BCBSVT exhibit')
    return text.split('TABLE 2: PROPOSED PREMIUM RATES', 1)[1].split('Total', 1)[0]


def bcbs_records(text):
    if not all(label in text for label in ['2027 Proposed Rates', '2026 Approved Rates', '2027 Proposed Rate Increases',
                                           'Single Rate', 'Couple Rate', 'Child(ren) Rate', 'Family Rate']):
        raise ValueError('Missing approved-year column headings')
    result = []
    for name in BCBS_NAMES:
        lines = [line for line in text.splitlines() if re.match(r'^' + re.escape(name) + r'\s+1\.0746\s', line)]
        if len(lines) != 1:
            raise ValueError('Ambiguous or missing BCBSVT reflective row: ' + name)
        line = lines[0]
        values = re.findall(r'\$([0-9,]+\.[0-9]{2})', line)
        if len(values) != 8:
            raise ValueError('Expected four proposed and four approved tier cells')
        prices = dict(zip(TIERS, [v.replace(',', '') for v in values[4:8]]))
        result.append(record('BCBSVT', name, prices,
                             f'page=82;exhibit=9-IND;table=2;year=2026;row={name}',
                             dict(source_line=line.strip(), name_kind='published_plan_name')))
    return result


def mvp_cut(text):
    if 'INDV Market' not in text or not all(s in text for s in ['NON-STANDARD PLANS', 'STANDARD PLANS',
            'On Exchange', 'Reflective', 'Non-HDHP', 'HDHP', 'SILVER']):
        raise ValueError('Unexpected MVP individual contract table')
    return text.split('2027 Proposed Rate Increases', 1)[0]


def mvp_records(text):
    if not all(s in text for s in ['NON-STANDARD PLANS', 'STANDARD PLANS', 'SILVER', 'Reflective', 'Non-HDHP', 'HDHP']):
        raise ValueError('Missing MVP design column headings')
    rows = text.split('2026 Approved Rates', 1)[1].splitlines()
    labels = ['Single Rate', 'Couple Rate', 'Adult and Child(ren) Rate', 'Family Rate']
    matrix, raw_lines = [], []
    for label in labels:
        lines = [line for line in rows if line.startswith(label)]
        if len(lines) != 1:
            raise ValueError('Missing or ambiguous MVP approved tier row')
        values = re.findall(r'\$([0-9,]+\.[0-9]{2})', lines[0])
        # Family row also contains aggregate revenue and PMPM: never use those.
        if len(values) != (20 if label == 'Family Rate' else 18):
            raise ValueError('Unexpected MVP approved-rate table dimensions')
        matrix.append([v.replace(',', '') for v in values[:18]])
        raw_lines.append(lines[0].strip())
    return [record('MVP', name, dict(zip(TIERS, [row[column] for row in matrix])),
                   f'page=51;table=contract-rate-increases;year=2026;column={column + 1}',
                   dict(source_lines='\n'.join(raw_lines), name_kind='published_column_labels',
                        column=str(column + 1), design_label=name)) for column, name in MVP_COLUMNS]


def cached(url, directory, network):
    # Share prior survey/source snapshots without fetching matching bytes again.
    for folder in [directory / 'raw' / 'vt-source-survey', directory / 'raw' / 'state-rating']:
        for meta_path in sorted(folder.rglob('*.meta.json')):
            meta = json.loads(meta_path.read_text())
            if meta.get('url') != url:
                continue
            path = meta_path.parent / meta.get('sha256', '')
            if not path.is_file():
                path = Path(str(meta_path)[:-len('.meta.json')])
            if path.is_file() and sha(path.read_bytes()) == meta.get('sha256') and meta.get('status') == 200:
                return path, meta
    if not network:
        raise ValueError('No verified cached publication; pass --acquire for paced anonymous HTTPS')
    time.sleep(2)
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=60) as response:
        if response.url != url:
            raise ValueError('Unexpected redirect; review robots and terms before acquiring')
        data = response.read(50 * 1024 ** 2 + 1)
        if len(data) > 50 * 1024 ** 2:
            raise ValueError('Publication size limit')
        meta = dict(url=url, status=response.status, sha256=sha(data), bytes=len(data),
                    content_type=response.headers.get('Content-Type'), etag=response.headers.get('ETag'),
                    last_modified=response.headers.get('Last-Modified'), user_agent=UA,
                    retrieved_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    folder = directory / 'raw' / 'vt-source-survey'
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / meta['sha256']
    part = path.with_suffix('.part'); part.write_bytes(data)
    metadata = folder / (meta['sha256'] + '.' + hashlib.sha256(url.encode()).hexdigest()[:12] + '.meta.json')
    metadata_part = metadata.with_suffix('.json.part'); metadata_part.write_text(json.dumps(meta, indent=2) + '\n')
    metadata_part.replace(metadata); part.replace(path)
    return path, meta


def prepare(cache, acquire=False):
    if acquire:
        robots_path, _ = cached(HOST + '/robots.txt', cache, True)
        robots = urllib.robotparser.RobotFileParser()
        robots.parse(robots_path.read_text().splitlines())
        if any(not robots.can_fetch(UA, source['url']) for source in PUBLICATIONS.values()):
            raise ValueError('Publisher robots disallow acquisition')
    sources, cuts = [], {}
    for issuer, source in PUBLICATIONS.items():
        path, meta = cached(source['url'], cache, acquire)
        if meta['sha256'] != source['sha256']:
            raise ValueError('Publication changed; review approved-year headings and layout')
        text = subprocess.check_output(['pdftotext', '-f', str(source['page']), '-l', str(source['page']),
                                        '-layout', str(path), '-'], text=True)
        cut = bcbs_cut(text) if issuer == 'BCBSVT' else mvp_cut(text)
        rows = bcbs_records(cut) if issuer == 'BCBSVT' else mvp_records(cut)
        sources.append(dict(**meta, raw_path=str(path), records=rows))
        cuts[issuer] = cut
    return dict(schema_version='state-rates-v1', state='VT', plan_year=2026, sources=sources), cuts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default=os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local/share/openplans')))
    parser.add_argument('--acquire', action='store_true', help='download missing publications after robots review; existing terms reviewed in README')
    parser.add_argument('--fixtures', action='store_true', help='regenerate fact-only fixture and source table cuts')
    args = parser.parse_args()
    cache = Path(args.data_dir).resolve()
    package = Path(__file__).resolve().parents[3]
    roots = [package]
    for flag in ['--show-toplevel', '--git-common-dir']:
        result = subprocess.run(['git', '-C', str(package), 'rev-parse', '--path-format=absolute', flag], capture_output=True, text=True)
        if result.returncode == 0:
            root = Path(result.stdout.strip()).resolve()
            roots.append(root.parent if flag == '--git-common-dir' else root)
    if any(cache == root or root in cache.parents for root in roots):
        raise ValueError('Data directory must be outside repository and worktrees')
    supplement, cuts = prepare(cache, args.acquire)
    base = json.loads((cache / 'derived/state-rating/vt-2026.json').read_text())
    from prepare import VT_URL
    if base.get('state') != 'VT' or base.get('plan_year') != 2026 or len(base.get('sources', [])) != 1 or base['sources'][0]['url'] != VT_URL or len(base['sources'][0]['records']) != 26:
        raise ValueError('Expected original complete 26-design VT artifact; never replace it with a partial catalog')
    original = base['sources'][0]
    if sha(Path(original['raw_path']).read_bytes()) != original['sha256']:
        raise ValueError('Original VHC publication hash mismatch')
    combined = {**base, 'sources': base['sources'] + supplement['sources']}
    out = cache / 'derived/state-rating/vt-2026-with-reflective.json'
    out.write_text(json.dumps(combined, indent=2) + '\n')
    if args.fixtures:
        fixture = package / 'tests/fixtures/state'
        for source in supplement['sources']:
            source.pop('raw_path', None)
        (fixture / 'vt-reflective-2026.json').write_text(json.dumps(supplement, indent=2) + '\n')
        (fixture / 'vt-reflective-source-cells.json').write_text(json.dumps(dict(
            description='Real factual table cuts from pinned state-hosted publications; regenerate with reflective.py --fixtures',
            publications=PUBLICATIONS, cuts=cuts), indent=2) + '\n')
    print(json.dumps(dict(status='PREPARED', artifact=str(out), records=34, reflective_records=8,
                          hios_ids='unknown; no cross-year HIOS inference')))


if __name__ == '__main__':
    main()
