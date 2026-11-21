#!/usr/bin/env python3
"""Rebuild the federal Summary of Benefits and Coverage (SBC) tables from word coordinates.

`pdftotext -layout` interleaves the wrapped, vertically centred cells of neighbouring rows, so a
line-based parser loses rows. This reads `pdftotext -bbox-layout` output (a box per word) instead:

- Columns: the chart header words ("Common Medical Event", "Services You May Need", "Network
  Provider", "Out-of-Network Provider", "Limitations, Exceptions, ...") are centred in their cells,
  so the column cuts sit at the midpoints between neighbouring header centres.
- Rows: the "Services You May Need" column holds the template's fixed service labels (a closed list
  set by the federal template). Label lines are grouped into labels; each row runs from the cut
  above its label to the cut below it. Between two labels the cut sits in the largest empty
  vertical gap of the other columns' words, or at the midpoint between the labels when that band
  is empty. Every word belongs to the row that contains its vertical centre.
- Confidence: `high` only when the label matched the template exactly and the network cell holds a
  dollar amount, a percentage, "No charge" or "Not covered"; `low` when the label did not match or
  the network cell is empty; `medium` otherwise. A cell that is not centred on its label and
  reaches above or below it may hold a neighbour's text (a boundary bleed): that row, and the
  neighbour it reaches towards, drop to `medium`.
- Tolerant labels: a closed set of carrier spellings is accepted besides the template's own. A
  "(Tier n)" suffix is dropped ("Generic drugs (Tier 1)"), and "Preferred generic" and
  "Non-preferred generic" (with or without "drugs") are sub-rows of "Generic drugs": such a row
  keeps the template label with the carrier's wording in `sub_label`. `match` says which rule
  matched (`exact`, `tier_suffix`, `sub_row`). Nothing else is accepted.
- The chart ends on the last page that holds a template label: a following page with none (the
  coverage examples, the language notices) is not read as chart rows.
- Every row carries its page, its vertical band and its raw lines.

The "Important Questions" table (deductible, out-of-pocket limit, ...) is read the same way, except
that its columns are left-aligned under their headers: each column cut sits in the widest band
between one header's centre and the next header's left edge that no word crosses.

The header gives the coverage period ("Coverage Period: 01/01/2026-12/31/2026") and the plan name
printed after the issuer ("Issuer: Plan name", with its parenthetical notes on the next line).
The plan year is the coverage period's year, and only when the period starts and ends in the same
year; otherwise it is null and the feed refuses the document.

Usage: python3 sbc.py <file.pdf | file.bbox.html> [--feed]   (prints JSON)

`--feed` reads the source as a PDF whatever its name and adds the header and the SHA-256 of the PDF
bytes, as the carrier-document feed source reads them.
"""
import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from poppler import bbox_xhtml, layout_text, split_pages  # noqa: E402

NS = '{http://www.w3.org/1999/xhtml}'
# Service labels and questions of the federal SBC template.
SERVICES = (
    'Primary care visit to treat an injury or illness', 'Specialist visit', 'Preventive care/screening/immunization',
    'Diagnostic test (x-ray, blood work)', 'Imaging (CT/PET scans, MRIs)',
    'Generic drugs', 'Preferred brand drugs', 'Non-preferred brand drugs', 'Specialty drugs',
    'Facility fee (e.g., ambulatory surgery center)', 'Physician/surgeon fees', 'Emergency room care',
    'Emergency medical transportation', 'Urgent care', 'Facility fee (e.g., hospital room)',
    'Outpatient services', 'Inpatient services', 'Office visits', 'Childbirth/delivery professional services',
    'Childbirth/delivery facility services', 'Home health care', 'Rehabilitation services', 'Habilitation services',
    'Skilled nursing care', 'Durable medical equipment', 'Hospice services',
    "Children's eye exam", "Children's glasses", "Children's dental check-up",
)
QUESTIONS = (
    'What is the overall deductible?', 'Are there services covered before you meet your deductible?',
    'Are there other deductibles for specific services?', 'What is the out-of-pocket limit for this plan?',
    'What is not included in the out-of-pocket limit?', 'Will you pay less if you use a network provider?',
    'Do you need a referral to see a specialist?',
)
CHART_CELLS = ('network', 'out_of_network', 'limitations')
# Carrier spellings accepted besides the template labels: (spelling, template label, sub-row label).
SUB_ROWS = (
    ('Preferred generic', 'Generic drugs', 'Preferred generic'),
    ('Preferred generic drugs', 'Generic drugs', 'Preferred generic'),
    ('Non-preferred generic', 'Generic drugs', 'Non-preferred generic'),
    ('Non-preferred generic drugs', 'Generic drugs', 'Non-preferred generic'),
)
TIER_SUFFIX = re.compile(r'\s*\(\s*tier\s*\d{1,2}[a-z]?\s*\)', re.I)
# An unfinished "(Tier n)" at the end of a wrapped label line: the rest is on the next line.
OPEN_TIER_SUFFIX = re.compile(r'\s*\(\s*(?:t(?:i(?:e(?:r\s*\d{0,2}[a-z]?)?)?)?)?\s*$', re.I)
PERIOD = re.compile(r'Coverage\s+Period:?\s*(\d{1,2})/(\d{1,2})/(\d{4})\s*[-\u2013\u2014]+\s*(\d{1,2})/(\d{1,2})/(\d{4})', re.I)
MONEY = re.compile(r'\$[\d,]+(?:\.\d\d)?')
PERCENT = re.compile(r'\d+(?:\.\d+)?%')
SETTLED = re.compile(r'\bno charge\b|\bnot covered\b', re.I)
LINE_TOLERANCE = 2.5  # words whose tops differ by less than this share a line
OFF_CENTRE = 4.0  # a cell centred this far from its label's centre is not centred on it


