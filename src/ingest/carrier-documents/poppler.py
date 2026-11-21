"""Text-layer access to carrier PDFs through Poppler's `pdftotext` (Python stdlib only).

`pdftotext` is a source preparation prerequisite, the same as for the VT rate extraction in
`src/ingest/state/prepare.py`: an operator installs Poppler; it is never a worker or container
dependency. `OPENPLANS_PDFTOTEXT` may name the executable; otherwise it is looked up on PATH.
"""
import os
import shutil
import subprocess

TOOL_ENV = 'OPENPLANS_PDFTOTEXT'


class ToolMissing(RuntimeError):
    """Poppler's pdftotext is not installed or not executable."""


def pdftotext_path():
    """The pdftotext executable, or None when it is not installed."""
    return shutil.which(os.environ.get(TOOL_ENV) or 'pdftotext')


def _run(args, pdf):
    tool = pdftotext_path()
    if tool is None:
        raise ToolMissing('pdftotext (Poppler) is required to read PDF text; install poppler-utils '
                          'or set %s' % TOOL_ENV)
    result = subprocess.run([tool, *args, str(pdf), '-'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError('pdftotext failed on %s: %s' % (pdf, result.stderr.decode('utf-8', 'replace').strip()))
    return result.stdout.decode('utf-8', 'replace')


def layout_text(pdf, last_page=None):
    """`pdftotext -layout`: one text line per visual line, columns kept by spacing, pages ended by \\f.

    `last_page` stops after that page (1-based), for readers that need only the first page.
    """
    pages = ['-f', '1', '-l', str(last_page)] if last_page else []
    return _run(['-layout', '-enc', 'UTF-8', *pages], pdf)


def bbox_xhtml(pdf, last_page=None):
    """`pdftotext -bbox-layout`: XHTML with a box (xMin yMin xMax yMax) for every word.

    `last_page` stops after that page (1-based), for readers that need only the cover.
    """
    pages = ['-f', '1', '-l', str(last_page)] if last_page else []
    return _run(['-bbox-layout', '-enc', 'UTF-8', *pages], pdf)


def split_pages(text):
    """Split `pdftotext` output into pages on the form feed that ends each page.

    Never use `str.splitlines()` on the whole text: it treats \\f as a line break, so every page
    boundary disappears and every row lands on page 1. Returns a list of pages, each a list of lines
    (without line endings); page n of the PDF is element n - 1.
    """
    pages = text.split('\f')
    if len(pages) > 1 and pages[-1].strip() == '':
        pages.pop()  # pdftotext ends the last page with \f too
    return [page.split('\n') for page in pages]
