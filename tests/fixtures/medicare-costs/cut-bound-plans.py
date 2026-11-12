"""Cut two plans' rows for the cost-bound tests from the cached CMS archives.

Usage: python3 -I tests/fixtures/medicare-costs/cut-bound-plans.py "$OPENPLANS_DATA_DIR"

Rows are copied from the published 2026 Q3 Part D files (plan information, beneficiary cost) and
the 2026 PBP benefits archive (pbp_mrx, pbp_mrx_tier). H3664-017 tier 3 files a greater-of
structure; H0251-004 is a defined standard dual-eligible SNP. Nothing is invented. Source rows
are file line numbers, with the header on line 1.
"""
import csv, io, json, pathlib, sys, zipfile

SPUF = "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b"
PBP = "1720048e668f6c9e4abc47c512e537c013600de12860d28aea4f8308b5e51de4"
PLANS = {("H3664", "017", "000"): {"tiers": {"3"}}, ("H0251", "004", "000"): {"tiers": None}}
PLAN_ROWS = 3  # county rows kept per plan; every county row of both plans files the same SNP


def meta(root, source, sha):
    return json.loads((root / "raw" / source / f"{sha}.meta.json").read_text())


def spuf_table(outer, prefix):
    name = next(n for n in outer.namelist() if n.lower().startswith(prefix))
    inner = zipfile.ZipFile(io.BytesIO(outer.read(name)))
    member = next(n for n in inner.namelist() if n.lower().endswith(".txt"))
    lines = inner.read(member).decode("windows-1252").splitlines()
    header = [c.strip().upper() for c in lines[0].split("|")]
    for number, line in enumerate(lines[1:], start=2):
        yield name, number, dict(zip(header, (c.strip() for c in line.split("|"))))


def pbp_table(archive, member):
    text = archive.read(member).decode("windows-1252")
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    header = [c.strip().lower() for c in next(reader)]
    for number, cells in enumerate(reader, start=2):
        yield number, dict(zip(header, (c.strip() for c in cells)))


def main(root):
    root = pathlib.Path(root)
    spuf_meta, pbp_meta = meta(root, "cms-partd-spuf-quarterly", SPUF), meta(root, "cms-medicare-pbp", PBP)
    outer = zipfile.ZipFile(root / "raw" / "cms-partd-spuf-quarterly" / SPUF / "payload")
    pbp = zipfile.ZipFile(root / "raw" / "cms-medicare-pbp" / PBP / "payload")
    out = {
        "note": "Rows copied from CMS public files; not synthetic. Regenerate with cut-bound-plans.py.",
        "spuf": {"url": spuf_meta["url"], "sha256": SPUF, "contract_year": 2026},
        "pbp": {"url": pbp_meta["url"], "sha256": PBP, "contract_year": 2026},
        "plans": {},
    }
    for key, spec in PLANS.items():
        out["plans"]["-".join(key)] = {"plan": [], "beneficiary_cost": [], "pbp_mrx": [], "pbp_mrx_tier": []}
    def plan_of(row):
        return (row.get("CONTRACT_ID"), row.get("PLAN_ID"), row.get("SEGMENT_ID"))
    for table, prefix in (("plan", "plan information"), ("beneficiary_cost", "beneficiary cost file")):
        for member, number, row in spuf_table(outer, prefix):
            key = plan_of(row)
            if key not in PLANS:
                continue
            entry = out["plans"]["-".join(key)]
            tiers = PLANS[key]["tiers"]
            if table == "plan":
                if len(entry["plan"]) >= PLAN_ROWS:
                    continue
                row = {k: row[k] for k in ("CONTRACT_ID", "PLAN_ID", "SEGMENT_ID", "FORMULARY_ID", "DEDUCTIBLE", "SNP", "PLAN_SUPPRESSED_YN")}
            elif tiers and row["TIER"] not in tiers:
                continue
            entry[table].append({"member": member, "source_row": number, "cells": row})
    for table, fields in (("pbp_mrx", ("mrx_benefit_type",)), ("pbp_mrx_tier", ("mrx_tier_id", "mrx_tier_cstshr_struct_type", "mrx_tier_rspfd_copay_1m", "mrx_tier_rspfd_coins_1m", "mrx_tier_rsstd_copay_2m", "mrx_tier_rsstd_copay_3m"))):
        for number, row in pbp_table(pbp, f"{table}.txt"):
            key = (row["pbp_a_hnumber"], row["pbp_a_plan_identifier"], row["segment_id"].zfill(3))
            if key not in PLANS:
                continue
            tiers = PLANS[key]["tiers"]
            if table == "pbp_mrx_tier" and (not tiers or row["mrx_tier_id"] not in tiers):
                continue
            out["plans"]["-".join(key)][table].append(
                {"member": f"{table}.txt", "source_row": number, "cells": {f: row[f] for f in fields}}
            )
    path = pathlib.Path(__file__).with_name("bound-plans.json")
    path.write_text(json.dumps(out, indent=2) + "\n")


if __name__ == "__main__":
    main(sys.argv[1])
