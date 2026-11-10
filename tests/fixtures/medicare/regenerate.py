"""Cut the Medicare test fixtures from real CMS archives in the shared data cache.

Usage: python3 -I tests/fixtures/medicare/regenerate.py "$OPENPLANS_DATA_DIR"

Rows are copied byte for byte from the published files (CY2026 Landscape 202609, PBP 2026,
Star Ratings 2026 and 2027, Plan Crosswalk 2026, October 2026 contract service-area files). Only
the selected plans, counties and dictionary fields are kept. Nothing is invented.
"""
import csv, io, json, os, pathlib, sys, zipfile
import xml.etree.ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def sheet_rows(workbook_bytes):
    """First worksheet of an xlsx as lists of cell text (shared and inline strings, raw values)."""
    x = zipfile.ZipFile(io.BytesIO(workbook_bytes))
    shared = []
    if "xl/sharedStrings.xml" in x.namelist():
        for si in ET.fromstring(x.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    for row in ET.fromstring(x.read("xl/worksheets/sheet1.xml")).iter("{%s}row" % NS["m"]):
        cells = []
        for c in row.findall("m:c", NS):
            ref = "".join(ch for ch in c.get("r", "") if ch.isalpha())
            col = 0
            for ch in ref:
                col = col * 26 + ord(ch) - 64
            while len(cells) < col - 1:
                cells.append("")
            v = c.find("m:v", NS)
            if c.get("t") == "s" and v is not None:
                cells.append(shared[int(v.text)])
            elif c.get("t") == "inlineStr":
                cells.append("".join(t.text or "" for t in c.iter("{%s}t" % NS["m"])))
            else:
                cells.append(v.text if v is not None and v.text else "")
        yield cells

data = pathlib.Path(sys.argv[1]) / "raw"
out = pathlib.Path(__file__).resolve().parent
PINNED = {
    "landscape": ("cms-medicare-landscape", "75f2797b510449fc0d376bbbbeb3c129f6091a697555281559ca28e6e4b8d882"),
    "pbp": ("cms-medicare-pbp", "1720048e668f6c9e4abc47c512e537c013600de12860d28aea4f8308b5e51de4"),
    "stars": ("cms-medicare-stars", "a72f4f4965239e12b3b264c843a71ea6bbd9c655547be5b1f95b3b0df4d1cde7"),
    "crosswalk": ("cms-medicare-crosswalk", "8444385799ffc73ad73983d9baac6811ed8443df0166fe008b17dde1284ece11"),
    "pdp": ("cms-medicare-service-area", "d68e6713a44be0a47cf5a77255dfc692e4087a5de83041d0c6598e0c6c5d5459"),
    "ma": ("cms-medicare-service-area", "85f8e2e7a9f3f95dd3f67ea77328a02ccabb3d61b24822605af046934223e4b9"),
}
PLANS = {"H0028_042_0", "H0028_032_0", "S4802_013_0", "S4802_155_0", "R4182_001_0", "H0504_015_0", "H6515_001_0"}
COUNTIES = {("TX", "Harris"), ("TX", "Fort Bend"), ("TX", "Brazoria"), ("CA", "Los Angeles")}
STATES = {"TX", "CA", "FL", "VI", "GU"}
BIDS = {p.replace("_", "-") for p in PLANS}


def archive(name):
    source, sha = PINNED[name]
    meta = json.loads((data / source / f"{sha}.meta.json").read_text())
    return zipfile.ZipFile(data / source / sha / "payload"), meta


def write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)


def lines(raw):
    return raw.split(b"\r\n")


provenance = {}
# Landscape: selected plans in selected counties, PDP "All Counties" rows for TX.
z, meta = archive("landscape")
member = next(n for n in z.namelist() if n.endswith(".csv"))
raw = z.read(member)
text = raw.decode("utf-8-sig")
reader = csv.reader(io.StringIO(text, newline=""))
header = next(reader)
rows = list(csv.reader(io.StringIO(text, newline="")))
physical = text.split("\r\n") if "\r\n" in text else text.split("\n")
keep = [physical[0]]
idx = {name: i for i, name in enumerate(header)}
for line in physical[1:]:
    if not line:
        continue
    row = next(csv.reader([line]))
    key = row[idx["ContractPlanSegmentID"]]
    place = (row[idx["State Territory Abbreviation"]], row[idx["County Name"]])
    if key in PLANS and (place in COUNTIES or (place[0] == "TX" and place[1] == "All Counties")):
        keep.append(line)
