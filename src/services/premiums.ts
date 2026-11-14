import { dentalBusinessRows, premiumAttributeRows } from "../api/repository.js";
import { communityFamilyPremium } from "../domain/rating/index.js";
import { medicalTobaccoPolicy } from "../domain/rating/medical-policy.js";
import {
  catalogRule,
  stateCatalog,
  stateRatingArea,
  stateSourceCell,
} from "../ingest/state/catalog.js";
import type { SqlSession } from "../db/database.js";
import {
  ageOnDate,
  dentalPremium,
  dentalRatingRule,
  DENTAL_REFERENCES,
  householdPremium,
  parseRateRow,
} from "../domain/rating/index.js";
import { allocatePremium } from "../domain/subsidy/dental.js";
import { checkedCents } from "../domain/rating/rate-row.js";
import { FAMILY_RATE_FIELDS } from "../domain/rating/types.js";
import type { CmsRateRow, RateRow } from "../domain/rating/types.js";
import { ratingRule } from "../ingest/rating-rules/index.js";
import { ratingAreaForLocation } from "../ingest/geo/repository.js";
import type { Plan } from "../api/repository.js";
import { countyState, snapshots } from "../api/repository.js";
import { requestReads } from "./request-reads.js";
import type { RequestReads } from "./request-reads.js";
import type { resolveLocation } from "../api/repository.js";
import type { premiumRequest } from "../api/validation.js";

function rowView(row: RateRow) {
  return {
    age_band: row.age,
    tobacco: row.tobacco,
    individual_rate_cents: row.individualRateCents,
    individual_tobacco_rate_cents: row.individualTobaccoRateCents,
    ...(row.age === "Family Option"
      ? { family_rates_cents: row.familyRatesCents }
      : {}),
    effective_date: row.effectiveDate,
    expiration_date: row.expirationDate,
    provenance: {
      snapshot_id: row.provenance.snapshotId,
      source_file: row.provenance.sourceFile,
      source_row: row.provenance.sourceRowNumber,
    },
  };
}
export function storedRate(row: Record<string, unknown>): RateRow {
  const raw = row.raw as CmsRateRow;
  const parsed = parseRateRow(
    {
      ...raw,
      BusinessYear: String(row.plan_year),
      StateCode: row.state as string,
      PlanId: row.base_plan_id as string,
      RatingAreaId: row.rating_area_id as string,
      Age: row.age_band as string,
      Tobacco: row.tobacco as string,
      RateEffectiveDate: row.effective_date as string,
      RateExpirationDate: row.expiration_date as string,
    },
    {
      snapshotId: row.snapshot_id as string,
      sourceFile: "rate",
      sourceRowNumber: row.source_row as number,
    },
  );
  const cents = (key: string) =>
    row[key] === null ? null : checkedCents(Number(row[key]));
  const familyColumns = [
    "couple_cents",
    "primary_subscriber_and_one_dependent_cents",
    "primary_subscriber_and_two_dependents_cents",
    "primary_subscriber_and_three_or_more_dependents_cents",
    "couple_and_one_dependent_cents",
    "couple_and_two_dependents_cents",
    "couple_and_three_or_more_dependents_cents",
  ];
  return {
    ...parsed,
    raw,
    individualRateCents: cents("individual_rate_cents"),
    individualTobaccoRateCents: cents("individual_tobacco_rate_cents"),
    familyRatesCents: Object.fromEntries(
      FAMILY_RATE_FIELDS.map((field, index) => [
        field,
        cents(familyColumns[index]!),
      ]),
    ) as RateRow["familyRatesCents"],
    ratingMethod: row.rating_method as RateRow["ratingMethod"],
  };
}

