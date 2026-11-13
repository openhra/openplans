"""Independent reference for Part D plan-average drug prices, read only from the cached SPUF archive.

Run with `python3 -I`. It imports nothing from the application and does exact Decimal arithmetic.
For each case (plan, proxy NDC, days supply, quantity in NDC units, channel, phase) it reads the
raw Plan Information, Basic Drugs Formulary, Beneficiary Cost, Pricing and Pharmacy Networks
members and reports:

- unit_cost_total: UNIT_COST x quantity (reading R0: the unit cost already includes the fee);
- total_lowest_fee / total_highest_fee: R0 plus the lowest or highest readable dispensing fee of
  an applicable type over in-area retail network pharmacies of the requested preferred status;
- gross: a value only when every reading gives the same cents, otherwise unknown;
- member_cost: the enrollee's initial-coverage cost sharing under the plan's tier row, a value
  only when every reading gives the same cents;
- maximum_fair_price_total: for a drug the formulary flags as selected, the per-unit maximum fair
  price in effect on the fill date (CMS Selected Drug List and Maximum Fair Price file, passed with
  --mfp-file) times the quantity, rounded to the cent.

A selected drug's readings replace R0 with that total: the total plus the lowest and plus the
highest selected-drug fee (the selected fee, or the brand fee where none is filed). The total
excludes the fee, so there is no reading without one, and no floor price applies. The fill date is
January 2 of the contract year, as the application check sends it.

A missing, zero or unreadable price is unknown with a reason, never $0. No days supply other than
the fill's own is used, and no fee is averaged or assumed.
"""
import argparse
import contextlib
import hashlib
import json
import re
import shutil
import sys
import tempfile
import zipfile
from decimal import ROUND_HALF_UP, Decimal, getcontext

getcontext().prec = 60

PREFIXES = {
    "plan": "plan information ",
    "formulary": "basic drugs formulary file ",
    "beneficiary_cost": "beneficiary cost file ",
    "pharmacy_network": "pharmacy networks file ",
    "pricing": "pricing file ",
}
# Beneficiary Cost DAYS_SUPPLY codes (record layout): 1 = 30 days, 2 = 90 days, 4 = 60 days.
SUPPLY_CODE = {30: "1", 60: "4", 90: "2"}
INITIAL_COVERAGE = "1"
CHANNELS = {
    "preferred_retail": ("PREF", "Y", "retail"),
    "standard_retail": ("NONPREF", "N", "retail"),
    "preferred_mail": ("MAIL_PREF", "Y", "mail"),
    "standard_mail": ("MAIL_NONPREF", "N", "mail"),
}
# Annual out-of-pocket threshold and the largest initial-coverage share a selected drug subsidy or
# manufacturer discount can take (10 percent in 2026, CY 2026 Rate Announcement).
THRESHOLD = {2026: Decimal("2100")}
INITIAL_SUBSIDY_SHARE = {2026: Decimal("0.10")}
CENT = Decimal("0.01")
FIGURES = ("unit_cost_total", "total_lowest_fee", "total_highest_fee", "gross", "member_cost",
           "maximum_fair_price_total")
MFP_UNIT_PRICE = re.compile(r"\$?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{1,6})")
US_DATE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
FOUR_PLACES = re.compile(r"\d{1,8}(?:\.\d{1,4})?|\.\d{1,4}")
DOLLARS = re.compile(r"\d{0,12}(?:\.\d{1,2})?")
RATE = re.compile(r"\d*(?:\.\d{1,4})?")


@contextlib.contextmanager
def inner_table(outer, name):
    # Inner ZIPs need seeking. Spill to disk instead of holding a 400 MB member in memory.
    with tempfile.TemporaryFile() as spool:
        with outer.open(name) as source:
            shutil.copyfileobj(source, spool, 1024 * 1024)
        spool.seek(0)
        with zipfile.ZipFile(spool) as inner:
            member = next(i for i in inner.infolist() if i.filename.lower().endswith(".txt"))
            with inner.open(member) as source:
                yield member.filename, source


