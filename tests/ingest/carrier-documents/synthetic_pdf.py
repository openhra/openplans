"""A tiny PDF writer (Python stdlib only) for SYNTHETIC test documents.

Every document it builds is synthetic: invented drug lists and invented plan values, labelled as
test data on the page and in the document information. Nothing here comes from a real plan.

Only what the extractor tests need: Letter pages, text drawn with the standard Helvetica font
(no embedding), and optional ruled lines. Coordinates are PDF points from the bottom-left corner.

    python3 synthetic_pdf.py OUT_DIR    writes synthetic-formulary.pdf and synthetic-sbc.pdf
    python3 synthetic_pdf.py feed-formulary OUT.pdf [--year 2026] [--no-legend] [--plans 'A|B']
                                        [--tier0 undocumented|stated] [--tier0-rows N]
                                        writes a drug list with a cover, as the feed source reads it;
                                        --tier0 adds a tier 0 row, with or without a footnote
                                        stating that tier
    python3 synthetic_pdf.py feed-sbc OUT.pdf [--year 2026] [--period-year 2025] [--plan NAME]
                                        [--carrier-labels] [--value 'Label=text' ...]
                                        writes an SBC with the template header, as the feed source
                                        reads it; --period-year prints another coverage year,
                                        --carrier-labels uses "(Tier n)" labels and generic sub-rows
"""
import sys
from pathlib import Path

PAGE_WIDTH, PAGE_HEIGHT = 612, 792
TITLE = 'SYNTHETIC TEST DOCUMENT - NOT A REAL PLAN'


def _escape(text):
    return text.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)')


def _page_stream(items):
    ops = []
    for item in items:
        if item[0] == 'text':
            _, x, y, size, text = item
            ops.append('BT /F1 %s Tf %s %s Td (%s) Tj ET' % (size, x, y, _escape(text)))
        else:
            _, x0, y0, x1, y1 = item
            ops.append('0.5 w %s %s m %s %s l S' % (x0, y0, x1, y1))
    return '\n'.join(ops).encode('latin-1')


def build_pdf(pages, title='Synthetic test document'):
    """`pages` is a list of item lists: ('text', x, y, size, text) or ('line', x0, y0, x1, y1)."""
    objects = []  # bytes bodies; object number = index + 1

    def add(body):
        objects.append(body)
        return len(objects)

    font = add(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
    pages_number = len(objects) + 1 + 2 * len(pages)  # placeholder number, fixed below
    page_numbers = []
    for items in pages:
        stream = _page_stream(items)
        content = add(b'<< /Length %d >>\nstream\n' % len(stream) + stream + b'\nendstream')
        page_numbers.append(add(
            b'<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 %d 0 R >> >> '
            b'/Contents %d 0 R >>' % (pages_number, PAGE_WIDTH, PAGE_HEIGHT, font, content)))
    kids = b' '.join(b'%d 0 R' % n for n in page_numbers)
    assert add(b'<< /Type /Pages /Kids [%s] /Count %d >>' % (kids, len(page_numbers))) == pages_number
    catalog = add(b'<< /Type /Catalog /Pages %d 0 R >>' % pages_number)
    info = add(b'<< /Title (%s) /Producer (openplans synthetic test writer) >>' % _escape(title).encode('latin-1'))

    out = bytearray(b'%PDF-1.4\n')
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b'%d 0 obj\n' % number + body + b'\nendobj\n'
    xref = len(out)
    out += b'xref\n0 %d\n0000000000 65535 f \n' % (len(objects) + 1)
    for offset in offsets:
        out += b'%010d 00000 n \n' % offset
    out += b'trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (
        len(objects) + 1, catalog, info, xref)
    return bytes(out)


# Synthetic formulary: a three-column table (drug name, tier, requirements) on two pages, so the
# page split is observable. Column x positions in points.
NAME_X, TIER_X, FLAGS_X = 40, 330, 390

