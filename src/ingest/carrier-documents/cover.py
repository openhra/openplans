#!/usr/bin/env python3
"""Read a formulary's cover: the plan year it prints and the plans it says it covers.

Reads `pdftotext -bbox-layout` words of the first pages (a box per word), because cover plan lists
are bulleted columns whose wrapped names `-layout` text runs together.

- Plan list: the first page with a line such as "... COVERS MEMBERS WITH THE FOLLOWING PLANS:".
  Bullet glyphs below that line set the columns (bullets within 3 points share a column). Every
  word belongs to the column whose bullet sits at or left of it. In a column, a line that starts
  with a bullet starts a plan name; a line just below it (less than 0.8 line heights apart)
  continues that name; anything else ends it and is not read.
- Plan year: four-digit years (2000-2099) printed as words of their own on the first page. A
  date such as 11/1/2026 is one word and does not count. Exactly one distinct year is the
  document's plan year; none or several leave it unresolved (None).

The URL or file name of a document is never its plan year; the printed cover decides.

Usage: python3 cover.py <file.pdf>   (prints JSON)
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from poppler import bbox_xhtml  # noqa: E402
from sbc import words_by_page  # noqa: E402

COVER_PAGES = 2
BULLETS = frozenset('•●▪◦■')
LIST_HEADER = re.compile(r'\bfollowing\s+plans?\b|\bplans?\s+covered\b', re.I)
YEAR_WORD = re.compile(r'(20\d\d)')
COLUMN_TOLERANCE = 3.0  # bullets this close share a column
LINE_TOLERANCE = 2.5  # words whose tops differ by less than this share a line
CONTINUATION_GAP = 0.8  # in line heights: a closer line below continues the name


def _lines(words):
    """Words grouped into lines (top to bottom), each line ordered left to right."""
    lines = []
    for word in sorted(words, key=lambda w: (w['y0'], w['x0'])):
        if lines and abs(word['y0'] - lines[-1][0]['y0']) < LINE_TOLERANCE:
            lines[-1].append(word)
        else:
            lines.append([word])
    return [sorted(line, key=lambda w: w['x0']) for line in lines]


def _columns(words):
    starts = []
    for x in sorted(w['x0'] for w in words if w['text'] in BULLETS):
        if not starts or x - starts[-1] > COLUMN_TOLERANCE:
            starts.append(x)
    return starts


def _column_names(words):
    names, current, previous = [], None, None
    for line in _lines(words):
        height = line[0]['y1'] - line[0]['y0']
        if line[0]['text'] in BULLETS:
            current = [w['text'] for w in line[1:]]
            names.append(current)
            previous = line
        elif current is not None and line[0]['y0'] - max(w['y1'] for w in previous) < height * CONTINUATION_GAP:
            current.extend(w['text'] for w in line)
            previous = line
        else:
            current = None
    return [' '.join(name) for name in names if name]


def plan_list(page):
    """The cover's plan names in column order, or None when the page has no plan list."""
    header_bottom = None
    for line in _lines(page['words']):
        if LIST_HEADER.search(' '.join(w['text'] for w in line)):
            header_bottom = max(w['y1'] for w in line)
            break
    if header_bottom is None:
        return None
    below = [w for w in page['words'] if w['y0'] >= header_bottom - 0.5]
    starts = _columns(below)
    names = []
    for index, start in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else float('inf')
        names += _column_names([w for w in below if start - COLUMN_TOLERANCE <= w['x0'] < end - COLUMN_TOLERANCE])
    return names


def printed_years(page):
    return sorted({int(w['text']) for w in page['words'] if YEAR_WORD.fullmatch(w['text'])})


def parse(xhtml):
    pages = words_by_page(xhtml)[:COVER_PAGES]
    names, list_page = [], None
    for number, page in enumerate(pages, 1):
        found = plan_list(page)
        if found is not None:
            names, list_page = found, number
            break
    years = printed_years(pages[0]) if pages else []
    return dict(plan_names=names, plan_list_page=list_page, years=years,
                plan_year=years[0] if len(years) == 1 else None)


def read_cover(pdf):
    return parse(bbox_xhtml(pdf, last_page=COVER_PAGES))


if __name__ == '__main__':
    print(json.dumps(read_cover(Path(sys.argv[1])), indent=1))