def plan_key(contract, plan, segment):
    return f"{contract.strip()}-{plan.strip().zfill(3)}-{int(segment)}"


def table_rows(path, table, plans=None):
    """(member, data row number from 1, row) for one table; large tables skip other plans early."""
    with zipfile.ZipFile(path) as outer:
        names = sorted(n for n in outer.namelist() if n.lower().startswith(PREFIXES[table]))
        for name in names:
            with inner_table(outer, name) as (member, source):
                head = [c.strip().upper() for c in source.readline().decode("cp1252").rstrip("\r\n").split("|")]
                assert len(head) == len(set(head)), head
                prefixed = plans is not None and head[:3] == ["CONTRACT_ID", "PLAN_ID", "SEGMENT_ID"]
                previous, chosen = None, False
                for number, line in enumerate(source, 1):
                    if prefixed:
                        parts = line.split(b"|", 3)
                        if parts[:3] != previous:
                            previous = parts[:3]
                            chosen = plan_key(*(p.decode() for p in previous)) in plans
                        if not chosen:
                            continue
                    cells = [c.strip() for c in line.decode("cp1252").rstrip("\r\n").split("|")]
                    yield member, number, dict(zip(head, cells))
                print(f"{table}: {name}", file=sys.stderr, flush=True)


def four_places(text):
    """A 9(8.4) cell as a Decimal; None when blank, '.' or unreadable."""
    return Decimal(text) if FOUR_PLACES.fullmatch(text or "") else None