# (name lines, tier, flag lines). Extra name lines are wraps drawn with a hanging indent; extra flag
# lines wrap in the requirements column. Tier None draws no tier cell. All values invented.
FORMULARY_PAGE_1 = [
    ('heading', 'CARDIOVASCULAR AGENTS'),
    ('row', ['atorvastatin calcium tab 10 mg'], '1', []),
    ('row', ['lisinopril tab 20 mg'], '1', ['QL (30 per 30 days)']),
    ('row', ['sacubitril-valsartan tab 24-26 mg', 'film coated'], '3', ['PA; ST']),
    ('heading', 'ENDOCRINE AND METABOLIC AGENTS'),
    ('row', ['insulin glargine-yfgn inj 100 unit/ml', 'solution pen-injector 3 ml'], '2', ['QL (15 ml per', '30 days)']),
    ('row', ['metformin hcl er tab 500 mg'], '1', ['AGE']),
    ('row', ['semaglutide inj 2 mg/3 ml pen'], '4', ['PA; LD']),
    ('row', ['sps'], '2', []),
]
FORMULARY_PAGE_2 = [
    ('heading', 'ANTI-INFECTIVE AGENTS'),
    ('row', ['amoxicillin cap 500 mg'], '1', []),
    ('row', ['valganciclovir tab 450 mg'], '5', ['PA; QL (120 per 30 days)']),
    ('row', ['oseltamivir cap 75 mg'], '2', ['Covered for members under 19 at no cost']),
    ('row', ['nitrofurantoin cap 100 mg'], '7', []),
    ('row', ['adalimumab-adaz inj 40 mg/0.4 ml', 'prefilled syringe kit', 'two-pack', 'starter dose'], '5', ['PA']),
]
FORMULARY_LEGEND = [
    'Tier 1 - Preferred generic    Tier 2 - Generic    Tier 3 - Preferred brand',
    'Tier 4 - Non-preferred brand    Tier 5 - Specialty',
    'PA - Prior authorization    ST - Step therapy    QL - Quantity limit    AGE - Age limit',
]


def _formulary_page(rows, number, legend=True, notes=()):
    items = [('text', NAME_X, 760, 9, TITLE), ('text', NAME_X, 744, 9, 'Synthetic Drug List 2026')]
    y = 716
    items += [('text', NAME_X, y, 10, 'Drug Name'), ('text', TIER_X - 10, y, 10, 'Drug Tier'),
              ('text', FLAGS_X, y, 10, 'Requirements/Limits')]
    y -= 24
    for row in rows:
        if row[0] == 'heading':
            items.append(('text', NAME_X, y, 10, row[1]))
            y -= 16
            continue
        _, names, tier, flags = row
        items.append(('text', NAME_X, y, 10, names[0]))
        if tier is not None:
            items.append(('text', TIER_X, y, 10, tier))
        for i, extra in enumerate(names[1:], 1):
            items.append(('text', NAME_X + 24, y - 12 * i, 10, extra))
        for i, flag in enumerate(flags):
            items.append(('text', FLAGS_X, y - 12 * i, 10, flag))
        y -= 12 * max(len(names), len(flags), 1) + 6
    for i, text in enumerate(notes):
        items.append(('text', NAME_X, 100 + 12 * i, 8, text))
    for i, text in enumerate(FORMULARY_LEGEND if legend else []):
        items.append(('text', NAME_X, 80 - 12 * i, 8, text))
    items.append(('text', NAME_X, 30, 8, 'Page %d' % number))
    return items


def formulary_pdf():
    return build_pdf([_formulary_page(FORMULARY_PAGE_1, 1), _formulary_page(FORMULARY_PAGE_2, 2)],
                     'Synthetic formulary - test data')


# A drug list with a cover page, for the carrier-document feed source: the cover prints the plan
# year and a two-column bulleted plan list (one name wraps onto a second line); the table pages
# reuse the rows above without the out-of-legend tier, so the document passes its round trips
# unless the legend is left out. Plan names are invented.
FEED_PLANS = ('Synthetic Bronze', 'Synthetic Bronze Plus', 'Synthetic Silver 73',
              'Synthetic Silver Essential Plus Limited', 'Synthetic Gold', 'Synthetic Gold Plus')
FEED_PAGE_2 = [row for row in FORMULARY_PAGE_2 if row[0] != 'row' or row[2] != '7']
BULLET = '\x95'  # the bullet glyph in WinAnsiEncoding


