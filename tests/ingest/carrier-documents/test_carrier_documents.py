"""Tests for src/ingest/carrier-documents (formulary text layer, SBC word coordinates).

All inputs are SYNTHETIC: synthetic_pdf.py draws an invented two-page drug list and an invented SBC
page, and synthetic-formulary.layout.txt is pdftotext's text of that drug list. No real plan or
issuer data is used.

Tests that need Poppler's pdftotext skip with a reason when it is not installed. Each planted
mutant must make at least one check fail.

    python3 -B -m unittest discover -s tests/ingest/carrier-documents -v
"""
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parents[2] / 'src' / 'ingest' / 'carrier-documents'
sys.path.insert(0, str(SRC))
sys.path.insert(0, str(HERE))

import formulary  # noqa: E402
import poppler  # noqa: E402
import sbc  # noqa: E402
import synthetic_pdf  # noqa: E402

LAYOUT = (HERE / 'synthetic-formulary.layout.txt').read_text()
NO_POPPLER = 'Poppler pdftotext is not installed (install poppler-utils, or set OPENPLANS_PDFTOTEXT)'
HAS_POPPLER = poppler.pdftotext_path() is not None


def by_name(result):
    return {r['name']: r for r in result['rows']}


def by_label(result):
    return {r['label']: r for r in result['chart'] if r['label']}


# Checks shared by the real modules and the planted mutants. Each raises AssertionError on a wrong
# answer. They take the formulary module so that a mutated copy can be passed in.

def check_page_split(fm):
    rows = by_name(fm.parse(LAYOUT))
    assert rows['atorvastatin calcium tab 10 mg']['page'] == 1, rows['atorvastatin calcium tab 10 mg']['page']
    assert rows['amoxicillin cap 500 mg']['page'] == 2, rows['amoxicillin cap 500 mg']['page']
    assert rows['amoxicillin cap 500 mg']['line'] == 8, rows['amoxicillin cap 500 mg']['line']


def check_wrap_merge(fm):
    rows = by_name(fm.parse(LAYOUT))
    name = 'insulin glargine-yfgn inj 100 unit/ml solution pen-injector 3 ml'
    assert name in rows, sorted(rows)
    assert rows[name]['flags_text'] == 'QL (15 ml per 30 days)', rows[name]['flags_text']
    assert rows[name]['ql_text'] == '15 ml per 30 days', rows[name]['ql_text']
    assert len(rows[name]['raw']) == 2, rows[name]['raw']
    assert 'sacubitril-valsartan tab 24-26 mg film coated' in rows, sorted(rows)
    long_name = 'adalimumab-adaz inj 40 mg/0.4 ml prefilled syringe kit two-pack starter dose'
    assert long_name in rows and len(rows[long_name]['raw']) == 4, sorted(rows)


def check_tiers(fm):
    result = fm.parse(LAYOUT)
    assert result['legend']['tiers'] == {1: 'Preferred generic', 2: 'Generic', 3: 'Preferred brand',
                                         4: 'Non-preferred brand', 5: 'Specialty'}, result['legend']['tiers']
    rows = by_name(result)
    expected = {'atorvastatin calcium tab 10 mg': (1, 'Preferred generic'),
                'sacubitril-valsartan tab 24-26 mg film coated': (3, 'Preferred brand'),
                'semaglutide inj 2 mg/3 ml pen': (4, 'Non-preferred brand'),
                'valganciclovir tab 450 mg': (5, 'Specialty'),
                'nitrofurantoin cap 100 mg': (7, None)}
    for name, (tier, label) in expected.items():
        assert (rows[name]['tier'], rows[name]['tier_label']) == (tier, label), (name, rows[name])


def check_flags(fm):
    result = fm.parse(LAYOUT)
    assert sorted(result['legend']['flags']) == ['AGE', 'PA', 'QL', 'ST'], result['legend']['flags']
    rows = by_name(result)
    expected = {'lisinopril tab 20 mg': ['QL'],
                'sacubitril-valsartan tab 24-26 mg film coated': ['PA', 'ST'],
                'metformin hcl er tab 500 mg': ['AGE'],
                # LD is a token the parser knows, but this document's legend does not define it.
                'semaglutide inj 2 mg/3 ml pen': ['PA'],
                'valganciclovir tab 450 mg': ['PA', 'QL'],
                'oseltamivir cap 75 mg': []}
    for name, flags in expected.items():
        assert rows[name]['flags'] == flags, (name, rows[name]['flags'])


