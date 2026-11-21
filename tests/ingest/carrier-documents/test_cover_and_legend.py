"""Cover reading (cover.py) and the legend forms formulary.py accepts. All inputs are SYNTHETIC:
invented plan names and drug-list text, drawn by synthetic_pdf.py or written inline below.

    python3 -B -m unittest discover -s tests/ingest/carrier-documents -v
"""
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / 'src' / 'ingest' / 'carrier-documents'))
sys.path.insert(0, str(HERE))

import cover  # noqa: E402
import formulary  # noqa: E402
import poppler  # noqa: E402
import synthetic_pdf  # noqa: E402

NO_POPPLER = 'Poppler pdftotext is not installed (install poppler-utils, or set OPENPLANS_PDFTOTEXT)'
HAS_POPPLER = poppler.pdftotext_path() is not None


def read_cover(pdf_bytes):
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'synthetic-cover.pdf'
        path.write_bytes(pdf_bytes)
        return cover.read_cover(path)


@unittest.skipUnless(HAS_POPPLER, NO_POPPLER)
class Cover(unittest.TestCase):
    def test_plan_list_and_year(self):
        result = read_cover(synthetic_pdf.feed_formulary_pdf(2027))
        self.assertEqual(result['plan_names'], list(synthetic_pdf.FEED_PLANS))
        self.assertEqual((result['plan_list_page'], result['years'], result['plan_year']), (1, [2027], 2027))

    def test_two_printed_years_leave_the_year_unresolved(self):
        plans = ('Synthetic Bronze 2026', 'Synthetic Gold 2027')
        result = read_cover(synthetic_pdf.feed_formulary_pdf(2027, plans))
        self.assertEqual((result['years'], result['plan_year']), ([2026, 2027], None))

    def test_a_cover_without_a_plan_list(self):
        pdf = synthetic_pdf.build_pdf([[('text', 40, 700, 12, '2026 Synthetic Drug List')]])
        result = read_cover(pdf)
        self.assertEqual((result['plan_names'], result['plan_list_page'], result['plan_year']), ([], None, 2026))


class LegendForms(unittest.TestCase):
    ROWS = ('    atorvastatin calcium tab 10 mg              1      QL (30 per 30 days)\n'
            '    valganciclovir tab 450 mg                   5      PA\n')

    def parse(self, legend):
        return formulary.parse(legend + '\f' + self.ROWS + '\f')

    def test_tiering_table_with_tier_words(self):
        result = self.parse('Synthetic Drug Tiering\n'
                            '      Lowest Cost-Sharing Tier        Tier 1        Preferred Generic Drugs\n'
                            '                                      Tier 5        Specialty Drugs\n'
                            'QL: Quantity Limit. Synthetic.\nPA: Prior Authorization. Synthetic.\n')
        self.assertEqual(result['legend']['tiers'], {1: 'Preferred Generic Drugs', 5: 'Specialty Drugs'})
        self.assertEqual(sorted(result['legend']['flags']), ['PA', 'QL'])
        self.assertEqual([(r['name'], r['tier'], r['flags'], r['confidence']) for r in result['rows']], [
            ('atorvastatin calcium tab 10 mg', 1, ['QL'], 'high'), ('valganciclovir tab 450 mg', 5, ['PA'], 'high')])

    def test_tiering_table_with_numbers_only_is_legend_not_rows(self):
        result = self.parse('Synthetic Drug Tiering\n'
                            '      Lowest Cost-Sharing Tier        1        Preferred Generic Drugs\n'
                            '                                      5        Specialty Drugs\n'
                            'PA - Prior authorization    QL - Quantity limit\n')
        self.assertEqual(result['legend']['tiers'], {1: 'Preferred Generic Drugs', 5: 'Specialty Drugs'})
        self.assertEqual([r['page'] for r in result['rows']], [2, 2])
        self.assertEqual(formulary.round_trips(result), [])

    def test_numbers_without_a_tiering_heading_are_not_a_legend(self):
        result = self.parse('      Lowest Cost-Sharing Tier        1        Preferred Generic Drugs\n')
        self.assertEqual(result['legend']['tiers'], {})
        self.assertIn('no tier legend in the document', formulary.round_trips(result))

    def test_footer_legend_ending_in_a_page_number_is_not_a_row(self):
        result = formulary.parse('Tier 1 - Preferred generic    Tier 5 - Specialty\f' + self.ROWS +
                                 'PA - Prior Authorization QL - Quantity Limits ST -        7\n'
                                 'Effective 1/1/2027.                                        8\n\f')
        self.assertEqual([r['name'] for r in result['rows']],
                         ['atorvastatin calcium tab 10 mg', 'valganciclovir tab 450 mg'])


