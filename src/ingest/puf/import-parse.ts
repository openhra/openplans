import { parse_hios } from "../../domain/hios/index.js";
import { parseCents, parseRateRow } from "../../domain/rating/index.js";
import { FAMILY_RATE_FIELDS } from "../../domain/rating/types.js";
import type { CmsRateRow } from "../../domain/rating/types.js";
import type { CsvRow } from "../csv/index.js";
import type { ImportKind } from "./import-source.js";

const common = ["BusinessYear", "StateCode", "IssuerId"];
const required: Record<ImportKind, string[]> = {
  "plan-attributes": [
    "StandardComponentId",
    "PlanId",
    "MarketCoverage",
    "DentalOnlyPlan",
    "MetalLevel",
    "NetworkId",
    "ServiceAreaId",
    "PlanMarketingName",
    "IssuerMarketPlaceMarketingName",
    "QHPNonQHPTypeId",
  ],
  "service-area": [
    "ServiceAreaId",
    "ServiceAreaName",
    "CoverEntireState",
    "County",
    "PartialCounty",
    "ZipCodes",
    "MarketCoverage",
    "DentalOnlyPlan",
  ],
  network: [
    "NetworkId",
    "NetworkName",
    "NetworkURL",
    "MarketCoverage",
    "DentalOnlyPlan",
  ],
  "business-rules": [
    "ProductId",
    "StandardComponentId",
    "MarketCoverage",
    "DentalOnlyPlan",
  ],
  rate: [
    "PlanId",
    "RatingAreaId",
    "Tobacco",
    "Age",
    "RateEffectiveDate",
    "RateExpirationDate",
    "IndividualRate",
    "IndividualTobaccoRate",
    ...FAMILY_RATE_FIELDS,
  ],
  "benefits-and-cost-sharing": [
    "StandardComponentId",
    "PlanId",
    "BenefitName",
    "CopayInnTier1",
    "CopayInnTier2",
    "CopayOutofNet",
    "CoinsInnTier1",
    "CoinsInnTier2",
    "CoinsOutofNet",
  ],
};
// New PY2027 fields remain verbatim in plan_attribute.raw; no waiting-period inference.
export const PY2027_ATTRIBUTE_COLUMNS = [
  "AdultDentalServicesWaitingPeriod",
  "WaitingPeriodDuration",
];
export class MissingPufColumnsError extends Error {}
export function validateImportHeader(
  kind: ImportKind,
  values: Record<string, string>,
  year = 2026,
): void {
  const columns = [
    ...common,
    ...required[kind],
    ...(year === 2027 && kind === "plan-attributes"
      ? PY2027_ATTRIBUTE_COLUMNS
      : []),
  ];
  const missing = columns.filter((key) => !Object.hasOwn(values, key));
  if (missing.length)
    throw new MissingPufColumnsError(
      `Missing critical PUF columns (${kind}, PY${year}): ${missing.join(", ")}`,
    );
}
export function publishedBoolean(
  value: string,
  nullable = false,
): boolean | null {
  if (value === "Yes") return true;
  if (value === "No") return false;
  if (nullable && value === "") return null;
  throw new Error("Invalid published boolean");
}
function hios(value: string, state: string, issuer: string, baseOnly = false) {
  const parsed = parse_hios(value);
  if (
    parsed.base.slice(0, 5) !== issuer ||
    parsed.base.slice(5, 7) !== state ||
    (baseOnly && parsed.variant)
  )
    throw new Error("Invalid plan identity");
  return parsed;
}
export const importTables: Record<ImportKind, string> = {
  "plan-attributes": "plan_attribute",
  "service-area": "service_area_county",
  network: "network",
  "business-rules": "business_rule",
  rate: "rate",
  "benefits-and-cost-sharing": "plan_benefit",
};
export const importColumns: Record<ImportKind, string> = {
  "plan-attributes":
    "snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,published_plan_id,market,metal,dental_only,network_id,service_area_id,plan_name,exchange_status,on_exchange,off_exchange,raw",
  "service-area":
    "snapshot_id,source_row,plan_year,state,issuer_id,service_area_id,market,dental_only,service_area_name,county_fips,cover_entire_state,partial_county,zip_codes,raw",
  network:
    "snapshot_id,source_row,plan_year,state,issuer_id,network_id,network_name,network_url,market,dental_only,raw",
  "business-rules":
    "snapshot_id,source_row,plan_year,state,issuer_id,product_id,base_plan_id,market,dental_only,raw",
  rate: "snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,rating_area_id,effective_date,expiration_date,tobacco,age_band,rating_method,individual_rate_cents,individual_tobacco_rate_cents,couple_cents,primary_subscriber_and_one_dependent_cents,primary_subscriber_and_two_dependents_cents,primary_subscriber_and_three_or_more_dependents_cents,couple_and_one_dependent_cents,couple_and_two_dependents_cents,couple_and_three_or_more_dependents_cents,raw",
  "benefits-and-cost-sharing":
    "snapshot_id,source_row,plan_year,state,issuer_id,base_plan_id,published_plan_id,benefit_name,cost_sharing_raw,cost_sharing_parsed,raw",
};
export function parseImportRow(
  kind: ImportKind,
  row: CsvRow,
  snapshot: string,
): unknown[] {
  const r = row.values,
    year = Number(r.BusinessYear),
    state = r.StateCode!,
    issuer = r.IssuerId!;
  if (!/^\d{5}$/.test(issuer)) throw new Error("Invalid issuer identity");
  const head = [snapshot, row.rowNumber, year, state, issuer];
  const raw = JSON.stringify(r);
  switch (kind) {
    case "plan-attributes": {
      const base = hios(r.StandardComponentId!, state, issuer, true),
        full = hios(r.PlanId!, state, issuer);
      if (base.base !== full.base)
        throw new Error("Variant base differs from StandardComponentId");
      const exchange = r.QHPNonQHPTypeId!;
      if (!["Both", "On the Exchange", "Off the Exchange"].includes(exchange))
        throw new Error("Invalid exchange classification");
      return [
        ...head,
        base.base,
        full.full,
        r.MarketCoverage,
        r.MetalLevel,
        publishedBoolean(r.DentalOnlyPlan!),
        r.NetworkId,
        r.ServiceAreaId,
        r.PlanMarketingName,
        exchange,
        exchange !== "Off the Exchange",
        exchange !== "On the Exchange",
        raw,
      ];
    }
    case "service-area": {
      const statewide = publishedBoolean(r.CoverEntireState!),
        partial = publishedBoolean(r.PartialCounty!, true);
      const county = r.County || null;
      if (
        (!statewide && !county) ||
        (county && !/^\d{5}$/.test(county)) ||
        (partial && !r.ZipCodes)
      )
        throw new Error("Invalid service area geography");
      if (r.ZipCodes && !/^\d{5}(?:\s*[,;\s]\s*\d{5})*$/.test(r.ZipCodes))
        throw new Error("Invalid ZIP list");
      return [
        ...head,
        r.ServiceAreaId,
        r.MarketCoverage,
        publishedBoolean(r.DentalOnlyPlan!),
        r.ServiceAreaName,
        county,
        statewide,
        partial,
        r.ZipCodes,
        raw,
      ];
    }
    case "network":
      return [
        ...head,
        r.NetworkId,
        r.NetworkName,
        r.NetworkURL,
        r.MarketCoverage,
        publishedBoolean(r.DentalOnlyPlan!),
        raw,
      ];
    case "business-rules": {
      const base = r.StandardComponentId
        ? hios(r.StandardComponentId, state, issuer, true).base
        : null;
      return [
        ...head,
        r.ProductId || null,
        base,
        r.MarketCoverage,
        publishedBoolean(r.DentalOnlyPlan!),
        raw,
      ];
    }
    case "rate": {
      hios(r.PlanId!, state, issuer, true);
      const rate = parseRateRow(r as unknown as CmsRateRow, {
        snapshotId: snapshot,
        sourceFile: "rate",
        sourceRowNumber: row.rowNumber,
      });
      return [
        ...head,
        rate.planId,
        rate.ratingAreaId,
        rate.effectiveDate,
        rate.expirationDate,
        rate.tobacco,
        String(rate.age),
        rate.ratingMethod,
        rate.individualRateCents,
        rate.individualTobaccoRateCents,
        ...FAMILY_RATE_FIELDS.map((key) => rate.familyRatesCents[key]),
        raw,
      ];
    }
    case "benefits-and-cost-sharing": {
      const base = hios(r.StandardComponentId!, state, issuer, true),
        full = hios(r.PlanId!, state, issuer);
      if (base.base !== full.base)
        throw new Error("Benefit variant base differs");
      const keys = [
        "CopayInnTier1",
        "CopayInnTier2",
        "CopayOutofNet",
        "CoinsInnTier1",
        "CoinsInnTier2",
        "CoinsOutofNet",
      ];
      const costs = Object.fromEntries(keys.map((key) => [key, r[key]]));
      // Parse only unconditional exact dollar texts; keep all conditions verbatim.
      const parsed = Object.fromEntries(
        keys.map((key) => [
          key,
          /^\$\d+(?:\.\d{1,2})?$/.test(r[key]!)
            ? { cents: parseCents(r[key]!.slice(1)) }
            : null,
        ]),
      );
      return [
        ...head,
        base.base,
        full.full,
        r.BenefitName,
        JSON.stringify(costs),
        JSON.stringify(parsed),
        raw,
      ];
    }
  }
}