def check_confidence(fm):
    rows = by_name(fm.parse(LAYOUT))
    expected = {'atorvastatin calcium tab 10 mg': ('high', []),
                'insulin glargine-yfgn inj 100 unit/ml solution pen-injector 3 ml': ('high', []),
                'sps': ('low', ['name_fragment']),
                'nitrofurantoin cap 100 mg': ('low', ['tier_not_in_legend']),
                'semaglutide inj 2 mg/3 ml pen': ('medium', ['token_not_in_legend']),
                'oseltamivir cap 75 mg': ('medium', ['requirements_without_legend_token']),
                'adalimumab-adaz inj 40 mg/0.4 ml prefilled syringe kit two-pack starter dose': ('medium', ['long_wrap'])}
    for name, (confidence, reasons) in expected.items():
        assert (rows[name]['confidence'], rows[name]['reasons']) == (confidence, reasons), (name, rows[name])


# A tiering table for tiers 1 and 5, and a tier 0 row that only a statement in the text may admit.
STATED_LEGEND = ('Synthetic Drug Tiering\n'
                 '      Lowest Cost-Sharing Tier        1        Preferred Generic Drugs\n'
                 '                                      5        Specialty Drugs\n')
STATED_ROWS = ('    norethindrone tab 0.35 mg                   0\n'
               '    valganciclovir tab 450 mg                   5\n\f')


def check_stated_tiers(fm):
    for note in ('', 'Tier 0 drugs are listed below.\n', 'Preventive drugs are covered at $0.\n'):
        result = fm.parse(STATED_LEGEND + note + '\f' + STATED_ROWS)
        assert result['legend']['stated_tiers'] == {}, (note, result['legend']['stated_tiers'])
        assert 'tiers outside the legend: [0]' in fm.round_trips(result), note
    note = 'Tier 0 drugs are covered at $0 cost share.'
    result = fm.parse(STATED_LEGEND + note + '\n\f' + STATED_ROWS)
    assert result['legend']['stated_tiers'] == {0: dict(label=note, page=1, line=4, raw=note)}, result['legend']
    assert fm.round_trips(result) == [], fm.round_trips(result)


FORMULARY_CHECKS = (check_page_split, check_wrap_merge, check_tiers, check_flags, check_confidence,
                    check_stated_tiers)

_sbc_cache = {}


def synthetic_sbc_xhtml():
    if 'xhtml' not in _sbc_cache:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic-sbc.pdf'
            path.write_bytes(synthetic_pdf.sbc_pdf())
            _sbc_cache['xhtml'] = poppler.bbox_xhtml(path)
    return _sbc_cache['xhtml']


def check_sbc_rows(sm):
    result = sm.parse(synthetic_sbc_xhtml())
    rows = by_label(result)
    expected = {
        'Primary care visit to treat an injury or illness': ('$30 copay/visit', '40% coinsurance', 'None', 'high'),
        'Specialist visit': ('$60 copay/visit', '40% coinsurance', 'None', 'high'),
        'Preventive care/screening/immunization': (
            'No charge', 'Not covered', "You may have to pay for services that aren't preventive.", 'high'),
        'Diagnostic test (x-ray, blood work)': ('20% coinsurance', '40% coinsurance', 'None', 'high'),
        'Imaging (CT/PET scans, MRIs)': (
            '20% coinsurance after deductible', '40% coinsurance', 'Preauthorization required.', 'high'),
        'Generic drugs': ('$10 copay', 'Not covered', 'Up to a 30-day supply.', 'high'),
        'Specialty drugs': ('Varies by drug', 'Not covered', 'Preauthorization required.', 'medium'),
    }
    for label, (network, oon, limits, confidence) in expected.items():
        row = rows.get(label)
        assert row is not None, (label, sorted(rows))
        got = (row.get('network'), row.get('out_of_network'), row.get('limitations'), row['confidence'])
        assert got == (network, oon, limits, confidence), (label, got)
        assert row['page'] == 1 and row['raw'], row
    assert rows['Diagnostic test (x-ray, blood work)']['event'] == 'If you have a test'
    assert rows['Specialist visit']['event'] == "If you visit a health care provider's office"
    assert len(rows['Preventive care/screening/immunization']['raw']) == 5, rows['Preventive care/screening/immunization']['raw']


