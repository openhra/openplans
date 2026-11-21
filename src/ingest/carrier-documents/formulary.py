#!/usr/bin/env python3
"""Recover drug rows from the text layer of a formulary (drug list) PDF.

Reads `pdftotext -layout` output of the common three-column table:

    <drug name>                     <tier digit>   <requirements: PA, ST, QL (...), AGE, ...>
         <wrapped name, hanging indent>            <wrapped requirement text>

Rules:
- Pages are split on the form feed pdftotext writes after each page (see poppler.split_pages).
- A row is `name  tier  [flags]` with two or more spaces between cells. A following line whose
  text starts right of the row's name column continues it: text left of the tier column joins the
  name, text from the tier column on joins the requirements. A wrap never crosses a page break.
- Upper-case lines at the name column are category headings; page footers, the table header and
  legend lines are skipped.
- The legend is read from the document itself: `Tier n - label` gives the tiers and their labels,
  `PA - Prior authorization` style entries give the flag tokens. Only tokens in KNOWN_FLAGS that the
  document's legend defines are flags; any other upper-case token is not.
- A tier the legend does not define is admitted only when the document's own text states it: a
  heading, footnote or legend line (never a drug row or its wrapped requirement text) that names
  the tier as `Tier n` and says what it costs (`$0`, `no cost`, `zero cost`, `no charge` or
  `preventive`), or a tiering-table row `n    $0 Preventive Drugs`. The first such line is kept
  as `legend.stated_tiers[n]` with its page, line and raw text. A `$0 copay` note on a drug row
  says what that drug costs, not what the tier is, so it never defines a tier.
- Every row carries its page, line number, raw lines and a confidence label:
  low     the name is a fragment (under four characters, or digits and punctuation only), or the
          tier is not in the legend;
  medium  the row absorbed more than three lines, its requirement text has no legend token, it
          holds an upper-case token the legend does not define, or the document has no tier legend;
  high    otherwise.
  Only `high` rows may be served; the rest are kept for review and served as unknown.

Usage: python3 formulary.py <file.pdf | layout.txt> [--tiers 1-5] [--feed]   (prints JSON)

`--feed` reads the source as a PDF whatever its name, and adds the cover (cover.py: printed plan year and plan list) and the
SHA-256 of the PDF bytes, as the carrier-document feed source reads them.
"""
import argparse
import collections
import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from poppler import layout_text, split_pages  # noqa: E402

# Requirement tokens the parser can recognise, when the document's legend defines them.
KNOWN_FLAGS = ('PA', 'ST', 'QL', 'AGE', 'GNDR', 'OTC', 'SP', 'LD')

ROW = re.compile(r'^(?P<indent> *)(?P<name>\S(?:.*?\S)?) {2,}(?P<tier>\d{1,2})(?: {2,}(?P<flags>\S.*?))?\s*$')
SEGMENT = re.compile(r'\S+(?: \S+)*')  # text runs separated by two or more spaces
# `Tier 3 - Preferred brand`, `Tier 3: Preferred brand`, or a tiering table row `Tier 3    Preferred brand`.
# `Tier` and its number are one cell (at most one space apart), so a cell ending in `Tier` is not one.
TIER_LEGEND = re.compile(r'\bTier ?(\d{1,2})(?:\s*[-=:]\s*|\s{2,})([A-Z]\S*(?: \S+)*?)(?=\s+Tier\s+\d{1,2}\s*[-=:]|\s{2,}|$)')
# A tiering table that names tiers by number alone, below a "Drug Tiering" heading on the same page:
# `Lowest Cost-Sharing Tier      1      Preferred Generic Drugs`.
TIER_TABLE_HEADING = re.compile(r'\bDrug\s+Tiering\b', re.I)
TIER_TABLE_ROW = re.compile(r'^\s*(?:\S.*?\s{2,})?(\d{1,2})\s{2,}([A-Z][A-Za-z/&,() -]*?[A-Za-z)])\s*$')
# Statements that define a tier the legend left out (see the module notes): the cost words, a
# `Tier n` mention, and a tiering-table row whose label starts with a cost (`0    $0 Preventive`).
COST_STATEMENT = re.compile(r'\$0(?:\.00)?(?![\d.,])|\b(?:no|zero)[- ]cost\b|\bno charge\b|\bpreventive\b', re.I)
TIER_MENTION = re.compile(r'\btier\s*(\d{1,2})\b', re.I)
STATED_TABLE_ROW = re.compile(r'^\s*(?:\S.*?\s{2,})?(\d{1,2})\s{2,}(\S.*?)\s*$')
# `PA - Prior authorization` or `PA: Prior Authorization.`
FLAG_LEGEND = re.compile(r'(?<![A-Za-z])([A-Z]{2,5})(?:\s+[-=]|\s*:)\s+([A-Z][a-z].*?)(?=\s+[A-Z]{2,5}(?:\s+[-=]|\s*:)\s+[A-Z][a-z]|\s{2,}|$)')
TOKEN = re.compile(r'(?<![A-Za-z])[A-Z]{2,5}(?![A-Za-z])')
QL_TEXT = re.compile(r'QL\s*\(([^)]*)\)')
TABLE_HEADER = re.compile(r'^\s*Drug\s+Name\b', re.I)
FOOTER = re.compile(r'^\s*(Page\s+\d+(\s+of\s+\d+)?|Last\s+updated\b.*|Updated\s+\d.*|Effective\s+\d.*)\s*$', re.I)


