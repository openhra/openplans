#!/usr/bin/env python3
"""Cache-only, independent lowest cost silver plan (LCSP) reading of raw CMS Exchange PUF CSVs.

Does not import application code. For each case (county, rating area, employee age, month) it
reads Plan Attributes, Service Area and Rate rows and returns the self-only LCSP on two premium
bases: the filed premium ("gross") and the filed premium times EHBPercentTotalPremium
("ehb_portion"). When the identification age differs from the employee's age, the plan is
identified at the identification age and priced at the employee's age.

The rating area of a county is not in these files; the caller supplies it per case.
Anything the rows do not settle is returned as a status, never as a guessed premium.
"""
import argparse
import csv
import io
import json
import re
import zipfile
from collections import defaultdict
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

BASES = ['gross', 'ehb_portion']
ON_EXCHANGE = {'On the Exchange', 'Both'}
FAMILY_OFFERS = {'Allows Adult and Child-Only', 'Allows Adult-Only', 'Allows Child-Only'}


def cents(text):
    if not re.fullmatch(r'\d+(?:\.\d{1,2})?', text):
        raise ValueError('Invalid filed amount')
    return int(Decimal(text) * 100)


def rows(path):
    """Rows of a plain CSV or of a zip holding exactly one CSV."""
    path = Path(path)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(names) != 1 or not names[0].lower().endswith('.csv'):
                raise ValueError('Expected single CSV member')
            with io.TextIOWrapper(archive.open(names[0]), encoding='utf-8-sig', newline='') as stream:
                yield from csv.DictReader(stream)
    else:
        with path.open(encoding='utf-8-sig', newline='') as stream:
            yield from csv.DictReader(stream)


def band(age):
    return '0-14' if age < 15 else '64 and over' if age >= 64 else str(age)


def load(attributes_path, service_area_path, rate_path, state, year):
    plans = defaultdict(list)
    for r in rows(attributes_path):
        if (r['StateCode'] == state and r['BusinessYear'] == str(year) and r['MarketCoverage'] == 'Individual'
                and r['DentalOnlyPlan'] == 'No' and r['MetalLevel'] == 'Silver'):
            plans[r['StandardComponentId']].append(r)
    # A base plan counts when any of its rows is offered through the Exchange.
    plans = {pid: records for pid, records in plans.items() if any(r['QHPNonQHPTypeId'] in ON_EXCHANGE for r in records)}
    areas = [r for r in rows(service_area_path)
             if r['StateCode'] == state and r['BusinessYear'] == str(year) and r['DentalOnlyPlan'] == 'No']
    rates = defaultdict(list)
    for r in rows(rate_path):
        if r['StateCode'] == state and r['BusinessYear'] == str(year) and r['PlanId'] in plans:
            rates[(r['PlanId'], r['RatingAreaId'], r['Age'])].append(r)
    return plans, areas, rates


def agreed(records, field):
    values = {r[field] for r in records}
    return next(iter(values)) if len(values) == 1 else None


def offered(records, areas, county):
    """True, False, or 'zip' when the county is only partly covered."""
    keys = {(r['IssuerId'], r['ServiceAreaId']) for r in records}
    covering = [a for a in areas if (a['IssuerId'], a['ServiceAreaId']) in keys
                and (a['CoverEntireState'] == 'Yes' or a['County'] == county)]
    if not covering:
        return False
    if any(a['CoverEntireState'] != 'Yes' and a['PartialCounty'] == 'Yes' for a in covering):
        return 'zip'
    return True


def price(rates, pid, area, age, month):
    live = [r for r in rates.get((pid, area, band(age)), [])
            if r['RateEffectiveDate'] <= month <= r['RateExpirationDate']]
    if len(live) != 1 or live[0]['IndividualRate'] == '':
        return None
    return cents(live[0]['IndividualRate'])


# The CMS Plan Attributes PUF data dictionary defines EHBPercentTotalPremium as a decimal fraction
# from 0 through 1 with at most 15 places. allocatePremium in src/domain/subsidy/dental.ts documents
# the same limit. This reading skips a value with more places or outside 0 through 1, so its EHB
# portion is unknown. It never rounds the value to fit.
EHB_FRACTION = re.compile(r'0(?:\.\d{1,15})?|1(?:\.0{1,15})?')


def ehb_portion(gross, fraction):
    if fraction is None or not EHB_FRACTION.fullmatch(fraction.strip()):
        return None
    return int((Decimal(gross) * Decimal(fraction.strip())).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def pick(identification, at_age):
    """identification and at_age map plan ID to cents at the identification age and the employee age."""
    lowest = min(identification.values())
    plan_ids = sorted(pid for pid, value in identification.items() if value == lowest)
    prices = sorted({at_age[pid] for pid in plan_ids})
    return {'status': 'calculated', 'plan_ids': plan_ids, 'prices_at_age': prices,
            'monthly_cents': prices[0] if len(prices) == 1 else None}


def refused(status, reason=None):
    return {'status': status, 'reason': reason, 'plan_ids': [], 'prices_at_age': [], 'monthly_cents': None}


def lcsp(plans, areas, rates, case):
    county, area, age, month = case['county'], case['rating_area'], case['age'], case['month']
    identification_age = case.get('identification_age', age)
    result = {**case, 'identification_age': identification_age, 'silver_plan_count': 0}

    def both(answer):
        return {**result, 'bases': {basis: answer for basis in BASES}}

    eligible = []
    for pid in sorted(plans):
        records = plans[pid]
        covers = offered(records, areas, county)
        if covers is False:
            continue
        if covers == 'zip':
            return both(refused('location_requires_zip', 'zip_limited_service_area'))
        offer = agreed(records, 'ChildOnlyOffering')
        if offer not in FAMILY_OFFERS:
            return both(refused('incomplete_lcsp', pid + ': coverage_family_eligibility_unknown'))
        if offer == ('Allows Child-Only' if age >= 21 else 'Allows Adult-Only'):
            continue
        eligible.append(pid)
    if not eligible:
        return both(refused('no_silver_plans'))
    result['silver_plan_count'] = len(eligible)
    gross = {'id': {}, 'age': {}}
    ehb = {'id': {}, 'age': {}}
    ehb_missing = []
    for pid in eligible:
        fraction = agreed(plans[pid], 'EHBPercentTotalPremium')
        for key, rated_age in [('id', identification_age), ('age', age)]:
            value = price(rates, pid, area, rated_age, month)
            if value is None:
                return both(refused('incomplete_lcsp', pid + ': rate_row_missing_or_ambiguous'))
            gross[key][pid] = value
            portion = ehb_portion(value, fraction)
            if portion is None:
                if pid not in ehb_missing:
                    ehb_missing.append(pid)
            else:
                ehb[key][pid] = portion
    issues = [pid + ': ehb_allocation_unknown' for pid in ehb_missing]
    result['bases'] = {
        'gross': pick(gross['id'], gross['age']),
        # The gross answer stands; the EHB portion needs a readable fraction for every eligible plan.
        'ehb_portion': {**refused('requires_premium_adjustments', issues[0]), 'issues': issues} if issues
        else pick(ehb['id'], ehb['age']),
    }
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['plan-attributes', 'service-area', 'rate', 'cases', 'output']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    request = json.loads(args.cases.read_text())
    loaded = load(args.plan_attributes, args.service_area, args.rate, request['state'], request['year'])
    answers = [lcsp(*loaded, case) for case in request['cases']]
    args.output.write_text(json.dumps({'state': request['state'], 'year': request['year'], 'cases': answers}, indent=2) + '\n')
