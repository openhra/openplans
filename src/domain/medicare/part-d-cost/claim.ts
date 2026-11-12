import type { Rational } from "./decimal.js";
import {
  ONE,
  ZERO,
  add,
  cmp,
  div,
  fromCents,
  max,
  min,
  mul,
  roundHalfUpCents,
  sub,
} from "./decimal.js";

/**
 * One claim through the redesigned Part D benefit, in the order of the CMS prescription drug
 * event instructions (C7, and the method of the C11 examples): the plan deductible, then the
 * initial coverage phase until TrOOP reaches the annual out-of-pocket threshold, then the
 * catastrophic phase, where the enrollee pays nothing. Every input is definite; the schedule
 * engine decides what to do when evidence is missing. Arithmetic is exact, and each reported
 * figure is rounded to cents once (ROUNDING_POLICY).
 */

export const ROUNDING_POLICY = "cents-half-up-v1";

/** Phase codes as reported on the drug event: deductible, initial coverage, catastrophic. */
export type PhaseCode = "D" | "N" | "C";

export interface ClaimParameters {
  standardDeductible: Rational;
  outOfPocketThreshold: Rational;
  /** Defined standard initial-coverage cost sharing (25% in 2026 and 2027). */
  standardInitialShare: Rational;
  insulinCopayCap: Rational;
  insulinPriceShareCap: Rational;
}

export type Sharing =
  | { kind: "coinsurance"; rate: Rational }
  | { kind: "copay"; amount: Rational }
  /** A plan charge of whichever is lower, as CMS describes for some insulin benefits. */
  | { kind: "lesser_of"; copay: Rational; rate: Rational }
  /** One reading of a filed minimum or maximum: the charge is held between them. */
  | {
      kind: "bounded";
      inner: Sharing;
      minimum: Rational | null;
      maximum: Rational | null;
    };

export interface ClaimInput {
  /** Negotiated price of the whole claim in dollars; rounded to cents before use. */
  gross: Rational;
  /** TrOOP accumulated before the claim. */
  troop: Rational;
  /** Plan deductible still owed for this drug: zero when the tier waives it. */
  planDeductibleRemaining: Rational;
  /** Basic plans (defined standard, actuarially equivalent, basic alternative) or enhanced. */
  design: "basic" | "enhanced_alternative";
  sharing: Sharing;
  special: "none" | "insulin" | "vaccine";
  /** Maximum fair price of a selected covered insulin product, when one is in effect. */
  maximumFairPrice: Rational | null;
  program: {
    payer: "selected_drug_subsidy" | "manufacturer_discount" | "none";
    initial: Rational;
    /** Null when the year's catastrophic rate is not documented; payer figures then stay null. */
    catastrophic: Rational | null;
  };
  params: ClaimParameters;
}

export interface ClaimFigures {
  status: "value";
  grossCents: bigint;
  /** Gross covered drug cost below and above the out-of-pocket threshold. */
  belowThresholdCents: bigint;
  aboveThresholdCents: bigint;
  patientCents: bigint;
  troopDeltaCents: bigint;
  /** Plan deductible paid on this claim. */
  deductiblePaidCents: bigint;
  /** Payer split; null where the claim's rates do not settle it. */
  selectedDrugSubsidyCents: bigint | null;
  manufacturerDiscountCents: bigint | null;
  coveredPlanPaidCents: bigint | null;
  nonCoveredPlanPaidCents: bigint | null;
  planPhase: { begin: PhaseCode; end: PhaseCode };
  standardPhase: { begin: PhaseCode; end: PhaseCode };
  derivation: string[];
}
export type ClaimResult =
  ClaimFigures | { status: "unknown"; reason: string; derivation: string[] };

export interface ClaimDeps {
  /** Dollars to whole cents. */
  round: (value: Rational) => bigint;
  /** TrOOP has reached a limit ("equal to or exceeds"). */
  reached: (troop: Rational, limit: Rational) => boolean;
  /** TrOOP is above a limit ("exceeding"), as eligibility for the subsidy and discount requires. */
  exceeds: (troop: Rational, limit: Rational) => boolean;
}