def read_legend(pages):
    """Tiers {n: label}, flags {token: meaning} for KNOWN_FLAGS, other {token: meaning}, and the
    positions {(page index, line index)} of tiering-table rows, which are legend text, not drugs."""
    tiers, flags, other, positions, table_statements = {}, {}, {}, set(), []
    for page_index, lines in enumerate(pages):
        in_tier_table = False
        for line_index, line in enumerate(lines):
            if TIER_TABLE_HEADING.search(line):
                in_tier_table = True
                continue
            table_row = TIER_TABLE_ROW.match(line) if in_tier_table else None
            if table_row:
                tiers.setdefault(int(table_row.group(1)), table_row.group(2).strip())
                positions.add((page_index, line_index))
                continue
            stated_row = STATED_TABLE_ROW.match(line) if in_tier_table else None
            if stated_row and COST_STATEMENT.search(stated_row.group(2)):
                table_statements.append((page_index, line_index, int(stated_row.group(1)), stated_row.group(2)))
                positions.add((page_index, line_index))
                continue
            for m in TIER_LEGEND.finditer(line):
                tiers.setdefault(int(m.group(1)), m.group(2).strip())
            for m in FLAG_LEGEND.finditer(line):
                token, meaning = m.group(1), m.group(2).strip()
                if token == 'TIER':
                    continue
                (flags if token in KNOWN_FLAGS else other).setdefault(token, meaning)
    return dict(tiers=tiers, flags=flags, other=other, positions=positions, table_statements=table_statements)


def stated_tiers(text_lines, legend):
    """{tier: {label, page, line, raw}} for tiers the legend does not define but the document's own
    text states. `text_lines` are (page, line, text) of lines that are not drug rows or their wraps."""
    stated = {}
    table = {(page + 1, line + 1): (tier, label) for page, line, tier, label in legend['table_statements']}
    for page, line, text in text_lines:
        found = []
        if (page, line) in table:
            found.append(table[(page, line)])
        elif COST_STATEMENT.search(text):
            found += [(int(m.group(1)), text.strip()) for m in TIER_MENTION.finditer(text)]
        for tier, label in found:
            if tier not in legend['tiers'] and tier not in stated:
                stated[tier] = dict(label=label.strip(), page=page, line=line, raw=text.strip())
    return stated


def is_legend_line(line):
    """A legend line, not a drug row. A line holding two or more flag definitions is legend text
    even when it ends in a number (a page footer such as `PA - Prior authorization  QL -   7`)."""
    if len(FLAG_LEGEND.findall(line)) >= 2:
        return True
    return bool(TIER_LEGEND.search(line) or FLAG_LEGEND.search(line)) and not ROW.match(line)


def _segments(line):
    return [(m.start(), m.group()) for m in SEGMENT.finditer(line)]


def _continue_row(row, line):
    """Join a wrapped line to the row when its text sits right of the name column; else False."""
    segments = _segments(line)
    if not segments or segments[0][0] <= row['columns']['name']:
        return False
    tier_col = row['columns']['tier']
    name_parts = [text for start, text in segments if start < tier_col]
    flag_parts = [text for start, text in segments if start >= tier_col]
    if name_parts:
        row['name'] = row['name'] + ' ' + ' '.join(name_parts)
    if flag_parts:
        row['flags_text'] = (row['flags_text'] + ' ' + ' '.join(flag_parts)).strip()
    return True


def _confidence(row, legend, allowed_tiers):
    low, medium = [], []
    name = row['name']
    if len(name) < 4 or re.fullmatch(r'[\d\W]+', name):
        low.append('name_fragment')
    if not allowed_tiers:
        medium.append('no_tier_legend')
    elif row['tier'] not in allowed_tiers:
        low.append('tier_not_in_legend')
    if len(row['raw']) > 3:
        medium.append('long_wrap')
    text = QL_TEXT.sub('QL', row['flags_text'])
    tokens = TOKEN.findall(text)
    if row['flags_text'] and not row['flags']:
        medium.append('requirements_without_legend_token')
    if any(t not in legend['flags'] for t in tokens):
        medium.append('token_not_in_legend')
    row['reasons'] = low + medium
    return 'low' if low else 'medium' if medium else 'high'


