#!/usr/bin/env python3
"""Copy real, publicly served robots.txt files from the external data cache; no network.

Each body is found by byte size and sha256 from provenance.json, so a changed or missing source fails.
"""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("OPENPLANS_DATA_DIR", str(Path.home() / ".local" / "share" / "openplans")))
wanted = json.loads((ROOT / "provenance.json").read_text())["files"]
found = {}
for path in DATA.rglob("*"):
    if len(found) == len(wanted):
        break
    try:
        size = path.stat().st_size if path.is_file() else -1
    except OSError:
        continue
    for name, entry in wanted.items():
        if name not in found and size == entry["bytes"]:
            body = path.read_bytes()
            if hashlib.sha256(body).hexdigest() == entry["sha256"]:
                found[name] = body
missing = sorted(set(wanted) - set(found))
if missing:
    raise SystemExit(f"robots bodies not in the data cache: {', '.join(missing)}")
for name, body in found.items():
    (ROOT / name).write_bytes(body)