export async function ratePremium(
  db: SqlSession,
  plan: Plan,
  requestedId: string,
  request: ReturnType<typeof premiumRequest>,
  location: Awaited<ReturnType<typeof resolveLocation>>,
  // This request's reads. Pass the caller's, so a request that rates every plan in a county reads
  // the catalog once, not once per plan.
  reads: RequestReads = requestReads(db),
) {
  // State dispatch precedes all federal policy/PUF reads, including mislabelled catalogs.
  if (plan.state === "NY" || plan.state === "VT")
    return statePremium(db, plan, requestedId, request, location);
  const rule = plan.dental_only
    ? dentalRatingRule(plan.state, plan.plan_year, plan.market)
    : await ratingRule(reads.db, plan.state, plan.plan_year, plan.market);
  const files = await snapshots(reads.db, plan);
  const tobaccoPolicy = medicalTobaccoPolicy({
    state: plan.state,
    planYear: plan.plan_year,
    market: plan.market,
    dentalOnly: plan.dental_only,
    coverageStartDate: request.coverage,
  });
  const trace = {
    plan_id: requestedId,
    base_plan_id: plan.base_plan_id,
    plan_year: plan.plan_year,
    coverage_start: request.coverage,
    currency: "USD",
    period: "month",
    coverage: plan.dental_only ? ("dental" as const) : ("medical" as const),
    bindable_quote: false as const,
    provenance: {
      snapshot_ids: files,
      rating_rule: rule,
      ...(tobaccoPolicy ? { tobacco_policy: tobaccoPolicy } : {}),
    },
  };
  const failure = (
    status: "unsupported_rating_method" | "missing" | "ambiguous" | "unknown",
    reason: string,
  ) => ({
    estimate: { ...trace, status, reason, members: [], rate_rows_used: [] },
    householdPremium: null,
  });
  if (
    !rule ||
    (!plan.dental_only && rule.method !== "per_member") ||
    plan.market !== "Individual"
  ) {
    return failure(
      "unsupported_rating_method",
      "STATE_RATING_METHOD_UNSUPPORTED",
    );
  }
  if (location.status !== "available" || !location.county)
    return failure(
      location.status === "ambiguous" ? "ambiguous" : "unknown",
      "UNRESOLVED_LOCATION_SCOPE",
    );
  const catalog = await reads.countyPlans(
    location.county,
    request.year,
    location.zip,
    plan.dental_only ? "dental" : "medical",
  );
  const offering = catalog.find((p) => p.base_plan_id === plan.base_plan_id);
  if (!offering) return failure("missing", "PLAN_NOT_OFFERED_IN_LOCATION");
  if (offering.snapshot_id !== plan.snapshot_id)
    return failure("unknown", "CATALOG_CHANGED_RETRY");
  const resolution = await ratingAreaForLocation(
    reads.db,
    plan.state,
    plan.plan_year,
    location.county,
    location.zip,
  );
  if (resolution.status !== "available")
    return failure(resolution.status, "UNRESOLVED_RATING_AREA");
  const area = resolution.areas[0]!;
  const { rows } = await reads.rateRows(
    files.rate,
    plan.base_plan_id,
    area.rating_area_id,
  );
  const household = {
    members: request.members,
    coverageStartDate: request.coverage,
    ratingMethod: "per_member",
  } as const;
  const business = plan.dental_only
    ? (
        await dentalBusinessRows(
          db,
          files["business-rules"],
          plan.base_plan_id,
          plan.market,
        )
      ).rows
    : [];
  const attributes = plan.dental_only
    ? (await premiumAttributeRows(db, plan.snapshot_id, plan.base_plan_id)).rows
    : [];
  const agreed = (field: string) => {
    const values = new Set(attributes.map((r) => r.raw[field]?.trim()));
    return attributes.length && values.size === 1 ? [...values][0] : undefined;
  };
  if (plan.dental_only) {
    const offering = agreed("ChildOnlyOffering");
    if (
      !offering ||
      ![
        "Allows Adult and Child-Only",
        "Allows Adult-Only",
        "Allows Child-Only",
      ].includes(offering)
    ) {
      return failure(
        "unknown",
        "DENTAL_CHILD_ONLY_OFFERING_MISSING_OR_CONFLICTING",
      );
    }
    const ages = request.members.map(
      (m) => m.age ?? ageOnDate(m.dateOfBirth!, request.coverage),
    );
    if (
      (offering === "Allows Child-Only" && ages.some((age) => age >= 21)) ||
      (offering === "Allows Adult-Only" && ages.every((age) => age < 21))
    ) {
      return failure(
        "unsupported_rating_method",
        "DENTAL_HOUSEHOLD_OFFERING_UNSUPPORTED",
      );
    }
  }
  const result = plan.dental_only
    ? dentalPremium(
        rows.map(storedRate),
        plan.base_plan_id,
        area.rating_area_id,
        household,
        plan.state,
        business,
      )
    : householdPremium(
        rows.map(storedRate),
        plan.base_plan_id,
        area.rating_area_id,
        household,
        tobaccoPolicy?.policy,
      );
  if (result.status === "unsupported_rating_method")
    return failure(
      result.status,
      plan.dental_only
        ? result.issues[0]!.reason
        : "FILED_RATING_METHOD_UNSUPPORTED",
    );
  const fraction = agreed("EHBPediatricDentalApportionmentQuantity");
  const hasPediatric = request.members.some(
    (m) => (m.age ?? ageOnDate(m.dateOfBirth!, request.coverage)) < 19,
  );
  let pediatricGross: number | null;
  if (result.status !== "rated") {
    pediatricGross = null;
  } else if (!hasPediatric) {
    pediatricGross = 0;
  } else if (result.ratingMethod === "family_tier") {
    pediatricGross = null;
  } else {
    pediatricGross = result.members
      .filter((m) => m.age < 19)
      .reduce((sum, m) => checkedCents(sum + m.premiumCents!), 0);
  }
  let pediatricCents;
  if (pediatricGross === null) {
    pediatricCents = null;
  } else if (pediatricGross === 0) {
    pediatricCents = 0;
  } else {
    pediatricCents = allocatePremium(pediatricGross, fraction);
  }
  function pediatricAdjustmentReason() {
    if (result.status !== "rated") {
      return "PREMIUM_NOT_RATED";
    } else if (pediatricGross === null) {
      return "FAMILY_TIER_PEDIATRIC_ALLOCATION_UNPROVED";
    } else {
      return "EHB_FRACTION_MISSING_OR_CONFLICTING";
    }
  }
  return {
    householdPremium: result,
    estimate: {
      ...trace,
      status: result.status,
      rating_area_id: area.rating_area_id,
      rating_area_provenance: {
        snapshot_id: area.snapshot_id,
        source_row: area.source_row,
      },
      ...(result.status === "rated" ? { total_cents: result.totalCents } : {}),
      ...(plan.dental_only
        ? {
            quote_method:
              result.ratingMethod === "family_tier"
                ? "filed_dental_family_option"
                : "filed_dental_per_member",
            ...("filedColumn" in result
              ? { filed_column: result.filedColumn }
              : {}),
            dental_business_rules: business.map((r) => ({
              snapshot_id: files["business-rules"],
              source_row: r.source_row,
              raw: r.raw,
            })),
            pediatric_ehb: {
              status: pediatricCents === null ? "unknown" : "available",
              monthly_cents: pediatricCents,
              pediatric_gross_cents: pediatricGross,
              fraction: fraction ?? null,
              field: "EHBPediatricDentalApportionmentQuantity",
              ...(pediatricCents === null
                ? {
                    reason: pediatricAdjustmentReason(),
                  }
                : {}),
              citation: DENTAL_REFERENCES.attributeDictionary,
              attribute_rows: attributes.map((r) => ({
                snapshot_id: plan.snapshot_id,
                source_row: r.source_row,
              })),
            },
          }
        : {}),
      members: result.members.map((member) => ({
        member_id: member.memberId,
        age: member.age,
        relationship: member.relationship,
        tobacco: member.tobaccoUse,
        charged: member.charged,
        status: member.status,
        premium_cents: member.premiumCents,
        rate_rows: member.rateRows.map(rowView),
      })),
      rate_rows_used: result.rowsUsed.map(rowView),
      issues: result.issues.map((issue) => ({
        member_id: issue.memberId,
        status: issue.status,
        reason: issue.reason,
      })),
    },
  };
}