def parse(text, tiers=None):
    """Parse `pdftotext -layout` text. `tiers` (a set) is used only when the legend names no tiers."""
    pages = split_pages(text)
    legend = read_legend(pages)
    rows, headings, skipped, text_lines = [], 0, collections.Counter(), []
    for page_number, lines in enumerate(pages, 1):
        current, category = None, None  # a wrap never crosses a page break
        for line_number, raw in enumerate(lines, 1):
            line = raw.rstrip()
            if not line.strip():
                continue
            if TABLE_HEADER.match(line) or FOOTER.match(line):
                skipped['header_footer'] += 1
                current = None
                continue
            if is_legend_line(line) or (page_number - 1, line_number - 1) in legend['positions']:
                skipped['legend'] += 1
                text_lines.append((page_number, line_number, line))
                current = None
                continue
            m = ROW.match(line)
            if m:
                current = dict(page=page_number, line=line_number, category=category, name=m.group('name'),
                               tier=int(m.group('tier')), flags_text=(m.group('flags') or '').strip(), raw=[line],
                               columns=dict(name=len(m.group('indent')), tier=m.start('tier')))
                rows.append(current)
                continue
            if current is not None and _continue_row(current, line):
                current['raw'].append(line)
                continue
            stripped = line.strip()
            text_lines.append((page_number, line_number, line))
            if stripped.isupper() and len(stripped) < 80:
                headings += 1
                category = stripped
            else:
                skipped['unmatched'] += 1
            current = None
    stated = stated_tiers(text_lines, legend)
    allowed_tiers = set(legend['tiers']) | set(stated) if legend['tiers'] else set(tiers or ())
    for row in rows:
        del row['columns']
        text = QL_TEXT.sub('QL', row['flags_text'])
        row['flags'] = sorted({t for t in TOKEN.findall(text) if t in legend['flags']})
        row['ql_text'] = '; '.join(q.strip() for q in QL_TEXT.findall(row['flags_text']))
        row['tier_label'] = legend['tiers'].get(row['tier']) or stated.get(row['tier'], {}).get('label')
        row['confidence'] = _confidence(row, legend, allowed_tiers)
    legend = {key: value for key, value in legend.items() if key not in ('positions', 'table_statements')}
    legend['stated_tiers'] = stated
    return dict(pages=len(pages), legend=legend, rows=rows, headings=headings, skipped=dict(skipped))


def round_trips(result):
    """Document-level checks; a non-empty list means the extraction must not be activated."""
    failures = []
    legend_tiers = set(result['legend']['tiers'])
    if not legend_tiers:
        failures.append('no tier legend in the document')
    admitted = legend_tiers | set(result['legend'].get('stated_tiers', {}))
    histogram = collections.Counter(r['tier'] for r in result['rows'])
    outside = sorted(t for t in histogram if t not in admitted)
    if outside:
        failures.append('tiers outside the legend: %s' % outside)
    ql_rows = sum(1 for r in result['rows'] if 'QL' in r['flags'])
    ql_texts = sum(1 for r in result['rows'] if r['ql_text'])
    if ql_rows < ql_texts:
        failures.append('QL text on %d rows but QL flag on %d' % (ql_texts, ql_rows))
    return failures


def summary(result):
    rows = result['rows']
    return dict(pages=result['pages'], rows=len(rows), headings=result['headings'], skipped=result['skipped'],
                tiers=dict(sorted(collections.Counter(r['tier'] for r in rows).items())),
                confidence=dict(collections.Counter(r['confidence'] for r in rows)),
                round_trip_failures=round_trips(result))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source', help='a PDF, or text already produced by pdftotext -layout')
    ap.add_argument('--tiers', help='tier range such as 1-5, used only when the legend names no tiers')
    ap.add_argument('--feed', action='store_true', help='read the source as a PDF; add its cover and SHA-256')
    a = ap.parse_args()
    source = Path(a.source)
    # The feed passes cached payloads, which have no .pdf suffix; --feed always reads a PDF.
    is_pdf = a.feed or source.suffix.lower() == '.pdf'
    text = layout_text(source) if is_pdf else source.read_text(errors='replace')
    tiers = None
    if a.tiers:
        lo, hi = (int(x) for x in a.tiers.split('-'))
        tiers = set(range(lo, hi + 1))
    result = parse(text, tiers)
    output = dict(summary=summary(result), legend=result['legend'], rows=result['rows'])
    if a.feed:
        from cover import read_cover
        output['cover'] = read_cover(source)
        output['sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    print(json.dumps(output, indent=None if a.feed else 1))


if __name__ == '__main__':
    main()