def check_sbc_bleed(sm):
    rows = by_label(sm.parse(synthetic_sbc_xhtml()))
    for label in ('Facility fee (e.g., ambulatory surgery center)', 'Physician/surgeon fees'):
        row = rows[label]
        assert row['confidence'] == 'medium' and 'boundary_bleed' in row['reasons'], (label, row)
        assert row['bleeds'] == ['network'], (label, row['bleeds'])
    assert rows['Specialist visit']['bleeds'] == []


def feed_sbc(**options):
    """sbc.py --feed output for a synthetic SBC drawn by synthetic_pdf.feed_sbc_pdf."""
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'feed-sbc.pdf'
        path.write_bytes(synthetic_pdf.feed_sbc_pdf(**options))
        result = sbc.parse(poppler.bbox_xhtml(path))
        result.update(sbc.read_header('\n'.join(poppler.split_pages(poppler.layout_text(path, last_page=1))[0])))
    return result


def check_sbc_carrier_labels(sm):
    rows = [r for r in sm.parse(_carrier_xhtml())['chart'] if r['label']]
    got = [(r['label'], r['sub_label'], r['match'], r['network'], r['confidence']) for r in rows
           if 'drugs' in r['label']]
    assert got == [
        ('Generic drugs', 'Preferred generic', 'sub_row', '$0 copay/prescription', 'high'),
        ('Generic drugs', 'Non-preferred generic', 'sub_row', '$10 copay/prescription', 'high'),
        ('Preferred brand drugs', None, 'tier_suffix', '$40 copay/prescription', 'high'),
        ('Specialty drugs', None, 'tier_suffix', '30% coinsurance', 'high'),
    ], got


def _carrier_xhtml():
    if 'carrier' not in _sbc_cache:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'carrier-sbc.pdf'
            path.write_bytes(synthetic_pdf.feed_sbc_pdf(carrier_labels=True))
            _sbc_cache['carrier'] = poppler.bbox_xhtml(path)
    return _sbc_cache['carrier']


SBC_CHECKS = (check_sbc_rows, check_sbc_bleed)
SBC_LABEL_CHECKS = (check_sbc_carrier_labels,)


def mutate(module, before, after):
    """A fresh copy of `module` with `before` (which must occur exactly once) replaced by `after`."""
    path = Path(module.__file__)
    source = path.read_text()
    assert source.count(before) == 1, 'mutation target must occur exactly once in %s: %r' % (path.name, before)
    mutant = types.ModuleType(module.__name__ + '_mutant')
    mutant.__file__ = str(path)
    exec(compile(source.replace(before, after), str(path), 'exec'), mutant.__dict__)
    return mutant