def norm(text):
    return re.sub(r'[^a-z0-9]+', '', text.lower().replace('’', "'"))


def words_by_page(xhtml):
    """Pages as dicts: width, height, words [{x0, y0, x1, y1, text}] (y grows downwards)."""
    root = ET.fromstring(re.sub(r'<!DOCTYPE[^>]*>', '', xhtml, count=1))
    pages = []
    for page in root.iter(NS + 'page'):
        words = [dict(x0=float(w.get('xMin')), y0=float(w.get('yMin')), x1=float(w.get('xMax')),
                      y1=float(w.get('yMax')), text=(w.text or '').strip()) for w in page.iter(NS + 'word')]
        pages.append(dict(width=float(page.get('width')), height=float(page.get('height')), words=words))
    return pages


def find_phrase(words, phrase, near_y=None, tolerance=14.0):
    """Box (x0, y0, x1, y1) of the first run of words on one line spelling `phrase`, or None."""
    tokens = [norm(t) for t in phrase.split()]
    ordered = sorted(words, key=lambda w: (round(w['y0'] / 3), w['x0']))
    for i in range(len(ordered) - len(tokens) + 1):
        run = ordered[i:i + len(tokens)]
        if near_y is not None and abs(run[0]['y0'] - near_y) > tolerance:
            continue
        if all(norm(run[j]['text']).startswith(tokens[j]) and abs(run[j]['y0'] - run[0]['y0']) < 3
               for j in range(len(tokens))):
            return (run[0]['x0'], run[0]['y0'], run[-1]['x1'], max(w['y1'] for w in run))
    return None


def centre(box):
    return (box[0] + box[2]) / 2


def find_chart_header(words):
    """Header boxes of the cost-sharing chart, all on the header line, or None."""
    event = find_phrase(words, 'Common Medical')
    if event is None:
        return None
    y = event[1]
    service = find_phrase(words, 'Services You May', y)
    network = find_phrase(words, 'Network Provider', y)
    out_of_network = find_phrase(words, 'Out-of-Network Provider', y) or find_phrase(words, 'Out-of-Network', y)
    limitations = find_phrase(words, 'Limitations', y)
    if not (service and network and out_of_network):
        return None
    return dict(event=event, service=service, network=network, out_of_network=out_of_network,
                limitations=limitations)


def column_cuts(header, page_width):
    """x cuts between chart columns: the midpoints between neighbouring header centres."""
    centres = [centre(header[k]) for k in ('event', 'service', 'network', 'out_of_network')]
    centres.append(centre(header['limitations']) if header['limitations'] else page_width)
    return dict(service=(centres[0] + centres[1]) / 2, network=(centres[1] + centres[2]) / 2,
                out_of_network=(centres[2] + centres[3]) / 2, limitations=(centres[3] + centres[4]) / 2)


def _in_box(word, x_from, x_to, y_from, y_to):
    cx, cy = (word['x0'] + word['x1']) / 2, (word['y0'] + word['y1']) / 2
    return x_from <= cx < x_to and y_from <= cy < y_to