export const claimDeps: ClaimDeps = {
  round: roundHalfUpCents,
  reached: (troop, limit) => cmp(troop, limit) >= 0,
  exceeds: (troop, limit) => cmp(troop, limit) > 0,
};

const positive = (value: Rational) => cmp(value, ZERO) > 0;

export function createClaimCalculator(deps: ClaimDeps = claimDeps) {
  const cents = (value: Rational) => deps.round(value);
  const dollars = (value: bigint) => fromCents(value);

  return function priceClaim(input: ClaimInput): ClaimResult {
    const derivation: string[] = [];
    const unknown = (reason: string): ClaimResult => ({
      status: "unknown",
      reason,
      derivation,
    });
    const { params, program } = input;
    const grossCents = cents(input.gross);
    if (grossCents < 0n) return unknown("negative_price");
    const gross = dollars(grossCents);
    const threshold = params.outOfPocketThreshold;
    const standard = params.standardDeductible;
    const toThreshold = max(ZERO, sub(threshold, input.troop));
    const toStandard = max(ZERO, sub(standard, input.troop));
    const standardEnd = (after: Rational): PhaseCode => {
      if (deps.reached(after, threshold)) return "C";
      return deps.reached(after, standard) ? "N" : "D";
    };
    const standardBegin = standardEnd(input.troop);
    const catastrophicRate = program.catastrophic;
    const catastrophicShare = (above: bigint): bigint | null => {
      if (program.payer !== "manufacturer_discount") return 0n;
      return catastrophicRate
        ? cents(mul(catastrophicRate, dollars(above)))
        : null;
    };

    // Already at the threshold: the whole claim is catastrophic and the enrollee pays nothing.
    if (deps.reached(input.troop, threshold)) {
      derivation.push(
        "TrOOP had reached the out-of-pocket threshold: catastrophic phase, no cost sharing",
      );
      const discount =
        input.special === "vaccine" ? null : catastrophicShare(grossCents);
      return {
        status: "value",
        grossCents,
        belowThresholdCents: 0n,
        aboveThresholdCents: grossCents,
        patientCents: 0n,
        troopDeltaCents: 0n,
        deductiblePaidCents: 0n,
        selectedDrugSubsidyCents: input.special === "vaccine" ? null : 0n,
        manufacturerDiscountCents: discount,
        coveredPlanPaidCents: discount === null ? null : grossCents - discount,
        nonCoveredPlanPaidCents: discount === null ? null : 0n,
        planPhase: { begin: "C", end: "C" },
        standardPhase: { begin: "C", end: "C" },
        derivation,
      };
    }

    if (input.special === "vaccine") {
      derivation.push(
        "ACIP-recommended adult vaccine: no deductible and no cost sharing",
      );
      return {
        status: "value",
        grossCents,
        belowThresholdCents: grossCents,
        aboveThresholdCents: 0n,
        patientCents: 0n,
        troopDeltaCents: 0n,
        deductiblePaidCents: 0n,
        selectedDrugSubsidyCents: null,
        manufacturerDiscountCents: null,
        coveredPlanPaidCents: null,
        nonCoveredPlanPaidCents: null,
        planPhase: { begin: standardBegin, end: standardBegin },
        standardPhase: { begin: standardBegin, end: standardBegin },
        derivation,
      };
    }

    const insulin = input.special === "insulin";
    // The plan deductible ends once TrOOP meets the standard deductible (C4 section 70).
    const deductibleDue = insulin
      ? ZERO
      : max(ZERO, min(input.planDeductibleRemaining, toStandard));
    const deductiblePart = min(gross, deductibleDue);
    const rest = sub(gross, deductiblePart);
    if (insulin)
      derivation.push("covered insulin: the deductible does not apply");
    if (positive(deductiblePart))
      derivation.push(
        `plan deductible: enrollee pays 100% of the first ${cents(deductiblePart)} cents`,
      );

    // The plan's charge on the initial-coverage part. Its share of that part is the
    // TrOOP-eligible cost-sharing percentage of C7 section 3 (a copay divided by the cost).
    let statutory: Rational | null = null;
    if (insulin && positive(rest)) {
      const prices = [gross];
      if (input.maximumFairPrice) prices.push(input.maximumFairPrice);
      statutory = min(
        params.insulinCopayCap,
        ...prices.map((price) => mul(params.insulinPriceShareCap, price)),
      );
      derivation.push(
        `insulin ceiling: lesser of $35 and 25% of the negotiated price or maximum fair price (${cents(statutory)} cents)`,
      );
    }
    const filedCharge = (sharing: Sharing, part: Rational): Rational => {
      switch (sharing.kind) {
        case "coinsurance":
          return mul(sharing.rate, part);
        case "copay":
          return sharing.amount;
        case "lesser_of":
          return min(sharing.copay, mul(sharing.rate, part));
        case "bounded": {
          let amount = filedCharge(sharing.inner, part);
          if (sharing.minimum) amount = max(amount, sharing.minimum);
          if (sharing.maximum) amount = min(amount, sharing.maximum);
          return amount;
        }
      }
    };
    const charge = (part: Rational): Rational => {
      if (!positive(part)) return ZERO;
      let amount = filedCharge(input.sharing, part);
      if (statutory) amount = min(amount, statutory);
      return min(max(amount, ZERO), part);
    };
    const rate = positive(rest) ? div(charge(rest), rest) : ZERO;

    const initial = program.payer === "none" ? ZERO : program.initial;
    const capRate = sub(ONE, initial);
    const split = (subsidy: bigint) => ({
      selected: program.payer === "selected_drug_subsidy" ? subsidy : 0n,
      discount: program.payer === "manufacturer_discount" ? subsidy : 0n,
    });

    if (input.design === "enhanced_alternative" && !insulin) {
      return enhanced();
    }
    return basic();

    function basic(): ClaimResult {
      // The enrollee can never pay more than the initial-coverage cost minus the subsidy or
      // discount on it (C7 example 3 and section 3 footnote 8).
      let effective: Rational | null = rate;
      if (cmp(rate, capRate) > 0)
        effective =
          cmp(deductiblePart, toStandard) === 0 && positive(capRate)
            ? capRate
            : null;
      let belowCents: bigint;
      let patientCents: bigint;
      if (effective) {
        const crossing =
          cmp(add(deductiblePart, mul(effective, rest)), toThreshold) > 0;
        if (crossing) {
          // Remaining TrOOP / TrOOP-eligible cost-sharing share (C7 examples 4 and 9).
          belowCents = cents(
            add(
              deductiblePart,
              div(sub(toThreshold, deductiblePart), effective),
            ),
          );
          patientCents = cents(toThreshold);
          derivation.push(
            `crosses the threshold: ${belowCents} cents below it, enrollee pays the remaining TrOOP`,
          );
        } else {
          belowCents = grossCents;
          patientCents = cents(add(deductiblePart, mul(effective, rest)));
        }
      } else {
        // The cap binds on a claim that also straddles the standard deductible.
        const due = add(deductiblePart, charge(rest));
        if (cmp(due, toThreshold) > 0)
          return unknown("subsidy_cap_split_unresolved");
        const eligibleBase = sub(gross, toStandard);
        const ceiling = sub(rest, mul(initial, eligibleBase));
        patientCents = cents(add(deductiblePart, min(charge(rest), ceiling)));
        belowCents = grossCents;
        if (!deps.exceeds(add(input.troop, dollars(patientCents)), standard))
          return unknown("eligibility_boundary_unresolved");
      }
      const after = add(input.troop, dollars(patientCents));
      const eligible = deps.exceeds(after, standard);
      const below = dollars(belowCents);
      const base = eligible ? max(ZERO, sub(below, toStandard)) : ZERO;
      const initialCents = cents(mul(initial, base));
      if (effective && effective !== rate && !eligible)
        return unknown("eligibility_boundary_unresolved");
      const aboveCents = grossCents - belowCents;
      const catastrophic = catastrophicShare(aboveCents);
      const { selected, discount } = split(initialCents);
      const discountTotal =
        catastrophic === null ? null : discount + catastrophic;
      const planPaid =
        discountTotal === null
          ? null
          : grossCents - patientCents - selected - discountTotal;
      if (planPaid !== null && planPaid < 0n)
        return unknown("negative_plan_payment");
      derivation.push(
        eligible
          ? `TrOOP exceeds the standard deductible: subsidy or discount base ${cents(base)} cents`
          : "TrOOP does not exceed the standard deductible: no subsidy or discount",
      );
      return {
        status: "value",
        grossCents,
        belowThresholdCents: belowCents,
        aboveThresholdCents: aboveCents,
        patientCents,
        troopDeltaCents: patientCents,
        deductiblePaidCents: cents(deductiblePart),
        selectedDrugSubsidyCents: selected,
        manufacturerDiscountCents: discountTotal,
        coveredPlanPaidCents: planPaid,
        nonCoveredPlanPaidCents: planPaid === null ? null : 0n,
        planPhase: phases(after),
        standardPhase: { begin: standardBegin, end: standardEnd(after) },
        derivation,
      };
    }

    function enhanced(): ClaimResult {
      // Map the claim to the defined standard benefit and take the lesser gross amount below the
      // threshold (C7 example 5; C11 examples 1, 2 and 5).
      const share = params.standardInitialShare;
      const standardLiability = (part: Rational) =>
        add(
          min(part, toStandard),
          mul(share, max(ZERO, sub(part, toStandard))),
        );
      const standardBelow =
        cmp(standardLiability(gross), toThreshold) > 0
          ? add(toStandard, div(sub(toThreshold, toStandard), share))
          : gross;
      const planBelow =
        positive(rate) &&
        cmp(add(deductiblePart, mul(rate, rest)), toThreshold) > 0
          ? add(deductiblePart, div(sub(toThreshold, deductiblePart), rate))
          : gross;
      const belowCents = cents(min(standardBelow, planBelow, gross));
      const below = dollars(belowCents);
      const patientCents = cents(
        min(
          toThreshold,
          add(deductiblePart, charge(sub(below, deductiblePart))),
        ),
      );
      const troopDeltaCents = cents(
        min(toThreshold, max(standardLiability(below), dollars(patientCents))),
      );
      const after = add(input.troop, dollars(troopDeltaCents));
      const eligible = deps.exceeds(after, standard);
      const base = eligible ? max(ZERO, sub(below, toStandard)) : ZERO;
      const initialCents = cents(mul(initial, base));
      const aboveCents = grossCents - belowCents;
      const catastrophic = catastrophicShare(aboveCents);
      const { selected, discount } = split(initialCents);
      const discountTotal =
        catastrophic === null ? null : discount + catastrophic;
      const planPaid =
        discountTotal === null
          ? null
          : cents(mul(sub(sub(ONE, share), initial), base)) +
            aboveCents -
            (catastrophic ?? 0n);
      const nonCovered =
        planPaid === null || discountTotal === null
          ? null
          : grossCents - selected - discountTotal - patientCents - planPaid;
      if (nonCovered !== null && nonCovered < 0n)
        return unknown("enhanced_plan_liability_above_standard");
      derivation.push(
        `enhanced alternative: ${belowCents} cents below the threshold, TrOOP is the greater of standard and plan liability`,
      );
      return {
        status: "value",
        grossCents,
        belowThresholdCents: belowCents,
        aboveThresholdCents: aboveCents,
        patientCents,
        troopDeltaCents,
        deductiblePaidCents: cents(deductiblePart),
        selectedDrugSubsidyCents: selected,
        manufacturerDiscountCents: discountTotal,
        coveredPlanPaidCents: planPaid,
        nonCoveredPlanPaidCents: nonCovered,
        planPhase: phases(after),
        standardPhase: { begin: standardBegin, end: standardEnd(after) },
        derivation,
      };
    }

    function phases(after: Rational) {
      const begin: PhaseCode = positive(deductiblePart) ? "D" : "N";
      const deductibleLeft =
        positive(sub(deductibleDue, deductiblePart)) &&
        !deps.reached(after, standard);
      if (deps.reached(after, threshold)) return { begin, end: "C" as const };
      return { begin, end: deductibleLeft ? ("D" as const) : ("N" as const) };
    }
  };
}

export const priceClaim = createClaimCalculator();