write(out / "landscape" / member, ("﻿" + "\r\n".join(keep) + "\r\n").encode("utf-8"))
provenance["landscape"] = {"url": meta["url"], "sha256": meta["sha256"], "member": member, "rows": len(keep) - 1}

# Service-area files: the first row of each SSA/FIPS pair in the selected states.
for kind in ("pdp", "ma"):
    z, meta = archive(kind)
    member = next(n for n in z.namelist() if n.endswith(".csv"))
    physical = z.read(member).decode("utf-8").split("\r\n")
    head = next(csv.reader([physical[0]]))
    s, f = head.index("SSA"), head.index("FIPS")
    st = head.index("STCD") if "STCD" in head else head.index("State")
    seen, keep = set(), [physical[0]]
    for line in physical[1:]:
        if not line:
            continue
        row = next(csv.reader([line]))
        if row[st] in STATES and (row[s], row[f]) not in seen:
            seen.add((row[s], row[f]))
            keep.append(line)
    write(out / "service-area" / kind / member, ("\r\n".join(keep) + "\r\n").encode("utf-8"))
    provenance[kind] = {"url": meta["url"], "sha256": meta["sha256"], "member": member, "rows": len(keep) - 1}

# PBP: selected bids from every loaded table, their SAS layouts, and a dictionary subset.
TABLES = ["pbp_Section_A", "pbp_Section_D", "pbp_b1a_inpat_hosp", "pbp_b1b_inpat_hosp", "pbp_b2_snf",
          "pbp_b4_emerg_urgent", "pbp_b6_home_health", "pbp_b7_health_prof", "pbp_b8_clin_diag_ther",
          "pbp_b9_outpat_hosp", "pbp_b10_amb_trans", "pbp_b11_dme_prosth_orth_sup", "pbp_b14_preventive",
          "pbp_b16_dental", "pbp_b17_eye_exams_wear", "pbp_b18_hearing_exams_aids", "pbp_mrx", "pbp_mrx_tier",
          "PlanArea", "PlanRegionArea"]
z, meta = archive("pbp")
names = {n.lower(): n for n in z.namelist()}
counts = {}
for table in TABLES:
    data_member, sas_member = names[table.lower() + ".txt"], names[table.lower() + ".sas"]
    physical = lines(z.read(data_member))
    cols = physical[0].decode("cp1252").split("\t")
    bid = cols.index("bid_id")
    keep = [physical[0]]
    for line in physical[1:]:
        if not line:
            continue
        cells = line.split(b"\t")
        if cells[bid].decode("cp1252").replace("_", "-") in BIDS:
            keep.append(line)
    # PlanArea keeps EGHP rows of one employer contract too, so the filter is exercised.
    if table == "PlanArea":
        for line in physical[1:]:
            cells = line.split(b"\t")
            if len(cells) > 1 and cells[bid] == b"E3014_801_0" and cells[cols.index("stcd")] == b"TX":
                keep.append(line)
                if sum(1 for k in keep if b"E3014" in k) >= 3:
                    break
    write(out / "pbp" / data_member, b"\r\n".join(keep) + b"\r\n")
    write(out / "pbp" / sas_member, z.read(sas_member))
    counts[table] = len(keep) - 1
dictionary_member = names["pbp_benefits_2026_dictionary.xlsx"]
fixture_fields = set()
for table in TABLES:
    data_member = names[table.lower() + ".txt"]
    physical = (out / "pbp" / data_member).read_bytes().split(b"\r\n")
    head = physical[0].decode("cp1252").split("\t")
    for line in physical[1:]:
        for name, value in zip(head, line.decode("cp1252").split("\t")):
            if value:
                fixture_fields.add((table.lower(), name.lower()))
dictionary = []
for i, row in enumerate(sheet_rows(z.read(dictionary_member))):
    # Dictionary subset: the fields filled in the fixture rows of three tables (size budget).
    if i == 0 or (
        row[0].lower() in ("pbp_section_d", "pbp_b7_health_prof", "pbp_b4_emerg_urgent")
        and (row[0].lower(), (row[1] if len(row) > 1 else "").lower()) in fixture_fields
    ):
        dictionary.append("\t".join(cell.replace("\t", " ").replace("\n", " ") for cell in row))
write(out / "pbp" / "dictionary.tsv", ("\n".join(dictionary) + "\n").encode("utf-8"))
provenance["pbp"] = {"url": meta["url"], "sha256": meta["sha256"], "rows": counts, "dictionary": dictionary_member}