# name: (module, before, after, checks that must catch it, needs Poppler)
MUTANTS = {
    'wrong tier mapping': (
        formulary, "row['tier_label'] = legend['tiers'].get(row['tier'])",
        "row['tier_label'] = legend['tiers'].get(row['tier'] + 1)", FORMULARY_CHECKS, False),
    'dropped wrapped line': (
        formulary, "row['name'] = row['name'] + ' ' + ' '.join(name_parts)",
        "row['name'] = row['name']", FORMULARY_CHECKS, False),
    'low-confidence fragment labelled high': (
        formulary, "if len(name) < 4 or re.fullmatch(r'[\\d\\W]+', name):",
        "if re.fullmatch(r'[\\d\\W]+', name):", FORMULARY_CHECKS, False),
    'tier outside the legend labelled high': (
        formulary, "elif row['tier'] not in allowed_tiers:", "elif False:", FORMULARY_CHECKS, False),
    'legend check dropped': (
        formulary, "if t in legend['flags']})", "if t in KNOWN_FLAGS})", FORMULARY_CHECKS, False),
    'splitlines regression': (
        formulary, 'pages = split_pages(text)', 'pages = [text.splitlines()]', FORMULARY_CHECKS, False),
    'undocumented tier admitted': (
        formulary, 'stated = stated_tiers(text_lines, legend)',
        "stated = {r['tier']: dict(label='', page=1, line=1, raw='') for r in rows "
        "if r['tier'] not in legend['tiers']}", FORMULARY_CHECKS, False),
    'tier mention without a stated cost admitted': (
        formulary, 'elif COST_STATEMENT.search(text):', 'else:', FORMULARY_CHECKS, False),
    'SBC row value shifted one column': (
        sbc, 'zip(cell_names, cuts, cuts[1:])', 'zip(cell_names, cuts[1:], cuts[2:] + [cuts[-1] + 1])',
        SBC_CHECKS, True),
    'carrier sub-rows not accepted': (
        sbc, "out += [(text, label, sub, 'sub_row') for text, label, sub in SUB_ROWS if label in labels]",
        'pass', SBC_LABEL_CHECKS, True),
    '(Tier n) suffix not dropped': (
        sbc, "key = TIER_SUFFIX.sub('', text)", 'key = text', SBC_LABEL_CHECKS, True),
    'boundary bleed not flagged': (
        sbc, 'mark_bleeds(rows, CHART_CELLS)', 'None', SBC_CHECKS, True),
}


class PageSplit(unittest.TestCase):
    def test_form_feed_ends_each_page(self):
        pages = poppler.split_pages('a\nb\n\fc\n\f')
        self.assertEqual(pages, [['a', 'b', ''], ['c', '']])

    def test_splitlines_would_lose_the_boundary(self):
        # The reason split_pages exists: splitlines() treats \f as a line break.
        self.assertEqual('a\fb'.splitlines(), ['a', 'b'])
        self.assertEqual(len(poppler.split_pages('a\fb')), 2)

    def test_rows_carry_their_page(self):
        check_page_split(formulary)
        pages = {r['page'] for r in formulary.parse(LAYOUT)['rows']}
        self.assertEqual(pages, {1, 2})

    def test_missing_tool_is_reported(self):
        saved = os.environ.get(poppler.TOOL_ENV)
        os.environ[poppler.TOOL_ENV] = 'pdftotext-not-installed-synthetic'
        try:
            with self.assertRaises(poppler.ToolMissing):
                poppler.layout_text('synthetic.pdf')
        finally:
            if saved is None:
                del os.environ[poppler.TOOL_ENV]
            else:
                os.environ[poppler.TOOL_ENV] = saved

    def test_wrap_never_crosses_a_page_break(self):
        text = 'Tier 1 - Generic\nmetformin tab 500 mg   1\n\f      continued text\n'
        rows = formulary.parse(text)['rows']
        self.assertEqual(rows[0]['name'], 'metformin tab 500 mg')
        self.assertEqual(rows[0]['raw'], ['metformin tab 500 mg   1'])


class Formulary(unittest.TestCase):
    def test_wrap_merge(self):
        check_wrap_merge(formulary)

    def test_legend_and_tiers(self):
        check_tiers(formulary)

    def test_flags_come_from_the_document_legend(self):
        check_flags(formulary)

    def test_confidence(self):
        check_confidence(formulary)

    def test_headings_and_raw_lines(self):
        result = formulary.parse(LAYOUT)
        rows = by_name(result)
        self.assertEqual(rows['metformin hcl er tab 500 mg']['category'], 'ENDOCRINE AND METABOLIC AGENTS')
        for row in result['rows']:
            self.assertTrue(row['raw'] and row['raw'][0].startswith(row['name'].split()[0]), row)

    def test_no_tier_legend_is_medium_not_high(self):
        rows = formulary.parse('PA - Prior authorization\natorvastatin tab 10 mg   1   PA\n')['rows']
        self.assertEqual((rows[0]['confidence'], rows[0]['reasons']), ('medium', ['no_tier_legend']))
        rows = formulary.parse('atorvastatin tab 10 mg   1\n', tiers={1, 2})['rows']
        self.assertEqual(rows[0]['confidence'], 'high')

    def test_round_trips_report_tiers_outside_the_legend(self):
        self.assertEqual(formulary.round_trips(formulary.parse(LAYOUT)), ['tiers outside the legend: [7]'])