def group_lines(words):
    """Group words into lines by their tops; each line {y0, y1, x0, words, text}."""
    lines = []
    for w in sorted(words, key=lambda w: (w['y0'], w['x0'])):
        for line in lines:
            if abs(line['y0'] - w['y0']) < LINE_TOLERANCE:
                line['words'].append(w)
                break
        else:
            lines.append(dict(y0=w['y0'], words=[w]))
    for line in lines:
        line['words'].sort(key=lambda w: w['x0'])
        line['y1'] = max(w['y1'] for w in line['words'])
        line['x0'] = line['words'][0]['x0']
        line['text'] = ' '.join(w['text'] for w in line['words'])
    return sorted(lines, key=lambda l: l['y0'])


def cell_lines(words, x_from, x_to, y_from, y_to):
    return group_lines([w for w in words if _in_box(w, x_from, x_to, y_from, y_to)])


def spellings(labels, tolerant):
    """(spelling, label, sub_label, match) for every accepted way of printing a label."""
    out = [(L, L, None, 'exact') for L in labels]
    if tolerant:
        out += [(text, label, sub, 'sub_row') for text, label, sub in SUB_ROWS if label in labels]
    return out


def read_label(text, accepted, closing=False):
    """(exact spellings, candidate spellings) for label-column text read so far.

    A complete "(Tier n)" suffix is dropped before comparing (match `tier_suffix`); an unfinished
    one at the end means the label may continue on the next line, so the text is only a prefix
    until the block is `closing` (its tier number fell outside the label column).
    """
    tolerant = any(match != 'exact' for *_, match in accepted)
    key, open_suffix, stripped = text, False, False
    if tolerant:
        key = TIER_SUFFIX.sub('', text)
        stripped = key != text
        if OPEN_TIER_SUFFIX.search(key) and re.search(r'\(', key[-12:]):
            key, open_suffix = OPEN_TIER_SUFFIX.sub('', key), True
    n = norm(key)
    candidates = [a for a in accepted if norm(a[0]).startswith(n)]
    exact = [] if open_suffix and not closing else [a for a in accepted if norm(a[0]) == n]
    if stripped or open_suffix:
        exact = [(t, label, sub, 'tier_suffix' if match == 'exact' else match) for t, label, sub, match in exact]
    return exact, candidates


def label_blocks(lines, labels, tolerant=False):
    """Group consecutive label-column lines into labels from the closed list.

    Returns blocks {label, sub_label, match, text, matched, y0, y1}; text that is no accepted
    spelling becomes an unmatched block. `tolerant` accepts the carrier spellings (SUB_ROWS and
    "(Tier n)" suffixes).
    """
    accepted = spellings(labels, tolerant)
    blocks, buf, i = [], [], 0

    def close(part, found):
        text = ' '.join(l['text'] for l in part)
        _, label, sub, match = found[0] if found else (None, None, None, None)
        blocks.append(dict(label=label, sub_label=sub, match=match, text=text, matched=bool(found),
                           y0=part[0]['y0'], y1=part[-1]['y1']))

    while i < len(lines):
        buf.append(lines[i])
        text = ' '.join(l['text'] for l in buf)
        exact, candidates = read_label(text, accepted)
        if exact and len(candidates) == 1:
            close(buf, exact)
            buf = []
        elif not candidates:
            if len(buf) > 1:
                # the earlier lines formed something unmatched; close them and retry this line alone
                prev = buf[:-1]
                close(prev, read_label(' '.join(l['text'] for l in prev), accepted, closing=True)[0])
                buf = []
                continue
            close(buf, [])
            buf = []
        i += 1
    if buf:
        close(buf, read_label(' '.join(l['text'] for l in buf), accepted, closing=True)[0])
    return blocks


def row_cut(upper, lower, value_words):
    """y cut between two label blocks: the centre of the largest empty gap between them."""
    start, end = upper['y1'], lower['y0']
    if end <= start:
        return (start + end) / 2
    spans = sorted((max(w['y0'], start), min(w['y1'], end)) for w in value_words
                   if w['y1'] > start and w['y0'] < end)
    best, cursor = None, start
    for top, bottom in spans + [(end, end)]:
        if top > cursor and (best is None or top - cursor > best[1] - best[0]):
            best = (cursor, top)
        cursor = max(cursor, bottom)
    return (best[0] + best[1]) / 2 if best else (start + end) / 2


