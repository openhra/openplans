#!/usr/bin/env python3
"""Regenerate state rate artifacts from public publications, using only Python stdlib.

VT PDF extraction uses the already-installed Poppler pdftotext tool. It is a source
preparation tool, not a worker/container dependency. Downloads stay outside git.
"""
import argparse
import concurrent.futures
import datetime
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

NY_FINAL = 'https://myportal.dfs.ny.gov/documents/538523/45010894/'
NY_FILES = [
    'Anthem_HP_IND_BOTHX_AWLP-134536531_FinalExhibits',
    'CDPHP_IND_BOTHX_CAPD-134513425_FinalExhibits',
    'Excellus_IND_BOTHX_EXHP-134514190_FinalExhibits',
    'NYQHC_IND_BOTHX_CECO-134513476_FinalExhibits',
    'HIP_IND_BOTHX_HPHP-134514549_FinalExhibits',
    'Healthfirst_PHSP_IND_BOTHX_HLFT-134517631_FinalExhibits',
    'Highmark_IND_BOTHX_HLTH-134513347_FinalExhibits',
    'IHBC_IND_BOTHX_NDPD-134516574_FinalExhibits',
    'MVP_HP_IND_BOTHX_MVPH-134515640_FinalExhibits',
    'MetroPlus_IND_ONX_MPHP-134514244_FinalExhibits',
    'Oscar_IND_BOTHX_OHIN-134535890_FinalExhibits',
    'UHC_IND_BOTHX_UHLC-134532109_FinalExhibits',
]
VT_URL = 'https://info.healthconnect.vermont.gov/sites/vhc/files/documents/2026_PlanDesigns_FinalRates.pdf'
# Column labels transcribed from this exact publication, not guessed HIOS IDs.
VT_NAMES = {
    'BCBSVT': ['Platinum Plan', 'Gold Plan', 'Silver Plan', 'Bronze Plan',
               'Bronze Integrated Plan', 'Silver CDHP Plan', 'Bronze CDHP Plan',
               'Vermont Preferred Gold Plan', 'Vermont Preferred Silver Plan',
               'Vermont Preferred Bronze Plan', 'Vermont Select Gold CDHP Plan',
               'Vermont Select Silver CDHP Plan', 'Vermont Select Bronze CDHP Plan'],
    'MVP': ['MVP VT Platinum 1', 'MVP VT Gold 1', 'MVP VT Silver 3', 'MVP VT Bronze 2',
            'MVP VT Bronze 4', 'MVP VT Silver 4 HDHP', 'MVP VT Bronze 3 HDHP',
            'MVP VT Plus Gold 4', 'MVP VT Plus Silver 1', 'MVP VT Plus Bronze 1',
            'MVP VT Plus Bronze 5', 'MVP VT Plus Gold 3 HDHP', 'MVP VT Plus Silver 2 HDHP'],
}
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def sha(b):
    return hashlib.sha256(b).hexdigest()


