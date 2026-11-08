#!/usr/bin/env python3
"""Cut a small deterministic sample from an immutable NUCC CSV cache snapshot."""
import csv
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
if not os.environ.get("OPENPLANS_DATA_DIR"):
    raise SystemExit("set OPENPLANS_DATA_DIR to the external data cache")
CACHE = Path(os.environ["OPENPLANS_DATA_DIR"])
SOURCE = CACHE / "raw" / "nucc-provider-taxonomy"
DEST = Path(__file__).resolve().parent
URL = "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv"

metas = sorted(SOURCE.glob("*.meta.json"))
meta = next((json.loads(p.read_text()) for p in metas if json.loads(p.read_text()).get("url") == URL), None)
if not meta:
    raise SystemExit("official NUCC 26.1 CSV is not cached; run worker ingest taxonomy first")
payload = SOURCE / meta["snapshot_id"] / "payload"
raw = payload.read_bytes()
if hashlib.sha256(raw).hexdigest() != meta["sha256"]:
    raise SystemExit("cached NUCC CSV hash mismatch")
with payload.open(newline="", encoding="utf-8-sig") as source:
    rows = list(csv.DictReader(source))
selected = [row for row in rows if row["Code"] in {"207Q00000X", "207R00000X", "193200000X"}]
if len(selected) != 3 or not any(row["Code"] == "207Q00000X" and row["Classification"] == "Family Medicine" for row in selected):
    raise SystemExit("expected NUCC codes missing from source")
fields = ["Code", "Classification", "Specialization", "Display Name"]
with (DEST / "nucc.csv").open("w", newline="", encoding="utf-8") as out:
    writer = csv.DictWriter(out, fieldnames=fields, lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: row[key] for key in fields} for row in selected)
(DEST / "provenance.json").write_text(json.dumps({"source_url": URL, "version": "26.1", "sha256": meta["sha256"],
    "selection": [row["Code"] for row in selected]}, indent=2) + "\n")