def cents(value):
    return int((value / CENT).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def known(value_cents):
    return {"status": "value", "cents": value_cents}


def unknown(reason):
    return {"status": "unknown", "reason": reason}


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


# ---------- reading the archive ----------


def new_fee_range():
    return {"min": None, "max": None, "readable": 0, "missing": 0}


def widen(entry, value):
    if value is None:
        entry["missing"] += 1
        return
    entry["readable"] += 1
    entry["min"] = value if entry["min"] is None or value < entry["min"] else entry["min"]
    entry["max"] = value if entry["max"] is None or value > entry["max"] else entry["max"]


def collect(path, cases):
    """Every raw fact the cases need, from one pass over each member."""
    plans = {c["plan_key"] for c in cases}
    facts = {"plans": {}, "contract_years": set(), "formulary": {}, "cost": {}, "pricing": {}, "fees": {}}
    for member, number, row in table_rows(path, "plan"):
        key = plan_key(row["CONTRACT_ID"], row["PLAN_ID"], row["SEGMENT_ID"])
        if key not in plans:
            continue
        entry = facts["plans"].setdefault(key, {"formularies": set(), "suppressed": False, "deductibles": set(), "rows": []})
        entry["formularies"].add(row["FORMULARY_ID"])
        entry["suppressed"] |= row["PLAN_SUPPRESSED_YN"] == "Y"
        entry["deductibles"].add(row["DEDUCTIBLE"])
        if len(entry["rows"]) < 3:
            entry["rows"].append({"member": member, "row": number})
    formularies = {f for p in facts["plans"].values() for f in p["formularies"]}
    ndcs = {c["ndc"] for c in cases}
    for member, number, row in table_rows(path, "formulary"):
        if row["FORMULARY_ID"] in formularies and row["NDC"] in ndcs:
            facts["formulary"].setdefault((row["FORMULARY_ID"], row["NDC"]), []).append(
                {"member": member, "row": number, "tier": row["TIER_LEVEL_VALUE"],
                 "selected": row.get("SELECTED_DRUG_YN", ""), "year": row["CONTRACT_YEAR"]})
    for member, number, row in table_rows(path, "beneficiary_cost", plans):
        key = plan_key(row["CONTRACT_ID"], row["PLAN_ID"], row["SEGMENT_ID"])
        if row["COVERAGE_LEVEL"] == INITIAL_COVERAGE:
            facts["cost"].setdefault((key, row["TIER"], row["DAYS_SUPPLY"]), []).append({"member": member, "row": number, "cells": row})
    for member, number, row in table_rows(path, "pricing", plans):
        key = plan_key(row["CONTRACT_ID"], row["PLAN_ID"], row["SEGMENT_ID"])
        if row["NDC"] in ndcs:
            facts["pricing"].setdefault((key, row["NDC"]), {}).setdefault(row["DAYS_SUPPLY"], []).append(
                {"member": member, "row": number, "unit_cost": row["UNIT_COST"]})
    for member, number, row in table_rows(path, "pharmacy_network", plans):
        if row["PHARMACY_RETAIL"] != "Y" or row["IN_AREA_FLAG"] != "1":
            continue
        key = plan_key(row["CONTRACT_ID"], row["PLAN_ID"], row["SEGMENT_ID"])
        group = facts["fees"].setdefault((key, row["PREFERRED_STATUS_RETAIL"]), {
            "pharmacies": 0, "floor_max": None, "floor_unreadable": 0, "members": set(), "ranges": {}})
        group["pharmacies"] += 1
        group["members"].add(member)
        floor = four_places(row["FLOOR_PRICE"])
        if floor is None:
            group["floor_unreadable"] += 1
        elif group["floor_max"] is None or floor > group["floor_max"]:
            group["floor_max"] = floor
        for days in SUPPLY_CODE:
            brand = four_places(row[f"BRAND_DISPENSING_FEE_{days}"])
            generic = four_places(row[f"GENERIC_DISPENSING_FEE_{days}"])
            # The data header says SELECTED_DISPENSING_FEE_*; the layout says SELECTED_DRUG_DISPENSING_FEE_*.
            selected = four_places(row.get(f"SELECTED_DISPENSING_FEE_{days}", row.get(f"SELECTED_DRUG_DISPENSING_FEE_{days}")))
            ranges = group["ranges"]
            widen(ranges.setdefault((days, "brand_or_generic"), new_fee_range()), brand)
            widen(ranges.setdefault((days, "brand_or_generic"), new_fee_range()), generic)
            # A selected drug's fee falls back to the brand fee where the selected fee is missing.
            widen(ranges.setdefault((days, "selected_or_brand"), new_fee_range()), selected if selected is not None else brand)
    return facts


def read_mfp_file(path):
    """{NDC-11: [(from, to or None, unit price or None, row)]} from the CMS zip's CSV member."""
    import csv
    import io

    periods = {}
    if path is None:
        return None
    with zipfile.ZipFile(path) as archive:
        members = [n for n in archive.namelist() if n.lower().endswith(".csv")]
        assert len(members) == 1, members
        text = archive.read(members[0]).decode("utf-8-sig")
    rows = list(csv.reader(io.StringIO(text, newline="")))
    head = rows[0]
    col = {name: head.index(name) for name in ("NDC-11", "MFP Effective Date", "MFP End Date", "NDC-9 MFP per Unit Price")}

    def iso(cell):
        match = US_DATE.fullmatch(cell.strip())
        return f"{match[3]}-{match[1]}-{match[2]}" if match else None

    for number, cells in enumerate(rows[1:], 2):
        if not any(c.strip() for c in cells):
            continue
        start = iso(cells[col["MFP Effective Date"]])
        end_text = cells[col["MFP End Date"]].strip()
        end = iso(end_text) if end_text else None
        if start is None or (end_text and end is None):
            raise ValueError(f"row {number}: unreadable date")
        if end is not None and end < start:
            continue  # a deselection row: it never applies
        match = MFP_UNIT_PRICE.fullmatch(cells[col["NDC-9 MFP per Unit Price"]].strip())
        price = Decimal(match[1].replace(",", "") + "." + match[2]) if match else None
        ndc = cells[col["NDC-11"]].strip().replace("-", "")
        periods.setdefault(ndc, []).append((start, end, price, number))
    return periods


def mfp_in_effect(mfp, ndc, date, evidence):
    """(unit price, None) for the NDC on the date, or (None, reason)."""
    if mfp is None:
        return None, "maximum_fair_price_not_loaded"
    found = [p for p in mfp.get(ndc, []) if p[0] <= date and (p[1] is None or p[1] >= date)]
    evidence["mfp_rows"] = [p[3] for p in found]
    if not found:
        return None, "maximum_fair_price_not_in_effect"
    prices = {p[2] for p in found}
    if len(prices) != 1:
        return None, "maximum_fair_price_rows_disagree"
    price = prices.pop()
    if price is None or price <= 0:
        return None, "maximum_fair_price_not_in_effect"
    return price, None


# ---------- answering one case ----------


def all_unknown(reason):
    return {f: unknown(reason) for f in FIGURES}


def price_readings(case, facts, plan, selected, evidence):
    """The gross readings in exact dollars, or (None, reason). An unbounded reading is None."""
    channel = CHANNELS.get(case["channel"])
    if channel is None:
        return None, "channel_unknown"
    if channel[2] != "retail":
        return None, "unit_cost_retail_only"
    days = case["days_supply"]
    if days not in SUPPLY_CODE:
        return None, "price_days_supply_not_published"
    if case["unit"] != "ndc_unit":
        return None, "quantity_unit_not_ndc_unit"
    quantity = four_places(case["quantity"])
    if quantity is None or quantity <= 0:
        return None, "quantity_unreadable"
    prices = {int(d): rows for d, rows in facts["pricing"].get((plan, case["ndc"]), {}).items()}
    price = prices.get(days)
    if price is None:
        return None, "price_days_supply_not_published"
    evidence["pricing"] = [{"member": r["member"], "row": r["row"], "unit_cost": r["unit_cost"]} for r in price]
    if len({r["unit_cost"] for r in price}) != 1:
        return None, "price_rows_disagree"
    unit_cost = four_places(price[0]["unit_cost"])
    if unit_cost is None or unit_cost <= 0:
        return None, "unit_cost_unreadable"
    r0 = unit_cost * quantity
    readings = {"r0": r0}
    group = facts["fees"].get((plan, channel[1]))
    fee = (group or {}).get("ranges", {}).get((days, "selected_or_brand" if selected else "brand_or_generic"))
    evidence["fees"] = None if group is None else {
        "preferred_status_retail": channel[1], "pharmacies": group["pharmacies"],
        "fee_type": "selected_or_brand" if selected else "brand_or_generic",
        "readable": fee["readable"], "missing": fee["missing"],
        "min": None if fee["min"] is None else str(fee["min"]), "max": None if fee["max"] is None else str(fee["max"]),
        "floor_max": None if group["floor_max"] is None else str(group["floor_max"]),
        "floor_unreadable": group["floor_unreadable"], "members": sorted(group["members"])}
    if selected:
        # The maximum fair price replaces the unit cost; the fee comes on top and no floor applies.
        price, reason = mfp_in_effect(facts.get("mfp"), case["ndc"], f'{case["contract_year"]}-01-02', evidence)
        if price is None:
            evidence["mfp_reason"] = reason
            return {"r0": r0, "mfp_unknown": None}, None
        mfp = Decimal(cents(price * quantity)) * CENT
        evidence["mfp_unit_price"] = str(price)
        readings = {"r0": r0, "mfp": mfp}
        if fee and fee["readable"]:
            readings["low"] = mfp + fee["min"]
            readings["high"] = mfp + fee["max"]
        else:
            readings["fee_unknown"] = None
        return readings, None
    if fee and fee["readable"]:
        readings["low"] = r0 + fee["min"]
        readings["high"] = r0 + fee["max"]
    else:
        readings["fee_unknown"] = None
    if group and (group["floor_unreadable"] or (group["floor_max"] is not None and group["floor_max"] > r0)):
        # A floor no file explains could raise the price; an unreadable floor is not known to be 0.
        readings["floor"] = None if group["floor_unreadable"] else group["floor_max"]
    return readings, None


def disagreement(readings):
    if "floor" in readings:
        return "floor_price_may_apply"
    return "dispensing_fee_unknown"


def member_cost(case, facts, plan, tier, readings, year, evidence, base=None):
    if case["phase"] != "initial_coverage":
        return unknown("phase_not_supported")
    rows = facts["cost"].get((plan, tier, SUPPLY_CODE[case["days_supply"]]), [])
    if not rows:
        return unknown("cost_sharing_row_missing")
    evidence["cost"] = [{"member": r["member"], "row": r["row"]} for r in rows]
    suffix = CHANNELS[case["channel"]][0]
    fields = [f"{f}_{suffix}" for f in ("COST_TYPE", "COST_AMT", "COST_MIN_AMT", "COST_MAX_AMT")]
    cells = {tuple(r["cells"][f] for f in fields) for r in rows}
    if len(cells) != 1:
        return unknown("duplicate_cost_rows_disagree")
    kind, amount, low, high = next(iter(cells))
    if kind == "0":
        return unknown("channel_not_offered")
    if kind not in ("1", "2"):
        return unknown("unknown_cost_type")
    bounds = []
    for bound in (low, high):
        if not DOLLARS.fullmatch(bound) or bound in ("", "."):
            return unknown("unreadable_amount")
        bounds.append(Decimal(bound))
    if any(bounds):
        # Minimum and maximum cost sharing are left to the application's bound rules.
        return unknown("cost_sharing_bounds_not_modelled")
    if kind == "1":
        if not DOLLARS.fullmatch(amount) or amount in ("", "."):
            return unknown("unreadable_amount")
        copay, rate = Decimal(amount), None
    else:
        if not RATE.fullmatch(amount) or amount in ("", ".") or Decimal(amount) > 1:
            return unknown("unreadable_rate")
        copay, rate = None, Decimal(amount)
    deductibles = facts["plans"][plan]["deductibles"]
    if len(deductibles) != 1 or not DOLLARS.fullmatch(next(iter(deductibles)) or "x"):
        return unknown("plan_deductible_unreadable")
    # The case's opening state: the plan deductible is met and nothing else counts toward TrOOP.
    remaining = THRESHOLD[year] - Decimal(next(iter(deductibles)))
    cap = 1 - INITIAL_SUBSIDY_SHARE[year]
    values, blocked = set(), None
    # Each reading's charge, so a bounded answer can be checked end by end.
    charges = evidence["member_charges"] = {}
    for key, gross in readings.items():
        if gross is None and key == "mfp_unknown":
            values.add(None)
            charges[key] = None
            continue
        if gross is None:
            # A fee or floor no file settles: only a copay well below R0 holds for any gross above it.
            # A selected drug's lowest price is its maximum fair price.
            r0 = Decimal(cents(readings["r0"] if base is None else base)) * CENT
            if copay is None or copay > cap * r0:
                values.add(None)
                charges[key] = None
                continue
            charge = copay
        else:
            gross = Decimal(cents(gross)) * CENT
            charge = min(copay, gross) if copay is not None else Decimal(cents(rate * gross)) * CENT
            if charge > cap * gross:
                blocked = blocked or "subsidy_cap_may_bind"
        if charge > remaining:
            blocked = "crosses_out_of_pocket_threshold"
        values.add(cents(charge))
        charges[key] = cents(charge)
    if blocked:
        return unknown(blocked)
    if "mfp_unknown" in readings:
        return unknown(evidence["mfp_reason"])
    if len(values) != 1 or None in values:
        return unknown(disagreement(readings))
    return known(values.pop())


def answer(case, facts):
    evidence = {}
    result = {"case_id": case["case_id"], "evidence": evidence}
    year = case["contract_year"]
    plan = case["plan_key"]
    info = facts["plans"].get(plan)
    if year not in THRESHOLD:
        return {**result, "figures": all_unknown("pricing_not_published_for_year")}
    if info is None:
        return {**result, "figures": all_unknown("plan_not_found")}
    evidence["plan"] = info["rows"]
    if info["suppressed"]:
        return {**result, "figures": all_unknown("plan_suppressed_by_cms")}
    if len(info["formularies"]) != 1:
        return {**result, "figures": all_unknown("plan_formulary_ambiguous")}
    rows = facts["formulary"].get((next(iter(info["formularies"])), case["ndc"]), [])
    if not rows:
        return {**result, "figures": all_unknown("proxy_ndc_not_on_formulary")}
    evidence["formulary"] = [{"member": r["member"], "row": r["row"]} for r in rows]
    if {r["year"] for r in rows} != {str(year)}:
        return {**result, "figures": all_unknown("pricing_release_mismatch")}
    if len({(r["tier"], r["selected"]) for r in rows}) != 1 or not re.fullmatch(r"\d{1,2}", rows[0]["tier"]):
        return {**result, "figures": all_unknown("formulary_tier_unknown")}
    tier, selected = rows[0]["tier"], rows[0]["selected"] == "Y"
    result["tier"], result["selected_drug"] = int(tier), selected
    readings, reason = price_readings(case, facts, plan, selected, evidence)
    if readings is None:
        return {**result, "figures": all_unknown(reason)}
    result["readings"] = {k: None if v is None else str(v) for k, v in readings.items()}
    fee_known = "low" in readings
    figures = {
        "unit_cost_total": known(cents(readings["r0"])),
        "total_lowest_fee": known(cents(readings["low"])) if fee_known else unknown("dispensing_fee_unknown"),
        "total_highest_fee": known(cents(readings["high"])) if fee_known else unknown("dispensing_fee_unknown"),
        "maximum_fair_price_total": unknown("drug_not_selected"),
    }
    gross_readings = dict(readings)
    if selected:
        # The plan-average unit cost is information only; the maximum fair price readings decide.
        gross_readings.pop("r0")
        if "mfp_unknown" in readings:
            for name in ("total_lowest_fee", "total_highest_fee", "maximum_fair_price_total"):
                figures[name] = unknown(evidence["mfp_reason"])
            figures["gross"] = unknown(evidence["mfp_reason"])
            figures["member_cost"] = unknown(evidence["mfp_reason"])
            return {**result, "figures": figures}
        base = gross_readings.pop("mfp")
        figures["maximum_fair_price_total"] = known(cents(base))
    gross = {None if v is None else cents(v) for v in gross_readings.values()}
    figures["gross"] = (known(gross.pop()) if len(gross) == 1 and None not in gross
                        else unknown(disagreement(gross_readings)))
    figures["member_cost"] = member_cost(case, facts, plan, tier, gross_readings if selected else readings, year,
                                         evidence, base if selected else None)
    return {**result, "figures": figures}


# ---------- the fixed sample ----------


def make_cases(path, count):
    """A deterministic sample across plans, tiers and days supplies, plus the edge cases."""
    plans, contract_year = {}, None
    for _, _, row in table_rows(path, "plan"):
        entry = plans.setdefault(plan_key(row["CONTRACT_ID"], row["PLAN_ID"], row["SEGMENT_ID"]),
                                 {"formularies": set(), "suppressed": False})
        entry["formularies"].add(row["FORMULARY_ID"])
        entry["suppressed"] |= row["PLAN_SUPPRESSED_YN"] == "Y"
    ordered = sorted(plans, key=sha)
    wanted = {f for p in ordered[:400] for f in plans[p]["formularies"]}
    drugs = {}
    for _, _, row in table_rows(path, "formulary"):
        if row["FORMULARY_ID"] in wanted:
            contract_year = int(row["CONTRACT_YEAR"])
            drugs.setdefault(row["FORMULARY_ID"], {}).setdefault((row["TIER_LEVEL_VALUE"], row["SELECTED_DRUG_YN"] == "Y"), set()).add(row["NDC"])
    cases, base = [], count - 6
    channels = ("preferred_retail", "standard_retail") * 4 + ("preferred_mail",) + ("standard_retail",)
    days_cycle = (30, 60, 90)

    def add(plan, ndc, days, channel, **extra):
        cases.append({"case_id": f"c{len(cases) + 1:03d}", "contract_year": contract_year, "plan_key": plan, "ndc": ndc,
                      "days_supply": days, "quantity": str(extra.pop("quantity", days)), "unit": extra.pop("unit", "ndc_unit"),
                      "channel": channel, "phase": extra.pop("phase", "initial_coverage"),
                      "classification": {"insulin": False, "acip_vaccine": False}, **extra})

    suppressed = next((p for p in ordered if plans[p]["suppressed"]), None)
    for plan in ordered:
        info = plans[plan]
        if len(cases) >= base:
            break
        if info["suppressed"] or len(info["formularies"]) != 1:
            continue
        groups = drugs.get(next(iter(info["formularies"])), {})
        for group in sorted(groups, key=lambda g: (int(g[0] or 0), g[1])):
            if len(cases) >= base:
                break
            ndc = min(groups[group], key=lambda n: sha(f"{plan}|{n}"))
            add(plan, ndc, days_cycle[len(cases) % 3], channels[len(cases) % len(channels)])
    first = cases[0]
    other = next(c["ndc"] for c in cases if c["plan_key"] != first["plan_key"] and c["ndc"] not in
                 {n for g in drugs[next(iter(plans[first["plan_key"]]["formularies"]))].values() for n in g})
    add(first["plan_key"], first["ndc"], 45, "preferred_retail")
    add(first["plan_key"], first["ndc"], 30, "preferred_retail", unit="mL")
    add(first["plan_key"], first["ndc"], 30, "preferred_retail", phase="catastrophic")
    add(first["plan_key"], first["ndc"], 30, "standard_mail")
    add(first["plan_key"], other, 30, "preferred_retail")
    if suppressed:
        ndc = min(n for g in drugs.get(next(iter(plans[suppressed]["formularies"])), {"": {"00000000000"}}).values() for n in g)
        add(suppressed, ndc, 30, "preferred_retail")
    return {"contract_year": contract_year, "selection": "plans ordered by SHA-256 of the plan key; per plan, one NDC per (tier, selected flag) group, the lowest SHA-256 of plan|NDC; days supply and channel rotate", "cases": cases}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("archive")
    parser.add_argument("--make-cases", action="store_true", help="write a fixed sample instead of answering one")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--cases")
    parser.add_argument("--output", required=True)
    parser.add_argument("--mfp-file", help="the cached CMS Selected Drug List and Maximum Fair Price zip")
    args = parser.parse_args()
    if args.make_cases:
        result = make_cases(args.archive, args.count)
    else:
        with open(args.cases, encoding="utf-8") as stream:
            cases = json.load(stream)["cases"]
        facts = collect(args.archive, cases)
        facts["mfp"] = read_mfp_file(args.mfp_file)
        answers = [answer(case, facts) for case in cases]
        tally = {}
        for item in answers:
            for name, figure in item["figures"].items():
                bucket = tally.setdefault(name, {"value": 0, "unknown": {}})
                if figure["status"] == "value":
                    bucket["value"] += 1
                else:
                    bucket["unknown"][figure["reason"]] = bucket["unknown"].get(figure["reason"], 0) + 1
        result = {"answers": answers, "counts": tally}
    with open(args.output, "w", encoding="utf-8") as stream:
        json.dump(result, stream, indent=1, sort_keys=True)
        stream.write("\n")


if __name__ == "__main__":
    main()