def cached_download(url, cache):
    directory = cache / 'raw' / 'state-rating'
    directory.mkdir(parents=True, exist_ok=True)
    # Also reuse the survey downloads made before this preparation tool existed.
    for meta in sorted(directory.rglob('*.meta.json')):
        value = json.loads(meta.read_text())
        if value.get('url') != url:
            continue
        path = Path(str(meta)[:-len('.meta.json')])
        if path.is_file() and sha(path.read_bytes()) == value.get('sha256'):
            return path, value
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(50 * 1024 * 1024 + 1)
        if len(data) > 50 * 1024 * 1024:
            raise ValueError('Publication exceeds size limit')
        metadata = dict(url=url, status=response.status, content_type=response.headers.get('Content-Type'),
                        etag=response.headers.get('ETag'), last_modified=response.headers.get('Last-Modified'),
                        sha256=sha(data), bytes=len(data), retrieved_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    path = directory / metadata['sha256']
    part = path.with_suffix('.part')
    part.write_bytes(data)
    meta = path.with_suffix('.meta.json')
    meta_part = path.with_suffix('.meta.json.part')
    meta_part.write_text(json.dumps(metadata, indent=2) + '\n')
    meta_part.replace(meta)
    part.replace(path)
    return path, metadata


def ooxml_sheets(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if sum(i.file_size for i in z.infolist()) > 50 * 1024 * 1024:
            raise ValueError('OOXML expanded size limit')
        strings = [''.join(si.itertext()) for si in ET.fromstring(z.read('xl/sharedStrings.xml'))] if 'xl/sharedStrings.xml' in z.namelist() else []
        relations = {r.attrib['Id']: r.attrib['Target'] for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))}
        result = {}
        for sheet in ET.fromstring(z.read('xl/workbook.xml')).findall('m:sheets/m:sheet', NS):
            target = relations[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            rows = {}
            for row in ET.fromstring(z.read(target)).findall('m:sheetData/m:row', NS):
                cells = {}
                for cell in row:
                    col = 0
                    for char in re.sub(r'\d+$', '', cell.attrib['r']):
                        col = col * 26 + ord(char) - 64
                    value = cell.find('m:v', NS)
                    if cell.attrib.get('t') == 'inlineStr':
                        cells[col - 1] = ''.join(cell.find('m:is', NS).itertext())
                    elif value is not None and value.text is not None:
                        cells[col - 1] = strings[int(value.text)] if cell.attrib.get('t') == 's' else value.text
                rows[int(row.attrib['r'])] = cells
            result[sheet.attrib['name']] = rows
        return result


def ny_records(path):
    from biff import biff_sheets
    data = path.read_bytes()
    workbooks = [('publication', data)]
    if data[:4] == b'PK\x03\x04':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if 'xl/workbook.xml' not in z.namelist():
                if sum(i.file_size for i in z.infolist()) > 50 * 1024 * 1024:
                    raise ValueError('Archive expanded size limit')
                workbooks = [(n, z.read(n)) for n in z.namelist() if n.lower().endswith(('.xls', '.xlsx', '.xlsm'))]
    result = []
    for member, data in workbooks:
        sheets = ooxml_sheets(data) if data[:4] == b'PK\x03\x04' else biff_sheets(data)
        for name, rows in sheets.items():
            headers = [(n, c) for n, c in rows.items() if c.get(0) == 'Plan ID*']
            if not headers:
                continue
            if rows.get(9, {}).get(1) != 'Family-Tier Rates':
                continue  # e.g. separate child-only age-labelled sheets; never use federal math.
            effective, expiration = rows.get(7, {}).get(1), rows.get(8, {}).get(1)
            if effective not in ('46023', '46023.0') or expiration not in ('46387', '46387.0'):
                raise ValueError('Unexpected individual rate dates: ' + repr((effective, expiration)))
            header_row, header = headers[0]
            if header.get(4) != 'Individual Rate*' or header.get(6) != 'Couple*' or header.get(12) != 'Couple and Three or More Dependents*':
                raise ValueError('Unexpected approved rate table columns')
            for row, cells in rows.items():
                plan = cells.get(0, '').strip()
                if row <= header_row or not re.fullmatch(r'\d{5}NY\d{7}', plan):
                    continue
                def amount(col):
                    number = Decimal(cells[col])
                    rounded = number.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
                    if number <= 0 or abs(number - rounded) > Decimal('0.000001'):
                        raise ValueError('Approved tier price must be positive integer cents')
                    return str(rounded)
                prices = dict(single=amount(4), couple=amount(6), adult_children=amount(7), family=amount(10))
                if any(amount(c) != prices['adult_children'] for c in (8, 9)) or any(amount(c) != prices['family'] for c in (11, 12)):
                    raise ValueError('Non-uniform NY family tier columns require separate evidence')
                if not re.fullmatch(r'Rating Area [1-8]', cells.get(1, '')):
                    raise ValueError('Unexpected NY rating area')
                result.append(dict(plan_id=plan, issuer=plan[:5], region=cells[1], prices=prices,
                                   child_only='No', metal=None, exchange='unknown',
                                   source_record=f'{member}#{name}!row={row}',
                                   raw={**{str(c): cells[c] for c in range(13) if c in cells},
                                        'rating_method': rows[9][1], 'effective_serial': effective, 'expiration_serial': expiration}))
    if not result:
        raise ValueError('No individual community family-tier rates in approved template')
    return result


def vt_records(path):
    # This mapping must be re-reviewed if the publisher changes the layout.
    if sha(path.read_bytes()) != '8353a9b2d90f2b4b23173c154e0de8ef426b90ec8a897eed965f4b97c82f68c3':
        raise ValueError('VHC PDF changed; review column labels and layout before regenerating')
    text = subprocess.check_output(['pdftotext', '-layout', str(path), '-'], text=True)
    lines = text.split('Premiums by Tier (monthly cost)', 1)[1].splitlines()
    tiers = {'BCBSVT': [], 'MVP': []}
    for line in lines:
        match = re.search(r'\b(BCBSVT|MVP)\b(.*)', line)
        if not match:
            continue
        prices = re.findall(r'\$([\d,]+\.\d\d)', match.group(2))
        if prices:
            tiers[match.group(1)].append([p.replace(',', '') for p in prices])
    result = []
    for issuer, names in VT_NAMES.items():
        if len(tiers[issuer]) != 4 or any(len(row) != len(names) for row in tiers[issuer]):
            raise ValueError('Unexpected VHC tier table dimensions')
        for column, name in enumerate(names):
            prices = dict(zip(['single', 'couple', 'adult_children', 'family'], [row[column] for row in tiers[issuer]]))
            result.append(dict(plan_id=None, issuer=issuer, plan_name=name, region='Vermont',
                               prices=prices, child_only='No', metal=None, exchange='On',
                               source_record=f'page=1;issuer={issuer};column={column + 1}', raw=prices))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', choices=['NY', 'VT'], required=True)
    parser.add_argument('--data-dir', default=os.environ.get('OPENPLANS_DATA_DIR', str(Path.home() / '.local' / 'share' / 'openplans')))
    parser.add_argument('--fixtures', action='store_true', help='write a small, reproducible cut into tests/fixtures/state')
    args = parser.parse_args()
    cache = Path(args.data_dir).resolve()
    package = Path(__file__).resolve().parents[3]
    roots = {package}
    for flag in ['--show-toplevel', '--git-common-dir']:
        probe = subprocess.run(['git', '-C', str(package), 'rev-parse', '--path-format=absolute', flag],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        if probe.returncode == 0:
            root = Path(probe.stdout.strip()).resolve()
            roots.add(root.parent if flag == '--git-common-dir' else root)
    if any(cache.is_relative_to(root) for root in roots):
        raise ValueError('Data directory must be outside the repository and worktrees')
    urls = [(NY_FINAL + name).replace('/45010894/', '/45010883/').replace('_FinalExhibits', '_ApprRatesTemplate') for name in NY_FILES] if args.state == 'NY' else [VT_URL]
    def prepare(url):
        path, metadata = cached_download(url, cache)
        rows = ny_records(path) if args.state == 'NY' else vt_records(path)
        return dict(**metadata, raw_path=str(path), records=rows)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        sources = list(pool.map(prepare, urls))
    value = dict(schema_version='state-rates-v1', state=args.state, plan_year=2026, sources=sources)
    out = cache / 'derived' / 'state-rating' / f'{args.state.lower()}-2026.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(value, indent=2) + '\n')
    print(json.dumps(dict(state=args.state, records=sum(len(s['records']) for s in sources), artifact=str(out))))
    if args.fixtures:
        if args.state == 'NY':
            sources = [s for s in sources if 'MetroPlus' in s['url']]
            sources[0]['records'] = [r for r in sources[0]['records'] if r['plan_id'] in ['11177NY0010001', '11177NY0010002', '11177NY0220001']]
        else:
            sources[0]['records'] = [r for r in sources[0]['records'] if r['plan_name'] in ['Gold Plan', 'MVP VT Gold 1']]
        value['sources'] = sources
        for source in sources:
            source.pop('raw_path')
        fixture = Path(__file__).resolve().parents[3] / 'tests' / 'fixtures' / 'state' / f'{args.state.lower()}-2026.json'
        fixture.write_text(json.dumps(value, indent=2) + '\n')


if __name__ == '__main__':
    main()