def word(x0, y0, x1, text, height=8.0):
    return dict(x0=x0, y0=y0, x1=x1, y1=y0 + height, text=text)


class SbcGeometry(unittest.TestCase):
    """Word-coordinate rules on hand-placed synthetic words (no Poppler needed)."""

    HEADER = [word(40, 100, 90, 'Common'), word(92, 100, 130, 'Medical'),
              word(150, 100, 180, 'Services'), word(182, 100, 196, 'You'), word(198, 100, 214, 'May'),
              word(300, 100, 330, 'Network'), word(332, 100, 362, 'Provider'),
              word(400, 100, 450, 'Out-of-Network'), word(452, 100, 482, 'Provider'),
              word(490, 100, 540, 'Limitations,')]

    def test_header_centre_column_cuts(self):
        header = sbc.find_chart_header(self.HEADER)
        cuts = sbc.column_cuts(header, 612)
        self.assertEqual(cuts, dict(service=(85 + 182) / 2, network=(182 + 331) / 2,
                                    out_of_network=(331 + 441) / 2, limitations=(441 + 515) / 2))

    def test_header_must_share_the_line(self):
        # "network provider" in a question above the chart is not the chart header
        words = [word(40, 50, 120, 'network'), word(122, 50, 160, 'provider?')] + self.HEADER
        header = sbc.find_chart_header(words)
        self.assertEqual(header['network'][1], 100)

    def test_label_blocks_join_wrapped_labels(self):
        lines = sbc.group_lines([word(150, 200, 260, 'Primary care visit to treat an'),
                                 word(150, 211, 220, 'injury or illness'),
                                 word(150, 240, 200, 'Specialist visit'),
                                 word(150, 260, 200, 'Something else')])
        blocks = sbc.label_blocks(lines, sbc.SERVICES)
        self.assertEqual([(b['label'], b['matched']) for b in blocks],
                         [('Primary care visit to treat an injury or illness', True),
                          ('Specialist visit', True), (None, False)])

    def test_tolerant_labels(self):
        lines = sbc.group_lines([word(150, 200, 260, 'Preferred generic'), word(150, 211, 200, 'drugs'),
                                 word(150, 240, 260, 'Specialty drugs (Tier 5)'),
                                 word(150, 270, 260, 'Preferred brand drugs (Tier'),
                                 word(150, 300, 260, 'Premium drugs')])
        blocks = sbc.label_blocks(lines, sbc.SERVICES, tolerant=True)
        self.assertEqual([(b['label'], b['sub_label'], b['match']) for b in blocks],
                         [('Generic drugs', 'Preferred generic', 'sub_row'),
                          ('Specialty drugs', None, 'tier_suffix'),
                          ('Preferred brand drugs', None, 'tier_suffix'),
                          (None, None, None)])
        strict = sbc.label_blocks(lines, sbc.SERVICES)
        self.assertEqual([b['label'] for b in strict if b['matched']], [])

    def test_header_reading(self):
        page = ('Summary of Benefits and Coverage: What this Plan Covers & What You Pay     Coverage Period: 01/01/2026-12/31/2026\n'
                '            : Example Bronze                                    Coverage for: Individual | Plan Type: HMO\n'
                '            (2 Free Visits, $0 Generic Rx)\n\nThe Summary of Benefits and Coverage (SBC) document ...')
        self.assertEqual(sbc.read_header(page), dict(
            coverage_period=dict(start='2026-01-01', end='2026-12-31', plan_year=2026),
            plan_name='Example Bronze (2 Free Visits, $0 Generic Rx)'))
        split = sbc.read_header('Coverage Period: 07/01/2025 - 06/30/2026\nIssuer: Example Gold   Coverage for: Individual')
        self.assertEqual((split['coverage_period']['plan_year'], split['plan_name']), (None, 'Example Gold'))
        self.assertEqual(sbc.read_header('no header here'), dict(coverage_period=None, plan_name=None))

    def test_question_columns_cut_in_the_widest_free_band(self):
        # header centres 90 and 197 put the midpoint at 143.5, inside "meet" (135-158)
        words = [word(41, 286, 132, 'covered before you'), word(135, 286, 158, 'meet'),
                 word(176, 279, 341, 'services are covered before you meet')]
        self.assertEqual(sbc.gap_cut(words, 90, 177), 167)
        self.assertEqual(sbc.gap_cut([], 90, 177), 133.5)

    def test_label_midpoint_row_cut(self):
        upper, lower = dict(y0=200, y1=208), dict(y0=240, y1=248)
        self.assertEqual(sbc.row_cut(upper, lower, []), 224)

    def test_row_cut_uses_the_largest_empty_gap(self):
        upper, lower = dict(y0=200, y1=208), dict(y0=240, y1=248)
        # a value line at 214-222 leaves gaps 208-214 and 222-240: the cut is in the larger one
        self.assertEqual(sbc.row_cut(upper, lower, [word(300, 214, 340, '$5')]), 231)


