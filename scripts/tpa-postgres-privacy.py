#!/usr/bin/env python3
"""Checks disposable Postgres server logs for synthetic census sentinels."""
import sys
from pathlib import Path

values = ("1987-06-23", "1234567891", "987654321", "synthetic-census-identity-sentinel")
for name in sys.argv[1:]:
    contents = Path(name).read_text(errors="replace")
    if any(value in contents for value in values):
        raise SystemExit("FAIL generated cache or Postgres log contains a census sentinel")
print(f"PASS Postgres log and generated cache artifact scans ({len(sys.argv) - 1} files)")
