/**
 * Pure helpers for the Part D plan-average price check: compare the application's answers with
 * the raw-file reference (medicare-part-d-price-reference.py) and count results by reason.
 * Both sides use the same shape per case: `{ case_id, figures: { <name>: figure } }`, where a
 * figure is `{ status: "value", cents }` or `{ status: "unknown", reason }`.
 */

export const PRICE_FIGURES = [
  "unit_cost_total",
  "total_lowest_fee",
  "total_highest_fee",
  "gross",
  "member_cost",
  "maximum_fair_price_total",
];

const describe = (figure) =>
  figure?.status === "value"
    ? `value ${figure.cents}`
    : `unknown ${figure?.reason ?? "(no reason)"}`;

/**
 * Differences between the application's answers and the reference, one line each. A figure must
 * match in status, then in cents or in reason. A case either side leaves out is a difference.
 */
export function comparePriceAnswers(reference, application) {
  const differences = [];
  const actual = new Map(application.map((item) => [item.case_id, item]));
  const expected = new Set(reference.map((item) => item.case_id));
  for (const want of reference) {
    const got = actual.get(want.case_id);
    if (!got) {
      differences.push(`${want.case_id}: the application gave no answer`);
      continue;
    }
    for (const name of PRICE_FIGURES) {
      const a = got.figures?.[name];
      const b = want.figures?.[name];
      if (!b) {
        differences.push(`${want.case_id} ${name}: reference has no figure`);
        continue;
      }
      if (
        a?.status !== b.status ||
        (b.status === "value" && a.cents !== b.cents) ||
        (b.status === "unknown" && a.reason !== b.reason)
      )
        differences.push(
          `${want.case_id} ${name}: application gives ${describe(a)}, raw files give ${describe(b)}`,
        );
      if (a?.status === "value" && !Number.isSafeInteger(a.cents))
        differences.push(`${want.case_id} ${name}: cents is not an integer`);
    }
  }
  for (const id of actual.keys())
    if (!expected.has(id))
      differences.push(
        `${id}: the application answered a case not in the sample`,
      );
  return differences;
}

/** Calculated and unknown counts per figure, with unknowns split by reason. */
export function countPriceAnswers(answers) {
  const counts = {};
  for (const name of PRICE_FIGURES) counts[name] = { value: 0, unknown: {} };
  for (const item of answers)
    for (const name of PRICE_FIGURES) {
      const figure = item.figures[name];
      if (figure.status === "value") counts[name].value += 1;
      else
        counts[name].unknown[figure.reason] =
          (counts[name].unknown[figure.reason] ?? 0) + 1;
    }
  return counts;
}

/**
 * Reasons the application names more precisely than the reference. Each maps one application
 * reason to the one reference reason for the same evidence; no reason maps to a value.
 */
export const APPLICATION_REASONS = {
  // No pricing row for the plan and NDC at all; the reference reports any missing row by days.
  unit_cost_not_published: "price_days_supply_not_published",
  // The cost-sharing side refuses the same 45-day fill before it looks for a price.
  supply_bucket_unproved: "price_days_supply_not_published",
  // The plan lists the RxCUI under another proxy NDC, or not at all.
  proxy_ndc_not_listed: "proxy_ndc_not_on_formulary",
  not_listed: "proxy_ndc_not_on_formulary",
  drug_not_in_bundle: "proxy_ndc_not_on_formulary",
  cost_row_missing: "cost_sharing_row_missing",
};

/**
 * Reference reasons for cases the reference does not model: a later phase, a charge the subsidy
 * or discount cap could change, a fill that reaches the out-of-pocket threshold, and filed
 * minimum or maximum cost sharing. The application's figure there is listed, not compared.
 */
export const REFERENCE_ABSTAINS = new Set([
  "phase_not_supported",
  "subsidy_cap_may_bind",
  "crosses_out_of_pocket_threshold",
  "cost_sharing_bounds_not_modelled",
]);

/**
 * Application reasons where the engine stops on a rule the reference does not model: an enhanced
 * alternative plan paying less than the standard benefit would, and a claim at the edge of the
 * subsidy or discount eligibility. The figure stays unknown, so it is listed, not compared.
 */
export const APPLICATION_ABSTAINS = new Set([
  "enhanced_plan_liability_above_standard",
  "eligibility_boundary_unresolved",
]);

const describeApp = (figure) =>
  figure?.status === "bounded"
    ? `bounded ${figure.minimum_cents}..${figure.maximum_cents}`
    : describe(figure);

/**
 * Differences between the application's answers and the reference, where the application may
 * answer a bounded range. A bounded figure matches only the reference's `dispensing_fee_unknown`,
 * and its ends must equal the reference's own readings: the gross cost the lowest-fee and
 * highest-fee totals, the member cost the charges at those two readings. Figures the reference
 * does not model come back in `notCompared`, never as matches.
 */