class StatedTiers(unittest.TestCase):
    """A tier the legend leaves out is admitted only when the document's own text states it."""
    LEGEND = ('Synthetic Drug Tiering\n'
              '      Lowest Cost-Sharing Tier        1        Preferred Generic Drugs\n'
              '                                      5        Specialty Drugs\n'
              'PA - Prior authorization    QL - Quantity limit\n')
    ROWS = ('    SYNTHETIC CONTRACEPTIVES\n'
            '    norethindrone tab 0.35 mg                   0\n'
            '    atorvastatin calcium tab 10 mg              1      QL (30 per 30 days)\n'
            '    valganciclovir tab 450 mg                   5      PA\n')

    def parse(self, legend_page, rows=None):
        return formulary.parse(legend_page + '\f' + (rows or self.ROWS) + '\f')

    def tier0(self, result):
        return next(r for r in result['rows'] if r['tier'] == 0)

    def test_an_undefined_tier_is_refused(self):
        result = self.parse(self.LEGEND)
        self.assertEqual(result['legend']['stated_tiers'], {})
        self.assertEqual(self.tier0(result)['confidence'], 'low')
        self.assertIn('tiers outside the legend: [0]', formulary.round_trips(result))

    def test_a_footnote_naming_the_tier_and_its_cost_admits_it(self):
        note = 'Tier 0 drugs are preventive drugs covered at $0 cost share.'
        result = self.parse(self.LEGEND + note + '\n')
        self.assertEqual(result['legend']['stated_tiers'], {0: dict(label=note, page=1, line=5, raw=note)})
        row = self.tier0(result)
        self.assertEqual((row['confidence'], row['tier_label']), ('high', note))
        self.assertEqual(formulary.round_trips(result), [])

    def test_a_tiering_table_row_with_a_cost_label_admits_it(self):
        legend = self.LEGEND.replace('5        Specialty Drugs\n',
                                     '5        Specialty Drugs\n      0        $0 Preventive Drugs\n')
        result = self.parse(legend)
        self.assertEqual(result['legend']['stated_tiers'][0]['label'], '$0 Preventive Drugs')
        self.assertEqual(result['legend']['stated_tiers'][0]['line'], 4)
        self.assertEqual([r['name'] for r in result['rows']][0], 'norethindrone tab 0.35 mg')
        self.assertEqual(formulary.round_trips(result), [])

    def test_a_cost_note_on_a_drug_row_does_not_define_the_tier(self):
        rows = ('    naltrexone hcl tab 50 mg                    0      $0 copay; Tier 0 for members\n'
                '                                                       age 18 and older\n'
                '    valganciclovir tab 450 mg                   5      PA\n')
        result = self.parse(self.LEGEND, rows)
        self.assertEqual(result['legend']['stated_tiers'], {})
        self.assertIn('tiers outside the legend: [0]', formulary.round_trips(result))

    def test_a_tier_mention_without_a_cost_or_a_cost_without_a_tier_defines_nothing(self):
        for note in ('Tier 0 drugs are listed below.', 'Preventive drugs are covered at $0.'):
            result = self.parse(self.LEGEND + note + '\n')
            self.assertEqual(result['legend']['stated_tiers'], {}, note)


if __name__ == '__main__':
    unittest.main()