# Stars (2026 summary is published as xlsx: its subset is written as TSV and rebuilt in the test).
z, meta = archive("stars")
member = next(n for n in z.namelist() if "Summary Ratings" in n and n.endswith(".xlsx"))
contracts = {p[:5] for p in PLANS}
summary = [r for i, r in enumerate(sheet_rows(z.read(member))) if i < 2 or (r and r[0].strip() in contracts)]
write(out / "stars" / "summary.tsv", ("\n".join("\t".join(r) for r in summary) + "\n").encode("utf-8"))
provenance["stars"] = {"url": meta["url"], "sha256": meta["sha256"], "member": member, "rows": len(summary) - 2}
# Crosswalk 2026: rows for the selected plans.
z, meta = archive("crosswalk")
member = next(n for n in z.namelist() if n.endswith(".txt"))
physical = lines(z.read(member))
wanted = {(p[:5], p[6:9]) for p in PLANS}
keep = [physical[0]] + [l for l in physical[1:] if l and (tuple(c.decode("cp1252") for c in l.split(b"\t")[5:7]) in wanted)]
write(out / "crosswalk" / member, b"\r\n".join(keep) + b"\r\n")
provenance["crosswalk"] = {"url": meta["url"], "sha256": meta["sha256"], "member": member, "rows": len(keep) - 1}
(out / "provenance.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
print(json.dumps(provenance, indent=1))

# Part D quarterly public use file (nested zips, pipe-delimited): rows for the fixture plans.
SPUF = ("cms-partd-spuf-quarterly", "16315ea97f043eea8f8539dc2ac2d8343b8054890e12615953767a8b6688d82b")
RXCUIS = {"860975", "861007", "197361", "310965", "1373463", "2200644"}
ZIPS = {"77002", "77030"}
spuf_meta = json.loads((data / SPUF[0] / f"{SPUF[1]}.meta.json").read_text())
outer = zipfile.ZipFile(data / SPUF[0] / SPUF[1] / "payload")
plan_keys = {(p[:5], p[6:9], p[10:].zfill(3)) for p in PLANS}
formularies, ndcs, spuf_counts = set(), set(), {}
order = sorted(outer.namelist(), key=lambda n: (not n.startswith("plan information"), not n.startswith("basic drugs"), n))
for name in order:
    # Pharmacy network parts 3-6 are skipped for time: parts 1-2 already hold the fixture plans.
    if name.startswith("sample") or (name.startswith("pharmacy networks") and not name.endswith(("part 1.zip", "part 2.zip"))):
        continue
    if os.environ.get("PARTD_ONLY") and not any(name.startswith(x) for x in os.environ["PARTD_ONLY"].split(",")):
        continue
    inner = zipfile.ZipFile(outer.open(name))
    member = inner.namelist()[0]
    keep = []
    with inner.open(member) as f:
        head = f.readline()
        cols = head.decode("cp1252").rstrip("\r\n").split("|")
        ix = {c: i for i, c in enumerate(cols)}
        keep.append(head.rstrip(b"\r\n"))
        for raw in f:
            cells = raw.decode("cp1252").rstrip("\r\n").split("|")
            if "FORMULARY_ID" in ix and "CONTRACT_ID" not in ix:
                ok = cells[ix["FORMULARY_ID"]] in formularies and cells[ix["RXCUI"]] in RXCUIS
                if ok:
                    ndcs.add(cells[ix["NDC"]])
            elif "COUNTY_CODE" in ix and "CONTRACT_ID" not in ix:
                ok = cells[ix["COUNTY_CODE"]][:2] == "45"
            else:
                seg = cells[ix["SEGMENT_ID"]].zfill(3) if "SEGMENT_ID" in ix else None
                ok = any(cells[ix["CONTRACT_ID"]] == c and cells[ix["PLAN_ID"]] == p and (seg is None or seg == s) for c, p, s in plan_keys)
                if ok and "PHARMACY_ZIPCODE" in ix:
                    ok = cells[ix["PHARMACY_ZIPCODE"]] in ZIPS
                if ok and "RXCUI" in ix and "DISEASE" not in ix:
                    ok = cells[ix["RXCUI"]] in RXCUIS or len(keep) < 6
                if ok and "UNIT_COST" in ix:
                    ok = cells[ix["NDC"]] in ndcs
                if ok and "FORMULARY_ID" in ix:
                    formularies.add(cells[ix["FORMULARY_ID"]])
            if ok:
                keep.append(raw.rstrip(b"\r\n"))
    write(out / "partd" / name / member, b"\r\n".join(keep) + b"\r\n")
    spuf_counts[name] = len(keep) - 1
provenance["partd"] = {"url": spuf_meta["url"], "sha256": spuf_meta["sha256"], "rows": spuf_counts}
(out / "provenance.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
print(json.dumps(spuf_counts, indent=1))