def _cover_page(year, plans):
    items = [('text', 40, 760, 9, TITLE), ('text', 330, 740, 10, 'SYNTHETIC HEALTH EXCHANGE'),
             ('text', 40, 680, 20, '%d Synthetic Individual' % year), ('text', 40, 656, 20, 'Plans Formulary'),
             ('text', 40, 600, 10, 'THIS FORMULARY COVERS MEMBERS WITH THE FOLLOWING PLANS:')]
    columns, y0 = (48, 300), 580
    half = (len(plans) + 1) // 2
    for column, names in zip(columns, (plans[:half], plans[half:])):
        y = y0
        for name in names:
            words = name.split()
            # A long name wraps under its own text, as cover lists do.
            lines = [' '.join(words[:3]), ' '.join(words[3:])] if len(words) > 3 else [name]
            items.append(('text', column, y, 10, BULLET))
            for i, text in enumerate(lines):
                items.append(('text', column + 10, y - 12 * i, 10, text))
            y -= 12 * len(lines) + 6
    items.append(('text', 40, 40, 7, 'Synthetic print run 10/14/25 11:27 AM'))
    return items


# A tier the legend leaves out, and the footnote that states it (`--tier0 stated`).
TIER0_ROW = ('row', ['synthetic folic acid tab 0.4 mg'], '0', [])
TIER0_NOTE = 'Tier 0 - $0 synthetic preventive drugs, no cost share.'


def feed_formulary_pdf(year=2026, plans=FEED_PLANS, legend=True, tier0=None, tier0_rows=1):
    page_2 = FEED_PAGE_2 + [TIER0_ROW] * tier0_rows if tier0 else FEED_PAGE_2
    notes = [TIER0_NOTE] if tier0 == 'stated' else []
    return build_pdf([_cover_page(year, list(plans)), _formulary_page(FORMULARY_PAGE_1, 2, legend),
                      _formulary_page(page_2, 3, legend, notes)], 'Synthetic formulary with cover - test data')


# Synthetic SBC page: the Important Questions table, then the cost-sharing chart with the federal
# template's column headers. Plan values are invented.
SBC_QUESTIONS = [
    (['What is the overall deductible?'], ['$1,500 individual /', '$3,000 family']),
    (['What is the out-of-pocket limit for', 'this plan?'], ['$6,000 individual /', '$12,000 family']),
    (['Do you need a referral to see a', 'specialist?'], ['No.']),
]
# (event lines, service label lines, network lines, out-of-network lines, limitation lines)
SBC_CHART = [
    (['If you visit a health', 'care provider\'s office'], ['Primary care visit to treat an', 'injury or illness'],
     ['$30 copay/visit'], ['40% coinsurance'], ['None']),
    ([], ['Specialist visit'], ['$60 copay/visit'], ['40% coinsurance'], ['None']),
    ([], ['Preventive care/screening/', 'immunization'], ['No charge'], ['Not covered'],
     ['You may have to pay for', 'services that aren\'t', 'preventive.']),
    (['If you have a test'], ['Diagnostic test (x-ray, blood', 'work)'], ['20% coinsurance'], ['40% coinsurance'], ['None']),
    ([], ['Imaging (CT/PET scans, MRIs)'], ['20% coinsurance', 'after deductible'], ['40% coinsurance'],
     ['Preauthorization required.']),
    (['If you need drugs'], ['Generic drugs'], ['$10 copay'], ['Not covered'], ['Up to a 30-day supply.']),
    ([], ['Specialty drugs'], ['Varies by drug'], ['Not covered'], ['Preauthorization required.']),
    (['If you have outpatient', 'surgery'], ['Facility fee (e.g., ambulatory', 'surgery center)'], ['$250 copay'],
     ['40% coinsurance'], ['None']),
    # Planted boundary bleed: this network cell is drawn 13 points above centre, so its first line
    # falls into the row above, the way a wrapped cell crosses a row boundary in some documents.
    ([], ['Physician/surgeon fees'], ['Office visit: $60 copay', 'Surgery: 20% coinsurance'], ['40% coinsurance'],
     ['None'], {'network': 13}),
]
SBC_COLUMNS = dict(event=40, service=150, network=300, oon=400, limits=490)
SBC_HEADERS = [('event', ['Common Medical', 'Event']), ('service', ['Services You May', 'Need']),
               ('network', ['Network Provider', '(You will pay the least)']),
               ('oon', ['Out-of-Network Provider', '(You will pay the most)']),
               ('limits', ['Limitations, Exceptions, &', 'Other Important Information'])]


