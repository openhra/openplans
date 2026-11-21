"""Guard against a silent skip: where Poppler is declared available, missing pdftotext is a failure.

The PDF tests skip with a reason when `pdftotext` is not installed. A CI job or release image that
is meant to have Poppler sets OPENPLANS_REQUIRE_POPPLER=1; then a missing tool fails here instead of
letting those tests skip unnoticed. Unset, nothing is required and the skip stays.
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'src' / 'ingest' / 'carrier-documents'))
import poppler  # noqa: E402

REQUIRE_ENV = 'OPENPLANS_REQUIRE_POPPLER'


def poppler_requirement_error(environ, tool_path):
    """A message when Poppler is required but missing, else None."""
    if environ.get(REQUIRE_ENV) in (None, '', '0'):
        return None
    if tool_path is None:
        return ('%s is set but pdftotext was not found; install poppler-utils (Ubuntu) or poppler '
                '(macOS), or set %s. The PDF tests would silently skip.' % (REQUIRE_ENV, poppler.TOOL_ENV))
    return None


class PopplerRequiredTest(unittest.TestCase):
    def test_declared_poppler_is_installed(self):
        error = poppler_requirement_error(os.environ, poppler.pdftotext_path())
        if error:
            self.fail(error)

    def test_negative_control_missing_tool_is_caught(self):
        self.assertIsNotNone(poppler_requirement_error({REQUIRE_ENV: '1'}, None))
        self.assertIsNone(poppler_requirement_error({REQUIRE_ENV: '1'}, '/usr/bin/pdftotext'))
        self.assertIsNone(poppler_requirement_error({}, None))
        self.assertIsNone(poppler_requirement_error({REQUIRE_ENV: '0'}, None))


if __name__ == '__main__':
    unittest.main()