def build_rows(blocks, words, cuts, top, bottom, value_x, cell_names):
    """One row per label block. `cuts` are the x cuts: value cell k spans cuts[k]..cuts[k + 1]."""
    value_words = [w for w in words if (w['x0'] + w['x1']) / 2 >= value_x]
    edges = [top] + [row_cut(blocks[i], blocks[i + 1], value_words) for i in range(len(blocks) - 1)] + [bottom]
    rows = []
    for i, block in enumerate(blocks):
        y_from, y_to = edges[i], edges[i + 1]
        row = dict(label=block['label'], sub_label=block.get('sub_label'), match=block.get('match'),
                   label_text=block['text'], matched=block['matched'], y=[round(y_from, 1), round(y_to, 1)],
                   cells={})
        for name, x_from, x_to in zip(cell_names, cuts, cuts[1:]):
            lines = cell_lines(words, x_from, x_to, y_from, y_to)
            row[name] = ' '.join(l['text'] for l in lines)
            row['cells'][name] = lines
        row['raw'] = [_raw_text(l) for l in group_lines([w for w in words if _in_box(w, 0, 1e9, y_from, y_to)])]
        row['_block'] = block
        rows.append(row)
    return rows


def _raw_text(line):
    out, last = '', None
    for w in line['words']:
        if last is not None:
            out += '   ' if w['x0'] - last > 10 else ' '
        out += w['text']
        last = w['x1']
    return out


def mark_bleeds(rows, cell_names):
    """Flag cells not centred on their label that reach past it, and the neighbour they reach."""
    for i, row in enumerate(rows):
        block = row['_block']
        label_centre = (block['y0'] + block['y1']) / 2
        for name in cell_names:
            lines = row['cells'][name]
            if not lines:
                continue
            y0, y1 = lines[0]['y0'], lines[-1]['y1']
            if abs((y0 + y1) / 2 - label_centre) <= OFF_CENTRE:
                continue
            if y0 < block['y0'] - LINE_TOLERANCE:
                row['bleeds'].add(name)
                if i > 0:
                    rows[i - 1]['bleeds'].add(name)
            if y1 > block['y1'] + LINE_TOLERANCE:
                row['bleeds'].add(name)
                if i + 1 < len(rows):
                    rows[i + 1]['bleeds'].add(name)


def _page_bottom(page):
    bottom = page['height'] - 20
    for w in page['words']:
        if w['text'] == 'Page' and w['y0'] > page['height'] * 0.8:
            bottom = min(bottom, w['y0'] - 2)
    return bottom


def chart_confidence(row):
    reasons = []
    if not row['matched']:
        reasons.append('label_not_in_template')
    if not row['network']:
        reasons.append('network_cell_empty')
    if reasons:
        return 'low', reasons
    if row['bleeds']:
        reasons.append('boundary_bleed')
    if row.get('match') == 'tier_suffix' and re.match(r'\s*\d{1,2}[a-z]?\)', row['network']):
        reasons.append('label_suffix_in_cell')  # the label's "(Tier n)" wrapped into the value column
    if not (MONEY.search(row['network']) or PERCENT.search(row['network']) or SETTLED.search(row['network'])):
        reasons.append('network_value_not_recognised')
    return ('medium' if reasons else 'high'), reasons


def parse_chart(pages):
    out, cuts = [], None
    for page_number, page in enumerate(pages, 1):
        words = page['words']
        header = find_chart_header(words)
        if header:
            cuts = column_cuts(header, page['width'])
            # the header has a second line, "(You will pay the least)"
            top = max(header['network'][3], header['service'][3]) + 14
        elif cuts:
            top = 20  # the chart continues from an earlier page
        else:
            continue
        bottom = _page_bottom(page)
        label_lines = cell_lines(words, cuts['service'], cuts['network'], top, bottom)
        if not label_lines:
            continue
        blocks = label_blocks(label_lines, SERVICES, tolerant=True)
        if not header and not any(block['matched'] for block in blocks):
            break  # the chart ended on an earlier page
        x_cuts = [cuts['network'], cuts['out_of_network'], cuts['limitations'], page['width'] + 1]
        rows = build_rows(blocks, words, x_cuts, top, bottom, cuts['network'], CHART_CELLS)
        for row in rows:
            row['bleeds'] = set()
        mark_bleeds(rows, CHART_CELLS)
        event = None
        for row in rows:
            event_text = ' '.join(l['text'] for l in cell_lines(words, 0, cuts['service'], row['y'][0], row['y'][1]))
            event = event_text or event
            row.update(page=page_number, event=event,
                       network_amounts=MONEY.findall(row['network']),
                       network_percents=PERCENT.findall(row['network']))
            row['confidence'], row['reasons'] = chart_confidence(row)
            row['bleeds'] = sorted(row['bleeds'])
            del row['cells'], row['_block']
            out.append(row)
    return out


