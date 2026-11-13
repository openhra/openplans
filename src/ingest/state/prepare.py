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
import struct
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


def cached_publication(url, cache):
    """Return (path, metadata) for a hash-verified cached copy of url, or None. Never downloads."""
    directory = cache / 'raw' / 'state-rating'
    if not directory.is_dir():
        return None
    # Also reuse the survey downloads made before this preparation tool existed.
    for meta in sorted(directory.rglob('*.meta.json')):
        value = json.loads(meta.read_text())
        if value.get('url') != url:
            continue
        path = Path(str(meta)[:-len('.meta.json')])
        if path.is_file() and sha(path.read_bytes()) == value.get('sha256'):
            return path, value
    return None


def cached_download(url, cache, cache_only=False):
    cached = cached_publication(url, cache)
    if cached:
        return cached
    if cache_only:
        raise ValueError('Not in the local cache (--cache-only): ' + url)
    directory = cache / 'raw' / 'state-rating'
    directory.mkdir(parents=True, exist_ok=True)
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


# Template guard. An approved-rates template must have been saved on or after the day its
# filing was submitted. A workbook last saved before submission cannot hold
# the rates DFS approved later, so it is refused and its issuer's rates stay unknown.
TEMPLATE_GUARD_RULE = 'ny-approved-template-saved-on-or-after-submission-v1'
FILING_TRACKING = re.compile(r'_([A-Z]{4}-\d{9})_(?:ApprRatesTemplate|FinalExhibits)$')
# DFS final-exhibit members keep their submission upload date in the file name, for example
# "<issuer>_<NAIC>_<tracking>_IN_23_<YYYYMMDD>_<sequence>.xlsm".
SUBMISSION_MEMBER = re.compile(r'_([A-Z]{4}-\d{9})_IN_[0-9A-Z]+_(\d{8})_\d+\.xls[xm]?$')
SUMMARY_FMTID = bytes.fromhex('e0859ff2f94f6810ab9108002b27b3d9')
PID_LAST_SAVED = 13
VT_FILETIME = 0x40