def sbc_pdf():
    c = SBC_COLUMNS
    items = [('text', 40, 760, 9, TITLE),
             ('text', 40, 744, 9, 'Summary of Benefits and Coverage: Synthetic Bronze Test Plan'),
             ('text', 40, 728, 9, 'Coverage Period: 01/01/2026 - 12/31/2026')]
    y = 704
    items += [('text', 40, y, 9, 'Important Questions'), ('text', 220, y, 9, 'Answers'),
              ('text', 400, y, 9, 'Why This Matters:')]
    y -= 16
    for labels, answers in SBC_QUESTIONS:
        for i, text in enumerate(labels):
            items.append(('text', 40, y - 11 * i, 8, text))
        for i, text in enumerate(answers):
            items.append(('text', 220, y - 11 * i, 8, text))
        items.append(('text', 400, y, 8, 'Synthetic explanation text.'))
        y -= 11 * max(len(labels), len(answers)) + 8
    y -= 12
    header_y = y
    for key, lines in SBC_HEADERS:
        for i, text in enumerate(lines):
            items.append(('text', c[key], header_y - 10 * i, 8, text))
    y = header_y - 26
    items.append(('line', 36, y + 8, 576, y + 8))
    for event, label, network, oon, limits, *raised in SBC_CHART:
        raised = raised[0] if raised else {}
        height = max(len(event), len(label), len(network), len(oon), len(limits))
        for key, lines in (('event', event), ('service', label), ('network', network), ('oon', oon), ('limits', limits)):
            # Cells are vertically centred in the row, as the federal template draws them.
            top = y - 5.5 * (height - len(lines)) + raised.get(key, 0)
            for i, text in enumerate(lines):
                items.append(('text', c[key], top - 11 * i, 8, text))
        y -= 11 * height + 10
        items.append(('line', 146, y + 8, 576, y + 8))
    items.append(('text', 280, 30, 8, 'Page 1 of 1'))
    return build_pdf([items], 'Synthetic SBC - test data')


# Feed SBC: the template header, the Important Questions table and a short chart, all invented.
# A `|` in a label breaks it onto the next line; `--value` names a label without the breaks.
FEED_SBC_QUESTIONS = [
    ('What is the overall deductible?', '$1,500/individual or $3,000/family'),
    ('What is the out-of-pocket limit for|this plan?', '$6,000/individual or $12,000/family'),
    ('Do you need a referral to see a|specialist?', 'No.'),
]
FEED_SBC_CHART = [
    ('Primary care visit to treat an|injury or illness', '$30 copay/visit'),
    ('Specialist visit', '$60 copay/visit'),
    ('Preventive care/screening/|immunization', 'No charge'),
    ('Generic drugs', '$10 copay/prescription'),
    ('Preferred brand drugs', '$40 copay/prescription'),
    ('Specialty drugs', '30% coinsurance'),
    ('Emergency room care', '$350 copay/visit'),
    ('Urgent care', '$75 copay/visit'),
]
# --carrier-labels: how some carriers print the drug rows instead.
CARRIER_DRUG_ROWS = [
    ('Preferred generic drugs', '$0 copay/prescription'),
    ('Non-preferred generic drugs', '$10 copay/prescription'),
    ('Preferred brand drugs (Tier|3)', '$40 copay/prescription'),
    ('Specialty drugs (Tier 5)', '30% coinsurance'),
]


def _unbroken(label):
    return label.replace('/|', '/').replace('|', ' ')