@unittest.skipUnless(HAS_POPPLER, NO_POPPLER)
class SyntheticPdfs(unittest.TestCase):
    def test_pdf_text_matches_the_layout_fixture(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'synthetic-formulary.pdf'
            path.write_bytes(synthetic_pdf.formulary_pdf())
            live = formulary.parse(poppler.layout_text(path))
        keep = ('page', 'name', 'tier', 'tier_label', 'flags', 'ql_text', 'confidence', 'reasons')
        project = lambda result: [{k: r[k] for k in keep} for r in result['rows']]  # noqa: E731
        self.assertEqual(project(live), project(formulary.parse(LAYOUT)))
        self.assertEqual(len(live['rows']), 12)

    def test_sbc_row_recovery(self):
        check_sbc_rows(sbc)

    def test_sbc_boundary_bleed_is_flagged(self):
        check_sbc_bleed(sbc)

    def test_sbc_carrier_labels(self):
        check_sbc_carrier_labels(sbc)

    def test_sbc_header(self):
        result = feed_sbc(year=2026, plan='Synthetic Bronze (Two Free Visits)')
        self.assertEqual(result['coverage_period'],
                         dict(start='2026-01-01', end='2026-12-31', plan_year=2026))
        self.assertEqual(result['plan_name'], 'Synthetic Bronze (Two Free Visits)')
        self.assertEqual(feed_sbc(year=2026, period_year=2025)['coverage_period']['plan_year'], 2025)
        self.assertEqual(result['missing_services'][:2], ['Diagnostic test (x-ray, blood work)',
                                                          'Imaging (CT/PET scans, MRIs)'])

    def test_sbc_questions(self):
        questions = sbc.parse(synthetic_sbc_xhtml())['questions']
        answers = {q['label']: (q['answer'], q['confidence']) for q in questions}
        self.assertEqual(answers, {
            'What is the overall deductible?': ('$1,500 individual / $3,000 family', 'high'),
            'What is the out-of-pocket limit for this plan?': ('$6,000 individual / $12,000 family', 'high'),
            'Do you need a referral to see a specialist?': ('No.', 'high')})


class PlantedMutants(unittest.TestCase):
    def test_real_modules_pass_every_check(self):
        for check in FORMULARY_CHECKS:
            check(formulary)
        if HAS_POPPLER:
            for check in SBC_CHECKS + SBC_LABEL_CHECKS:
                check(sbc)

    def test_every_mutant_is_killed(self):
        for name, (module, before, after, checks, needs_poppler) in MUTANTS.items():
            with self.subTest(mutant=name):
                if needs_poppler and not HAS_POPPLER:
                    self.skipTest('%s: %s' % (name, NO_POPPLER))
                mutant = mutate(module, before, after)
                caught = []
                for check in checks:
                    try:
                        check(mutant)
                    except Exception as error:  # a crash also kills the mutant
                        caught.append('%s: %s' % (check.__name__, type(error).__name__))
                self.assertTrue(caught, 'mutant survived: %s' % name)
                print('mutant killed: %s (%s)' % (name, caught[0]), file=sys.stderr)


if __name__ == '__main__':
    unittest.main()