/** Filed community tiers are contract totals, never per-member premiums. */
async function statePremium(
  db: SqlSession,
  plan: Plan,
  requestedId: string,
  request: ReturnType<typeof premiumRequest>,
  location: Awaited<ReturnType<typeof resolveLocation>>,
) {
  const trace = {
    plan_id: requestedId,
    base_plan_id: plan.state === "VT" ? null : plan.base_plan_id,
    plan_key: plan.plan_key ?? plan.base_plan_id,
    hios_id: plan.state === "VT" ? null : plan.base_plan_id,
    state: plan.state,
    plan_year: plan.plan_year,
    coverage_start: request.coverage,
    currency: "USD",
    period: "month",
    coverage: plan.dental_only ? ("dental" as const) : ("medical" as const),
    quote_method: "state_filed_tier" as const,
    bindable_quote: false as const,
    on_exchange: plan.state === "NY" ? "unknown" : plan.on_exchange,
    provenance: {
      snapshot_ids: { "state-rates": plan.snapshot_id },
      rating_rule: null,
    },
    members: [],
    rate_rows_used: [],
  };
  const failure = (status: string, reason: string) => ({
    householdPremium: null,
    estimate: { ...trace, status, reason },
  });
  if (!plan.state_catalog)
    return failure("unsupported_rating_method", "NO_APPLICABLE_COMMUNITY_RULE");
  if (plan.market !== "Individual" || plan.dental_only)
    return failure(
      "unsupported_rating_method",
      "STATE_RATING_METHOD_UNSUPPORTED",
    );
  if (location.status !== "available" || !location.county)
    return failure(
      location.status === "ambiguous" ? "ambiguous" : "unknown",
      "UNRESOLVED_LOCATION_SCOPE",
    );
  if (countyState(location.county) !== plan.state)
    return failure("missing", "PLAN_NOT_OFFERED_IN_LOCATION");
  const area = stateRatingArea(plan.state, request.year, location.county);
  if (!area) return failure("unknown", "UNRESOLVED_RATING_AREA");
  const rows = await stateCatalog(
    db,
    request.year,
    plan.state,
    plan.base_plan_id,
    area.rating_area_id,
  );
  if (rows.length !== 1)
    return failure(
      rows.length ? "ambiguous" : "missing",
      rows.length
        ? "CONFLICTING_FILED_TIER_ROWS"
        : "PLAN_NOT_FILED_IN_RATING_AREA",
    );
  const row = rows[0]!;
  if (row.import_id !== plan.snapshot_id)
    return failure("unknown", "CATALOG_CHANGED_RETRY");
  const rule = catalogRule(row);
  const result = communityFamilyPremium(
    rule,
    row.rate,
    request.members,
    request.coverage,
  );
  if (result.status !== "rated") return failure(result.status, result.reason);
  const cell = stateSourceCell(row, result.tier);
  return {
    householdPremium: null,
    estimate: {
      ...trace,
      status: result.status,
      total_cents: result.totalCents,
      rating_area_id: area.rating_area_id,
      rating_area_provenance: area,
      rule_trace: {
        state: plan.state,
        tier: result.tier,
        nominal_multiplier: result.multiplier,
        citation: rule!.citation,
        references: rule!.references,
        source_cell: cell,
      },
      provenance: {
        snapshot_ids: { "state-rates": row.import_id },
        rating_rule: rule,
      },
      rate_rows_used: [cell],
    },
  };
}

/** Wire view shared by native estimates and the removable facade. */
export async function estimatePremium(...args: Parameters<typeof ratePremium>) {
  const [db, plan, requestedId, request, location] = args;
  const reads = args[5] ?? requestReads(db);
  const requestedVariant = /^\d{5}[A-Z]{2}\d{7}-\d{2}$/.test(requestedId)
    ? requestedId.slice(-2)
    : null;
  return {
    ...(await ratePremium(db, plan, requestedId, request, location, reads))
      .estimate,
    ...(await reads.costSharing(plan, {
      csrVariant: request.csrVariant,
      requestedVariant,
    })),
  };
}