export function compareApplicationAnswers(reference, application) {
  const differences = [];
  const notCompared = [];
  const actual = new Map(application.map((item) => [item.case_id, item]));
  const expected = new Set(reference.map((item) => item.case_id));
  for (const want of reference) {
    const got = actual.get(want.case_id);
    if (!got) {
      differences.push(`${want.case_id}: the application gave no answer`);
      continue;
    }
    for (const name of PRICE_FIGURES) {
      const a = got.figures?.[name];
      const b = want.figures?.[name];
      const at = `${want.case_id} ${name}`;
      if (!b) {
        differences.push(`${at}: reference has no figure`);
        continue;
      }
      if (b.status === "unknown" && REFERENCE_ABSTAINS.has(b.reason)) {
        notCompared.push(
          `${at}: reference ${b.reason}, application ${describeApp(a)}`,
        );
        continue;
      }
      if (a?.status === "unknown" && APPLICATION_ABSTAINS.has(a.reason)) {
        notCompared.push(
          `${at}: application ${a.reason}, reference ${describe(b)}`,
        );
        continue;
      }
      // Without a price the reference stops before the cost sharing, the application after it:
      // the member cost must then be unknown, whichever of the two reasons it names.
      if (
        name === "member_cost" &&
        b.status === "unknown" &&
        priceLostAt(want) === b.reason &&
        a?.status === "unknown"
      ) {
        if ((APPLICATION_REASONS[a.reason] ?? a.reason) !== b.reason)
          notCompared.push(
            `${at}: no price (${b.reason}), application ${a.reason}`,
          );
        continue;
      }
      const differ = () =>
        differences.push(
          `${at}: application gives ${describeApp(a)}, raw files give ${describe(b)}`,
        );
      if (a?.status === "bounded") {
        const ends = boundEnds(want, name);
        if (
          b.status !== "unknown" ||
          b.reason !== "dispensing_fee_unknown" ||
          !ends ||
          a.minimum_cents !== ends[0] ||
          a.maximum_cents !== ends[1] ||
          !(a.minimum_cents <= a.maximum_cents)
        )
          differ();
        continue;
      }
      const reason =
        a?.status === "unknown"
          ? (APPLICATION_REASONS[a.reason] ?? a.reason)
          : undefined;
      if (
        a?.status !== b.status ||
        (b.status === "value" && a.cents !== b.cents) ||
        (b.status === "unknown" && reason !== b.reason)
      )
        differ();
      if (a?.status === "value" && !Number.isSafeInteger(a.cents))
        differences.push(`${at}: cents is not an integer`);
    }
  }
  for (const id of actual.keys())
    if (!expected.has(id))
      differences.push(
        `${id}: the application answered a case not in the sample`,
      );
  return { differences, notCompared };
}

/**
 * The reason the reference lost the price, or null when it has one. The price goes missing either
 * at the unit cost or, for a selected drug, at the maximum fair price that replaces it; the gross
 * then carries the same reason. A gross left open by the fee or a floor is not a lost price.
 */
function priceLostAt({ figures }) {
  const unit = figures.unit_cost_total;
  if (unit?.status === "unknown") return unit.reason;
  const fair = figures.maximum_fair_price_total;
  if (
    fair?.status === "unknown" &&
    fair.reason !== "drug_not_selected" &&
    figures.gross?.status === "unknown" &&
    figures.gross.reason === fair.reason
  )
    return fair.reason;
  return null;
}

/** The reference's own lowest-fee and highest-fee ends for a figure, or null. */
function boundEnds(answer, name) {
  if (name === "gross") {
    const low = answer.figures.total_lowest_fee;
    const high = answer.figures.total_highest_fee;
    return low?.status === "value" && high?.status === "value"
      ? [low.cents, high.cents]
      : null;
  }
  if (name === "member_cost") {
    const charges = answer.evidence?.member_charges;
    return Number.isSafeInteger(charges?.low) &&
      Number.isSafeInteger(charges?.high)
      ? [charges.low, charges.high]
      : null;
  }
  return null;
}

/** Value, bounded and unknown counts per figure, with unknowns split by reason. */
export function countApplicationAnswers(answers) {
  const counts = {};
  for (const name of PRICE_FIGURES)
    counts[name] = { value: 0, bounded: 0, unknown: {} };
  for (const item of answers)
    for (const name of PRICE_FIGURES) {
      const figure = item.figures[name];
      if (figure.status === "value") counts[name].value += 1;
      else if (figure.status === "bounded") counts[name].bounded += 1;
      else
        counts[name].unknown[figure.reason] =
          (counts[name].unknown[figure.reason] ?? 0) + 1;
    }
  return counts;
}
