/** Pure comparison helpers. No API calls and no inferred prices. */
import {
  householdPremium,
  parseCents,
  parseRateRow,
  selectRateRow,
} from "../../dist/domain/rating/index.js";

export function setComparison(actual, expected) {
  const a = new Set(actual),
    b = new Set(expected);
  const only_actual = [...a].filter((id) => !b.has(id)).sort();
  const only_expected = [...b].filter((id) => !a.has(id)).sort();
  return {
    passed: !only_actual.length && !only_expected.length,
    actual: a.size,
    expected: b.size,
    only_actual,
    only_expected,
  };
}

export function countComparison(actual, raw, sqlite) {
  return ["base_plans", "variants", "rate_rows", "service_area_rows"].map(
    (metric) => ({
      metric,
      openplans: actual[metric],
      raw: raw[metric],
      sqlite: sqlite?.[metric] ?? null,
      passed:
        actual[metric] === raw[metric] &&
        (sqlite?.[metric] == null || actual[metric] === sqlite[metric]),
      cause:
        actual[metric] === raw[metric] &&
        (sqlite?.[metric] == null || actual[metric] === sqlite[metric])
          ? null
          : "unexplained",
    }),
  );
}

const amount = (value) => (value === null ? null : Number(value));
/** Exercise persisted columns, including prices; raw JSON is only the parser's input trace. */
export function domainRate(row) {
  const parsed = parseRateRow(row.raw, {
    snapshotId: row.snapshot_id,
    sourceFile: "rate",
    sourceRowNumber: row.source_row,
  });
  return {
    ...parsed,
    businessYear: row.plan_year,
    stateCode: row.state,
    planId: row.base_plan_id,
    ratingAreaId: row.rating_area_id,
    age: /^\d+$/.test(row.age_band) ? Number(row.age_band) : row.age_band,
    tobacco: row.tobacco,
    effectiveDate: row.effective_date,
    expirationDate: row.expiration_date,
    ratingMethod: row.rating_method,
    individualRateCents: amount(row.individual_rate_cents),
    individualTobaccoRateCents: amount(row.individual_tobacco_rate_cents),
    familyRatesCents: Object.fromEntries(
      Object.keys(parsed.familyRatesCents).map((key) => {
        const column =
          key.replace(
            /[A-Z]/g,
            (letter, index) => `${index ? "_" : ""}${letter.toLowerCase()}`,
          ) + "_cents";
        return [key, amount(row[column])];
      }),
    ),
  };
}

export const rateKey = (plan, area) => JSON.stringify([plan, area]);
export function groupRates(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = rateKey(row.planId, row.ratingAreaId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

/** Every age 0..64 represented by the source band, both tobacco flags, at its effective date. */
export function checkRate(expected, rows) {
  if (expected.family)
    return { comparisons: 0, unknown: 0, mismatches: [], skipped_family: 1 };
  const ages =
    expected.age === "0-14"
      ? Array.from({ length: 15 }, (_, i) => i)
      : [expected.age === "64 and over" ? 64 : Number(expected.age)];
  const mismatches = [];
  let comparisons = 0,
    unknown = 0;
  for (const age of ages)
    for (const tobacco of [false, true]) {
      const cents = tobacco ? expected.tobacco_rate : expected.individual;
      const selected = selectRateRow(
        rows,
        expected.plan,
        expected.area,
        age,
        tobacco,
        expected.effective,
      );
      const premium = householdPremium(rows, expected.plan, expected.area, {
        coverageStartDate: expected.effective,
        ratingMethod: "per_member",
        members: [
          {
            id: "oracle-single-member",
            age,
            tobaccoUse: tobacco,
            relationship: "subscriber",
          },
        ],
      });
      comparisons++;
      if (cents === null) unknown++;
      if (
        selected.status !== "selected" ||
        selected.row.provenance.sourceRowNumber !== expected.source_row ||
        (selected.status === "selected" &&
          (selected.row.effectiveDate !== expected.effective ||
            selected.row.expirationDate !== expected.expiration)) ||
        premium.status !== (cents === null ? "unknown" : "rated") ||
        premium.totalCents !== cents
      ) {
        mismatches.push({
          source_row: expected.source_row,
          plan: expected.plan,
          area: expected.area,
          age,
          tobacco,
          date: expected.effective,
          expected_cents: cents,
          actual_cents: premium.totalCents,
          selection_status: selected.status,
          premium_status: premium.status,
          selected_source_row:
            selected.status === "selected"
              ? selected.row.provenance.sourceRowNumber
              : null,
        });
      }
    }
  return { comparisons, unknown, mismatches, skipped_family: 0 };
}

export function validateCapturedPlan(plan) {
  if (
    !/^\d{5}TX\d{7}$/.test(plan.id) ||
    !Array.isArray(plan.premiums_by_applicant) ||
    plan.premiums_by_applicant.length !== 1
  )
    throw new Error("Unsupported captured household");
  const applicant = plan.premiums_by_applicant[0];
  if (
    applicant.age !== 35 ||
    applicant.smoker !== false ||
    applicant.child !== false ||
    applicant.composite_rated !== false ||
    parseCents(String(applicant.premium)) !==
      parseCents(String(plan.premium)) ||
    !/^2026-\d\d-\d\d$/.test(plan.effective_date) ||
    plan.expiration_date < plan.effective_date
  ) {
    throw new Error("Captured inputs differ from age 35 non-tobacco PY2026");
  }
}

export function compareCaptured(plan, rows, publicIds, area) {
  validateCapturedPlan(plan);
  const expected_cents = parseCents(String(plan.premium));
  const common = {
    plan: plan.id,
    issuer: plan.id.slice(0, 5),
    expected_cents,
    area,
    date: plan.effective_date,
  };
  if (!publicIds.has(plan.id))
    return {
      ...common,
      status: "not_in_public_data",
      actual_cents: null,
      cause:
        plan.id.startsWith("33602") &&
        plan.on_market === false &&
        plan.off_market === true
          ? "BCBSTX carrier-only off-exchange plan absent from TX public catalog"
          : "unexplained",
    };
  const result = householdPremium(rows, plan.id, area, {
    coverageStartDate: plan.effective_date,
    ratingMethod: "per_member",
    members: [
      {
        id: "oracle-single-member",
        age: 35,
        tobaccoUse: false,
        relationship: "subscriber",
      },
    ],
  });
  return {
    ...common,
    actual_cents: result.totalCents,
    domain_status: result.status,
    status:
      result.status === "rated" && result.totalCents === expected_cents
        ? "equal"
        : "differs",
  };
}

/** EOF classification only, not an issuer ingestion pipeline (phase 3 owns publication). */
export function classifyJson(text) {
  try {
    JSON.parse(text);
    return { classification: "complete", snapshot_state: "PARSED" };
  } catch (error) {
    // V8 reports missing tokens at EOF with the end offset; unterminated strings
    // use their opening offset. Other syntax errors must not become "truncated".
    const message = String(error.message);
    const offset = /(?:at position|position) (\d+)/.exec(message);
    const truncated =
      /Unexpected end of JSON input|Unterminated string in JSON/.test(
        message,
      ) ||
      (offset && Number(offset[1]) === text.length);
    return {
      classification: truncated ? "truncated" : "invalid",
      snapshot_state: "QUARANTINED",
      provider_status: "unknown",
    };
  }
}
