"""Independent reader of a CMS Part D public use archive (zipfile, hashlib; no shared code).

Usage: python3 -I medicare-part-d-reference.py SPUF.zip
Prints JSON: row counts, a digest of every row group, each plan's formularies and suppression
flag, and a sample of drug lookups with the listing the raw rows give.
"""
import hashlib, io, json, re, sys, zipfile

TABLES = {
    "plan": "plan information ",
    "formulary": "basic drugs formulary file ",
    "excluded_drug": "excluded drugs formulary file ",
    "indication_coverage": "indication based coverage formulary file ",
    "beneficiary_cost": "beneficiary cost file ",
    "insulin_cost": "insulin beneficiary cost file ",
    "county": "geographic locator file ",
}


def table_rows(outer, prefix):
    """Yields (header, cells) for each row of the table's inner archives, in name order."""
    for name in sorted(n for n in outer.namelist() if n.lower().startswith(prefix)):
        with zipfile.ZipFile(io.BytesIO(outer.read(name))) as inner:
            member = next(n for n in inner.namelist() if n.lower().endswith(".txt"))
            with inner.open(member) as handle:
                text = io.TextIOWrapper(handle, encoding="cp1252", newline="")
                head = [c.strip().upper() for c in text.readline().rstrip("\r\n").split("|")]
                assert len(set(head)) == len(head), head
                for line in text:
                    cells = [c.strip() for c in line.rstrip("\r\n").split("|")]
                    cells += [""] * (len(head) - len(cells))
                    yield head, cells[: len(head)]


def plan_key(row, segment=True):
    seg = int(row["SEGMENT_ID"]) if segment else 0
    return f'{row["CONTRACT_ID"]}-{row["PLAN_ID"].zfill(3)}-{seg}'


def tier_of(text):
    return int(text) if re.fullmatch(r"\d{1,2}", text) else None


def flag(text):
    assert text in ("Y", "N", ""), text
    return text == "Y"


def digest(lines):
    return hashlib.sha256("\n".join(sorted(lines)).encode("utf-8")).hexdigest()


headers, rows, lines = {}, {}, {t: {} for t in TABLES}
plans, formulary, costs = {}, {}, {}
with zipfile.ZipFile(sys.argv[1]) as outer:
    for table, prefix in TABLES.items():
        rows[table] = 0
        for head, cells in table_rows(outer, prefix):
            headers[table] = head
            rows[table] += 1
            row = dict(zip(head, cells))
            line = "|".join(cells)
            if table == "plan":
                group = plan_key(row)
                suppressed = flag(row["PLAN_SUPPRESSED_YN"])
                line += f"#{json.dumps(suppressed)}"
                entry = plans.setdefault(group, {"formularies": set(), "suppressed": False})
                entry["formularies"].add(row["FORMULARY_ID"])
                entry["suppressed"] = entry["suppressed"] or suppressed
            elif table == "formulary":
                group = row["FORMULARY_ID"]
                tier = tier_of(row["TIER_LEVEL_VALUE"])
                line += f"#{json.dumps(tier)}"
                limit = None
                if flag(row["QUANTITY_LIMIT_YN"]):
                    limit = [row["QUANTITY_LIMIT_AMOUNT"] or None, row["QUANTITY_LIMIT_DAYS"] or None]
                formulary.setdefault(group, {}).setdefault(row["RXCUI"], []).append(
                    [row["NDC"], tier, flag(row["PRIOR_AUTHORIZATION_YN"]), flag(row["STEP_THERAPY_YN"]), limit])
            elif table == "county":
                group = row["COUNTY_CODE"]
            else:
                with_segment = table in ("beneficiary_cost", "insulin_cost")
                group = plan_key(row, with_segment)
                tier = tier_of(row.get("TIER", ""))
                line += f'#{json.dumps(tier)}#{row.get("RXCUI", "")}'
                if table == "beneficiary_cost":
                    amount = row["COST_AMT_PREF"]
                    costs.setdefault(group, []).append(
                        [tier, None if row["COST_TYPE_PREF"] == "0" or amount == "" else amount])
            lines[table].setdefault(group, []).append(line)

# One plan per formulary, three RxCUIs each (first, middle, last), plus one RxCUI it does not list.
by_formulary = {}
for key in sorted(plans):
    entry = plans[key]
    if not entry["suppressed"] and len(entry["formularies"]) == 1:
        by_formulary.setdefault(next(iter(entry["formularies"])), key)
sample, absent = [], []
for formulary_id in sorted(formulary):
    key = by_formulary.get(formulary_id)
    if key is None:
        continue
    drugs = formulary[formulary_id]
    ordered = sorted(drugs)
    for rxcui in sorted({ordered[0], ordered[len(ordered) // 2], ordered[-1]}):
        packages = sorted(drugs[rxcui], key=lambda package: package[0])
        tiers = {package[1] for package in packages if package[1] is not None}
        cost = sorted((c for c in costs.get(key, []) if c[0] in tiers), key=lambda c: c[0])
        sample.append({"plan_key": key, "rxcui": rxcui, "status": "listed", "formulary_id": formulary_id,
                       "packages": packages, "tier_cost_sharing": cost})
    missing = next(str(n) for n in range(1, 10 ** 6) if str(n) not in drugs)
    absent.append({"plan_key": key, "rxcui": missing, "status": "not_listed", "formulary_id": formulary_id,
                   "packages": [], "tier_cost_sharing": []})
suppressed = sorted(key for key, entry in plans.items() if entry["suppressed"])[:25]

print(json.dumps({
    "headers": headers,
    "rows": rows,
    "groups": {t: {g: [len(v), digest(v)] for g, v in groups.items()} for t, groups in lines.items()},
    "plans": {k: {"formularies": sorted(v["formularies"]), "suppressed": v["suppressed"]} for k, v in plans.items()},
    "sample": sample + absent,
    "suppressed_sample": suppressed,
}, separators=(",", ":")))
