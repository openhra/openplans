#!/usr/bin/env python3
"""Cut unmodified public CMS rows; no network and no generated premium values."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path

PLANS = ["20069TX0100006", "29418TX0140049", "33602TX0460563", "87226TX0100013"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="PY2026 rate-puf.csv (otherwise use OPENPLANS_DATA_DIR)")
    args = parser.parse_args()
    source = args.source
    if source is None:
        cache = os.environ.get("OPENPLANS_DATA_DIR")
        if not cache:
            parser.error("--source or OPENPLANS_DATA_DIR is required")
        source = Path(cache) / "raw/incoming-exchange-puf/data/exchange-puf/2026/rate-puf.csv"
    digest = hashlib.sha256()
    with source.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    rows = []
    with source.open(newline="", encoding="utf-8-sig") as stream:
        for number, row in enumerate(csv.DictReader(stream), start=2):
            if (row["BusinessYear"] == "2026" and row["StateCode"] == "TX"
                    and row["RatingAreaId"] == "Rating Area 10" and row["PlanId"] in PLANS):
                rows.append({"sourceRowNumber": number, "raw": row})
    if len(rows) != 204 or {row["raw"]["PlanId"] for row in rows} != set(PLANS):
        raise ValueError("Expected 51 age bands for each of the four selected plans; inspect source changes")
    fixture = {
        "publisher": "Centers for Medicare & Medicaid Services",
        "source": "CMS Exchange Public Use Files, PY2026 Rate PUF (owner-supplied archive)",
        "sourceFile": "rate-puf.csv",
        "sourceSha256": digest.hexdigest(),
        "businessYear": 2026,
        "stateCode": "TX",
        "ratingAreaId": "Rating Area 10",
        "planIds": PLANS,
        "rows": rows,
    }
    data = json.dumps(fixture, indent=2, ensure_ascii=False) + "\n"
    if len(data.encode()) >= 200_000:
        raise ValueError("Fixture exceeds 200 KB")
    output = Path(__file__).with_name("tx-2026-area-10.json")
    output.write_text(data, encoding="utf-8")
    print(f"{output.name}: {len(rows)} real rows, {len(data.encode())} bytes, sha256 {digest.hexdigest()}")


if __name__ == "__main__":
    main()