def feed_sbc_pdf(year=2026, period_year=None, plan='Synthetic Bronze', carrier_labels=False, values=None):
    """An SBC as the feed reads it: header with coverage period and plan name, questions, chart."""
    period_year = year if period_year is None else period_year
    values = values or {}
    rows = list(FEED_SBC_CHART)
    if carrier_labels:
        drugs = {'Generic drugs', 'Preferred brand drugs', 'Specialty drugs'}
        at = next(i for i, (label, _) in enumerate(rows) if label in drugs)
        rows = [r for r in rows if r[0] not in drugs]
        rows[at:at] = CARRIER_DRUG_ROWS
    rows = [(label, values.get(_unbroken(label), value)) for label, value in rows]
    c = SBC_COLUMNS
    items = [('text', 40, 776, 8, TITLE),
             ('text', 40, 760, 8, 'Summary of Benefits and Coverage: What this Plan Covers & What You Pay'),
             ('text', 400, 760, 8, 'Coverage Period: 01/01/%d - 12/31/%d' % (period_year, period_year)),
             ('text', 40, 748, 8, 'Synthetic Health Co: %s' % plan),
             ('text', 400, 748, 8, 'Coverage for: Individual | Plan Type: HMO'),
             ('text', 40, 724, 8, 'The Summary of Benefits and Coverage (SBC) document will help you choose a plan.')]
    y = 700
    items += [('text', 40, y, 9, 'Important Questions'), ('text', 220, y, 9, 'Answers'),
              ('text', 400, y, 9, 'Why This Matters:')]
    y -= 16
    for label, answer in FEED_SBC_QUESTIONS:
        lines = label.split('|')
        middle = y - 5.5 * (len(lines) - 1)
        items += [('text', 40, y - 11 * i, 8, text) for i, text in enumerate(lines)]
        items += [('text', 220, middle, 8, values.get(_unbroken(label), answer)),
                  ('text', 400, middle, 8, 'Synthetic explanation text.')]
        y -= 11 * len(lines) + 8
    y -= 12
    for key, lines in SBC_HEADERS:
        for i, text in enumerate(lines):
            items.append(('text', c[key], y - 10 * i, 8, text))
    y -= 26
    items.append(('line', 36, y + 8, 576, y + 8))
    for label, value in rows:
        lines = label.split('|')
        middle = y - 5.5 * (len(lines) - 1)
        items += [('text', c['service'], y - 11 * i, 8, text) for i, text in enumerate(lines)]
        items += [('text', c['network'], middle, 8, value), ('text', c['oon'], middle, 8, 'Not covered'),
                  ('text', c['limits'], middle, 8, 'None')]
        y -= 11 * len(lines) + 10
        items.append(('line', 146, y + 8, 576, y + 8))
    items.append(('text', 280, 30, 8, 'Page 1 of 1'))
    return build_pdf([items], 'Synthetic SBC - test data')


def main():
    if sys.argv[1:2] == ['feed-sbc']:
        import argparse
        ap = argparse.ArgumentParser(prog='synthetic_pdf.py feed-sbc')
        ap.add_argument('out')
        ap.add_argument('--year', type=int, default=2026)
        ap.add_argument('--period-year', type=int)
        ap.add_argument('--plan', default='Synthetic Bronze')
        ap.add_argument('--carrier-labels', action='store_true')
        ap.add_argument('--value', action='append', default=[], help='Label=printed value, repeatable')
        a = ap.parse_args(sys.argv[2:])
        values = dict(v.split('=', 1) for v in a.value)
        Path(a.out).write_bytes(feed_sbc_pdf(a.year, a.period_year, a.plan, a.carrier_labels, values))
        return
    if sys.argv[1:2] == ['feed-formulary']:
        import argparse
        ap = argparse.ArgumentParser(prog='synthetic_pdf.py feed-formulary')
        ap.add_argument('out')
        ap.add_argument('--year', type=int, default=2026)
        ap.add_argument('--no-legend', action='store_true')
        ap.add_argument('--plans', help='plan names separated by |')
        ap.add_argument('--tier0', choices=('undocumented', 'stated'))
        ap.add_argument('--tier0-rows', type=int, default=1, help='how many tier 0 rows --tier0 adds')
        a = ap.parse_args(sys.argv[2:])
        plans = a.plans.split('|') if a.plans else FEED_PLANS
        Path(a.out).write_bytes(feed_formulary_pdf(a.year, plans, not a.no_legend, a.tier0, a.tier0_rows))
        return
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    (out / 'synthetic-formulary.pdf').write_bytes(formulary_pdf())
    (out / 'synthetic-sbc.pdf').write_bytes(sbc_pdf())


if __name__ == '__main__':
    main()
