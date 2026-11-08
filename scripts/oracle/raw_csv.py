"""Independent streaming CMS CSV and decimal parsing helpers."""
import csv
import io
import re
import zipfile
from decimal import Decimal


def cents(value):
    if value == '':
        return None
    if not re.fullmatch(r'\d+(?:\.\d{1,2})?', value):
        raise ValueError('Invalid published dollar amount')
    return int(Decimal(value) * 100)


def csv_rows(path, year=2026):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != 1 or not names[0].lower().endswith('.csv'):
            raise ValueError('Expected one CSV member')
        with io.TextIOWrapper(archive.open(names[0]), encoding='utf-8-sig', newline='') as stream:
            reader = csv.DictReader(stream)
            # Force header consumption so physical starting lines agree with importRows.
            reader.fieldnames
            while True:
                start = reader.line_num + 1
                row = next(reader, None)
                if row is None:
                    return
                if row['StateCode'] == 'TX':
                    if row['BusinessYear'] != str(year):
                        raise ValueError('Unexpected selected-state business year')
                    yield start, row
