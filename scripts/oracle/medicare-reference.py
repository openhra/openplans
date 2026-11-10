"""Independent reader of the raw CMS Medicare archives (csv, zipfile, Decimal; no shared code).

Usage: python3 -I medicare-reference.py LANDSCAPE.zip PDP_SA.zip MA_SA.zip PBP.zip YEAR
Prints JSON: expected per-segment cells in cents, per-county plan sets, per-plan SSA sets.
"""
import csv, decimal, io, json, re, sys, zipfile

landscape, pdp_sa, ma_sa, pbp, year = sys.argv[1:6]
year = int(year)


def cents(text):
    t = text.strip()
    if t == "" or t == "Not Applicable":
        return None if t == "" else "n/a"
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()").replace("$", "").replace(",", "")
    value = decimal.Decimal(t) * 100
    assert value == value.to_integral_value(), text
    return -int(value) if neg else int(value)


def stars(text):
    t = text.strip()
    return float(t) if re.fullmatch(r"[1-5](\.[05])?", t) else t


def key_name(name):
    n = name.lower()
    n = re.sub(r" (county|parish|borough|census area|municipality|city and borough)$", "", n)
    n = re.sub(r"\bsaint\b", "st", n)
    return re.sub(r"[^a-z0-9]", "", n)


def csv_rows(path, pattern):
    with zipfile.ZipFile(path) as z:
        member = next(n for n in z.namelist() if re.search(pattern, n))
        yield from csv.DictReader(io.TextIOWrapper(z.open(member), encoding="utf-8-sig"))


# SSA -> FIPS: PDP file primary; MA adds SSA codes the PDP file lacks.
pdp_pairs, ma_pairs = {}, {}
names = {}
for path, pairs in ((pdp_sa, pdp_pairs), (ma_sa, ma_pairs)):
    for row in csv_rows(path, r"_Cnty_SA_\d{4}_\d{2}\.csv$"):
        ssa, fips = row["SSA"].strip(), row["FIPS"].strip()
        if ssa and fips:
            pairs.setdefault(ssa, set()).add(fips)
            state = (row.get("STCD") or row.get("State") or "").strip()
            county = (row.get("COUNTY") or row.get("County") or "").strip()
            if path == pdp_sa or ssa not in pdp_pairs:
                names.setdefault((state, key_name(county)), set()).add(fips)
ssa_map = {k: set(v) for k, v in pdp_pairs.items()}
for k, v in ma_pairs.items():
    if k not in ssa_map:
        ssa_map[k] = set(v)

MONEY = ["Part C Premium", "Part D Basic Premium", "Part D Supplemental Premium", "Part D Total Premium",
         "Monthly Consolidated Premium (Part C + D)", "Annual Part D Deductible Amount",
         "Part D Out-of-Pocket (OOP) Threshold", "In-Network Maximum Out-of-Pocket (MOOP) Amount"]
STARS = ["Overall Star Rating", "Part C Summary Star Rating", "Part D Summary Star Rating"]
segments, counties, rows = {}, {}, 0
for row in csv_rows(landscape, r"CY\d{4}_Landscape_\d{6}\.csv$"):
    rows += 1
    assert int(row["Contract Year"]) == year
    key = f'{row["Contract ID"].strip()}-{row["Plan ID"].strip().zfill(3)}-{int(row["Segment ID"])}'
    if int(row["Plan ID"]) >= 800:
        continue
    segments[key] = {"money": {m: cents(row[m]) for m in MONEY}, "stars": {s: stars(row[s]) for s in STARS},
                     "category": row["Contract Category Type"].strip(), "name": row["Plan Name"].strip()}
    state, county = row["State Territory Abbreviation"].strip(), row["County Name"].strip()
    if county == "All Counties":
        counties.setdefault(f"ALL:{state}", []).append([key, cents(row["Low Income Premium Subsidy (LIPS) Amount"])])
        continue
    fips = names.get((state, key_name(county)))
    assert fips and len(fips) == 1, (state, county)
    counties.setdefault(next(iter(fips)), []).append([key, cents(row["Low Income Premium Subsidy (LIPS) Amount"])])

areas = {}
with zipfile.ZipFile(pbp) as z:
    member = next(n for n in z.namelist() if n.lower() == "planarea.txt")
    with z.open(member) as f:
        head = f.readline().decode("cp1252").rstrip("\r\n").split("\t")
        ix = {n: head.index(n) for n in ("contract_id", "plan_id", "segment_id", "county_code", "eghp_flag")}
        for raw in f:
            cells = raw.decode("cp1252").rstrip("\r\n").split("\t")
            if cells[ix["eghp_flag"]] == "1" or int(cells[ix["plan_id"]]) >= 800:
                continue
            key = f'{cells[ix["contract_id"]]}-{cells[ix["plan_id"]].zfill(3)}-{int(cells[ix["segment_id"]])}'
            areas.setdefault(key, set()).add(cells[ix["county_code"]])

print(json.dumps({
    "rows": rows,
    "segments": segments,
    "counties": counties,
    "areas": {k: sorted(v) for k, v in areas.items()},
    "ssa_map": {k: sorted(v) for k, v in ssa_map.items()},
}, separators=(",", ":")))