def gap_cut(words, lo, hi):
    """x cut between two columns: the middle of the widest band in lo..hi that no word crosses.

    The questions table's columns are left-aligned under their headers, and a long question or
    answer line reaches past the midpoint between header centres. Where every x in the range is
    crossed by some word, the x crossed by the fewest words wins (the leftmost of the widest run).
    """
    lo, hi = int(lo), int(hi)
    if hi <= lo:
        return (lo + hi) / 2
    counts = [sum(1 for w in words if w['x0'] < x < w['x1']) for x in range(lo, hi + 1)]
    least = min(counts)
    best, start = (lo, lo), None
    for offset, n in enumerate(counts + [least + 1]):
        if n == least and start is None:
            start = offset
        elif n != least and start is not None:
            if offset - start > best[1] - best[0]:
                best = (start, offset)
            start = None
    return lo + (best[0] + best[1] - 1) / 2


def parse_questions(pages):
    if not pages:
        return []
    page = pages[0]
    words = page['words']
    question = find_phrase(words, 'Important Questions')
    answer = find_phrase(words, 'Answers', question[1] if question else None)
    why = find_phrase(words, 'Why This Matters', question[1] if question else None)
    if not (question and answer and why):
        return []
    top = answer[3] + 2
    header = find_chart_header(words)
    bottom = header['event'][1] - 2 if header and header['event'][1] > top else _page_bottom(page)
    table = [w for w in words if top <= (w['y0'] + w['y1']) / 2 < bottom]
    answer_cut = gap_cut(table, centre(question), answer[0])
    why_cut = gap_cut(table, centre(answer), why[0])
    blocks = label_blocks(cell_lines(words, 0, answer_cut, top, bottom), QUESTIONS)
    rows = build_rows(blocks, words, [answer_cut, why_cut, page['width'] + 1], top, bottom, answer_cut,
                      ('answer', 'why'))
    for row in rows:
        row['page'] = 1
        row['amounts'] = MONEY.findall(row['answer'])
        row['confidence'] = 'high' if row['matched'] and row['answer'] else 'low'
        del row['cells'], row['_block']
    return rows


def parse(xhtml):
    pages = words_by_page(xhtml)
    questions = parse_questions(pages)
    chart = parse_chart(pages)
    found = {r['label'] for r in chart if r['label']}
    return dict(pages=len(pages), questions=questions, chart=chart,
                missing_services=[s for s in SERVICES if s not in found])


def read_header(page_text):
    """Coverage period and plan name from the first page's `pdftotext -layout` text.

    The template prints "Coverage Period: MM/DD/YYYY - MM/DD/YYYY" on the title line and
    "Issuer: Plan name ... Coverage for: ... | Plan Type: ..." below it, the plan's parenthetical
    notes wrapping onto the next line. Returns {coverage_period, plan_name}; either may be None.
    """
    found = PERIOD.search(page_text)
    period = None
    if found:
        m1, d1, y1, m2, d2, y2 = (int(g) for g in found.groups())
        period = dict(start='%04d-%02d-%02d' % (y1, m1, d1), end='%04d-%02d-%02d' % (y2, m2, d2),
                      plan_year=y1 if y1 == y2 else None)
    lines = page_text.split('\n')
    title = next((i for i, line in enumerate(lines) if PERIOD.search(line) or
                  re.search(r'Summary of Benefits and Coverage', line, re.I)), None)
    name_parts = []
    if title is not None:
        for line in lines[title + 1:title + 5]:
            if not line.strip():
                break
            first = re.split(r'\s{3,}', line.strip())[0]
            if re.match(r'(Coverage for|Plan Type|The Summary of Benefits)', first, re.I):
                break
            name_parts.append(first)
    name = ' '.join(name_parts).strip()
    if ':' in name:
        name = name.split(':', 1)[1]
    name = re.sub(r'\s+', ' ', name).strip(' :') or None
    return dict(coverage_period=period, plan_name=name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source', help='a PDF, or XHTML already produced by pdftotext -bbox-layout')
    ap.add_argument('--feed', action='store_true', help='read the source as a PDF; add its header and SHA-256')
    a = ap.parse_args()
    source = Path(a.source)
    is_pdf = a.feed or source.suffix.lower() == '.pdf'
    xhtml = bbox_xhtml(source) if is_pdf else source.read_text(errors='replace')
    output = parse(xhtml)
    if a.feed:
        first = split_pages(layout_text(source, last_page=1))
        output.update(read_header('\n'.join(first[0]) if first else ''))
        output['sha256'] = hashlib.sha256(source.read_bytes()).hexdigest()
    print(json.dumps(output, indent=None if a.feed else 1))


if __name__ == '__main__':
    main()