def filetime_iso(value):
    if not value:
        return None
    moment = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(microseconds=value // 10)
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def ole_saved_at(data):
    """Last-saved time from a CFB workbook's SummaryInformation property set, or None."""
    from biff import cfb_stream
    stream = cfb_stream(data, ('\x05SummaryInformation',))
    if not stream or len(stream) < 48 or stream[28:44] != SUMMARY_FMTID:
        return None
    section = struct.unpack_from('<I', stream, 44)[0]
    if section + 8 > len(stream):
        return None
    count = struct.unpack_from('<I', stream, section + 4)[0]
    if section + 8 + 8 * count > len(stream):
        return None
    for index in range(count):
        pid, offset = struct.unpack_from('<II', stream, section + 8 + 8 * index)
        at = section + offset
        if pid == PID_LAST_SAVED and at + 12 <= len(stream) and struct.unpack_from('<I', stream, at)[0] == VT_FILETIME:
            return filetime_iso(struct.unpack_from('<Q', stream, at + 4)[0])
    return None


def ooxml_saved_at(data):
    """dcterms:modified from an OOXML workbook's core properties, or None."""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if 'docProps/core.xml' not in z.namelist():
            return None
        core = ET.fromstring(z.read('docProps/core.xml'))
    node = core.find('{http://purl.org/dc/terms/}modified')
    text = (node.text or '').strip() if node is not None else ''
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', text):
        return None
    return text[:19] + 'Z'


def template_workbooks(data):
    if data[:4] == b'PK\x03\x04':
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if 'xl/workbook.xml' not in z.namelist():
                return [(n, z.read(n)) for n in sorted(z.namelist()) if n.lower().endswith(('.xls', '.xlsx', '.xlsm'))]
    return [('publication', data)]


def template_saved_dates(data):
    return [dict(member=member, saved_at=ooxml_saved_at(book) if book[:4] == b'PK\x03\x04' else ole_saved_at(book))
            for member, book in template_workbooks(data)]


def filing_submission(final_exhibits, tracking):
    """Submission date (YYYY-MM-DD) named by the filing's cached final exhibits, with evidence."""
    if final_exhibits is None:
        return None, None
    path, metadata = final_exhibits
    with zipfile.ZipFile(path) as z:
        names = sorted(z.namelist())
    members = [n for n in names if (m := SUBMISSION_MEMBER.search(n)) and m.group(1) == tracking]
    dates = sorted({SUBMISSION_MEMBER.search(n).group(2) for n in members})
    evidence = dict(url=metadata['url'], sha256=metadata['sha256'], members=members, dates=dates)
    if len(dates) != 1:
        return None, evidence
    day = dates[0]
    return f'{day[:4]}-{day[4:6]}-{day[6:]}', evidence


def template_decision(workbooks, submission_date, submission_evidence):
    if not workbooks or any(w['saved_at'] is None for w in workbooks):
        return 'template_saved_date_unavailable'
    if submission_date is None:
        return 'submission_date_ambiguous' if submission_evidence and submission_evidence['dates'] else 'submission_date_unavailable'
    if min(w['saved_at'][:10] for w in workbooks) < submission_date:
        return 'template_saved_before_submission'
    return None


def template_check(url, path, metadata, final_exhibits, records):
    """Apply the template guard. The submission date comes only from the local cache."""
    match = FILING_TRACKING.search(url)
    tracking = match.group(1) if match else None
    workbooks = template_saved_dates(path.read_bytes())
    submission_date, submission_evidence = filing_submission(final_exhibits, tracking) if tracking else (None, None)
    reason = template_decision(workbooks, submission_date, submission_evidence)
    check = dict(url=url, sha256=metadata['sha256'], bytes=metadata['bytes'], retrieved_at=metadata['retrieved_at'],
                 content_type=metadata.get('content_type'), filing=tracking,
                 issuer_ids=sorted({r['issuer'] for r in records}),
                 decision='refused' if reason else 'admitted', status='unknown' if reason else 'filed', reason=reason,
                 evidence=dict(rule=TEMPLATE_GUARD_RULE, workbooks=workbooks,
                               submission_date=submission_date, submission_source=submission_evidence))
    if reason:
        # Where the refused template lists plans, without any of its rates. A benchmark for a
        # listed region cannot be computed while one of these plans could rank.
        check['listed_plans'] = [dict(plan_id=plan, region=region)
                                 for plan, region in sorted({(r['plan_id'], r['region']) for r in records})]
    return check


# Rate source override. Off unless the operator's configuration names an issuer, for example
# {"version": 1, "ny": {"rateSourceOverrides": {"25303": "cms-sbe"}}}. An override is allowed
# only for an issuer whose DFS template the guard refused. Its family-tier rates then come from
# the cached CMS state-based exchange rate file, and only while that file matches every other
# issuer's DFS approved rates to the cent.
OVERRIDE_RULE = 'ny-rate-source-override-v1'
CROSS_CHECK_RULE = 'ny-sbe-rates-match-dfs-approved-to-the-cent-v1'
OVERRIDE_SOURCES = ('cms-sbe',)
SBE_SOURCE_DIR = 'cms-sbe-puf'
SBE_NY_URL = 'https://www.cms.gov/files/zip/newyorksbepuf2026.zip'
SBE_RATES_MEMBER = re.compile(r'NYRates\d{8}\.csv')
SBE_TIERS = [('4', 'INDIVIDUAL RATE'), ('6', 'COUPLE'),
             ('7', 'PRIMARY SUBSCRIBER AND ONE DEPENDENT'), ('8', 'PRIMARY SUBSCRIBER AND TWO DEPENDENTS'),
             ('9', 'PRIMARY SUBSCRIBER AND THREE OR MORE DEPENDENTS'),
             ('10', 'COUPLE AND ONE DEPENDENT'), ('11', 'COUPLE AND TWO DEPENDENTS'),
             ('12', 'COUPLE AND THREE OR MORE DEPENDENTS')]
OVERRIDE_NOTE = ('The template guard refused this issuer\'s DFS approved-rates template, reason {reason}, so DFS '
                 'gives no usable approved rates for it. By operator decision, this issuer\'s family-tier rates come from the CMS '
                 'state-based exchange rate file instead. That file matches the DFS approved rates of every other '
                 'NY issuer to the cent. Plans the file does not list stay unknown.')


def rate_source_overrides(config_path):
    """Issuer -> source from the operator's configuration file, or {} when none is set."""
    if not config_path:
        return {}
    value = json.loads(Path(config_path).read_text())
    if not isinstance(value, dict) or value.get('version') != 1:
        raise ValueError('Configuration must have version 1')
    overrides = (value.get('ny') or {}).get('rateSourceOverrides') or {}
    if not isinstance(overrides, dict) or any(not re.fullmatch(r'\d{5}', str(k)) or v not in OVERRIDE_SOURCES
                                              for k, v in overrides.items()):
        raise ValueError('ny.rateSourceOverrides maps five-digit issuer IDs to "cms-sbe"')
    return dict(sorted(overrides.items()))


def admitted_snapshot(source_dir, meta):
    """The fetch cache's quarantine rule: a listed snapshot needs a readmission and a receipt."""
    marker = source_dir / 'QUARANTINE.json'
    listed = json.loads(marker.read_text()).get('snapshots', []) if marker.is_file() else []
    if meta['snapshot_id'] not in listed:
        return True
    readmission = source_dir / (meta['snapshot_id'] + '.readmitted.json')
    if not readmission.is_file():
        return False
    value = json.loads(readmission.read_text())
    if (value.get('snapshot_id'), value.get('sha256'), value.get('bytes')) != (meta['snapshot_id'], meta['sha256'], meta['bytes']):
        return False
    receipt = Path(str(value.get('admissionReceipt', '')))
    if not receipt.is_absolute() or not receipt.is_file() or sha(receipt.read_bytes()) != value.get('admissionReceiptSha256'):
        return False
    hosts = json.loads(receipt.read_text()).get('hosts', [])
    return any(h.get('host') == 'www.cms.gov' and h.get('state') == 'allowed' for h in hosts)


def cached_sbe_bundle(cache):
    """The hash-verified, admitted CMS NY SBE bundle from the fetch cache. Never downloads."""
    source_dir = cache / 'raw' / SBE_SOURCE_DIR
    found = {}
    for meta_path in sorted(source_dir.glob('*.meta.json')) if source_dir.is_dir() else []:
        meta = json.loads(meta_path.read_text())
        if meta.get('url') != SBE_NY_URL:
            continue
        payload = source_dir / meta['sha256'] / 'payload'
        if payload.is_file() and sha(payload.read_bytes()) == meta['sha256'] and payload.stat().st_size == meta['bytes'] \
                and admitted_snapshot(source_dir, meta):
            found[meta['sha256']] = (payload, meta)
    if len(found) != 1:
        raise ValueError('Rate source override needs exactly one admitted cached CMS NY SBE bundle')
    return next(iter(found.values()))


def sbe_rate_rows(path):
    """(member, member sha256, {(plan, region): (row, cells)}) for the bundle's annual family-tier rows."""
    with zipfile.ZipFile(path) as z:
        members = [n for n in z.namelist() if SBE_RATES_MEMBER.fullmatch(n)]
        if len(members) != 1:
            raise ValueError('SBE bundle must hold exactly one NY rates CSV')
        data = z.read(members[0])
    import csv
    reader = csv.reader(io.StringIO(data.decode('utf-8-sig'), newline=''))
    header = next(reader)
    rows, line = {}, reader.line_num
    for values in reader:
        start, line = line + 1, reader.line_num
        if len(values) != len(header):
            raise ValueError('SBE rate row has the wrong number of fields')
        cells = dict(zip(header, values))
        if cells['AGE'] != '' or (cells['RATE EFFECTIVE DATE'], cells['RATE EXPIRATION']) != ('2026-01-01', '2026-12-31'):
            continue
        if (cells['BUSINESS YEAR'], cells['STATE CODE']) != ('2026', 'NY'):
            raise ValueError('Unexpected SBE rate row scope')
        key = (cells['PLAN ID'], cells['RATING AREA ID'])
        if key in rows:
            raise ValueError('Duplicate SBE annual family-tier rate row')
        rows[key] = (start, cells)
    return members[0], sha(data), rows


def cents(value):
    number = Decimal(value)
    rounded = number.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
    if number <= 0 or abs(number - rounded) > Decimal('0.000001'):
        raise ValueError('Rate cell is not positive whole cents')
    return rounded


def published_cents(value):
    try:
        return cents(value)
    except (ArithmeticError, ValueError):
        return None


def sbe_prices(cells):
    """Community tiers from one SBE row, or None when its dependent columns differ."""
    values = {column: published_cents(cells[name]) for column, name in SBE_TIERS}
    if None in values.values() or len({values[c] for c in ('7', '8', '9')}) != 1 or len({values[c] for c in ('10', '11', '12')}) != 1:
        return None
    return dict(single=str(values['4']), couple=str(values['6']), adult_children=str(values['7']), family=str(values['10']))


def sbe_cross_check(sources, rows):
    """Every admitted DFS rate the SBE file also lists must equal it to the cent, in all eight cells."""
    per_issuer, mismatches, compared = {}, [], 0
    for source in sources:
        for record in source['records']:
            per_issuer.setdefault(record['issuer'], 0)
            found = rows.get((record['plan_id'], record['region']))
            if not found:
                continue
            compared += 1
            per_issuer[record['issuer']] += 1
            for column, name in SBE_TIERS:
                if cents(record['raw'][column]) != published_cents(found[1][name]):
                    mismatches.append(dict(plan_id=record['plan_id'], region=record['region'], column=name))
    return dict(rule=CROSS_CHECK_RULE, compared_keys=compared, compared_cells=compared * len(SBE_TIERS),
                matched_cells=compared * len(SBE_TIERS) - len(mismatches), issuers=dict(sorted(per_issuer.items()))), mismatches


def override_template(issuer, checks, sources):
    """The issuer's refused DFS template check. An override is allowed for nothing else."""
    check = next((c for c in checks if issuer in c['issuer_ids']), None)
    if check is None or check['decision'] != 'refused' or any(r['issuer'] == issuer for s in sources for r in s['records']):
        raise ValueError(f'Rate source override refused for {issuer}: its DFS template was not refused')
    return check


def apply_rate_source_overrides(overrides, sources, checks, cache):
    """The override block for the artifact. Raises instead of overriding when a guard fails."""
    templates = {issuer: override_template(issuer, checks, sources) for issuer in overrides}
    path, meta = cached_sbe_bundle(cache)
    member, member_sha, rows = sbe_rate_rows(path)
    cross_check, mismatches = sbe_cross_check(sources, rows)
    if mismatches or not cross_check['compared_keys'] or not all(cross_check['issuers'].values()):
        raise ValueError('Rate source override refused: SBE rates do not match the admitted DFS rates to the cent')
    issuers = []
    for issuer in overrides:
        check = templates[issuer]
        records, unknown = [], []
        for plan in check.get('listed_plans', []):
            if not plan['plan_id'].startswith(issuer):
                continue
            found = rows.get((plan['plan_id'], plan['region']))
            prices = sbe_prices(found[1]) if found else None
            if prices is None:
                unknown.append(dict(**plan, reason='sbe_rate_row_missing' if not found else 'sbe_tier_columns_non_uniform'))
                continue
            line, cells = found
            records.append(dict(plan_id=plan['plan_id'], issuer=issuer, region=plan['region'], prices=prices,
                                child_only='No', metal=None, exchange='unknown',
                                source_record=f'{member}!row={line}', raw=cells))
        issuers.append(dict(issuer=issuer, source=overrides[issuer],
                            refused_template=dict(url=check['url'], sha256=check['sha256'], reason=check['reason']),
                            quality_note=OVERRIDE_NOTE.format(reason=check['reason']),
                            records=records, unknown_plans=unknown))
    publication = dict(url=meta['url'], sha256=meta['sha256'], bytes=meta['bytes'], retrieved_at=meta['fetched_at'],
                       content_type=meta.get('content_type'), raw_path=str(path), member=member, member_sha256=member_sha)
    return dict(rule=OVERRIDE_RULE, source='cms-sbe', publication=publication, cross_check=cross_check, issuers=issuers)


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
    parser.add_argument('--cache-only', action='store_true', help='never download; fail when a publication is not cached')
    parser.add_argument('--config', default=os.environ.get('OPENPLANS_CONFIG'),
                        help='operator configuration file; only ny.rateSourceOverrides is read (default: $OPENPLANS_CONFIG)')
    args = parser.parse_args()
    overrides = rate_source_overrides(args.config) if args.state == 'NY' else {}
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
        path, metadata = cached_download(url, cache, args.cache_only)
        rows = ny_records(path) if args.state == 'NY' else vt_records(path)
        source = dict(**metadata, raw_path=str(path), records=rows)
        if args.state != 'NY':
            return source, None
        final_url = url.replace('/45010883/', '/45010894/').replace('_ApprRatesTemplate', '_FinalExhibits')
        return source, template_check(url, path, metadata, cached_publication(final_url, cache), rows)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        prepared = list(pool.map(prepare, urls))
    sources = [source for source, check in prepared if check is None or check['decision'] == 'admitted']
    value = dict(schema_version='state-rates-v1', state=args.state, plan_year=2026, sources=sources)
    if args.state == 'NY':
        value['template_checks'] = [check for _, check in prepared]
    if overrides:
        value['rate_source_overrides'] = apply_rate_source_overrides(overrides, sources, value['template_checks'], cache)
    out = cache / 'derived' / 'state-rating' / f'{args.state.lower()}-2026.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(value, indent=2) + '\n')
    overridden = sum(len(i['records']) for i in value.get('rate_source_overrides', {}).get('issuers', []))
    print(json.dumps(dict(state=args.state, records=sum(len(s['records']) for s in sources), artifact=str(out),
                          **(dict(override_records=overridden) if overrides else {}))))
    if args.fixtures:
        # The public fixture is a cut of DFS-filed rows only.
        value.pop('rate_source_overrides', None)
        if args.state == 'NY':
            sources = [s for s in sources if 'MetroPlus' in s['url']]
            sources[0]['records'] = [r for r in sources[0]['records'] if r['plan_id'] in ['11177NY0010001', '11177NY0010002', '11177NY0220001']]
            value['template_checks'] = [c for c in value['template_checks'] if c['url'] == sources[0]['url']]
        else:
            sources[0]['records'] = [r for r in sources[0]['records'] if r['plan_name'] in ['Gold Plan', 'MVP VT Gold 1']]
        value['sources'] = sources
        for source in sources:
            source.pop('raw_path')
        fixture = Path(__file__).resolve().parents[3] / 'tests' / 'fixtures' / 'state' / f'{args.state.lower()}-2026.json'
        fixture.write_text(json.dumps(value, indent=2) + '\n')


if __name__ == '__main__':
    main()
