import type { Rational } from "./decimal.js";
import {
  ZERO,
  add,
  cmp,
  formatDecimal,
  mul,
  parseDecimal,
  roundHalfUpCents,
} from "./decimal.js";
import type {
  FeeRangeEvidence,
  FeeRangeReading,
  FeeRanges,
  RowRef,
  UnitCost,
} from "./repository.js";

/**
 * Plan-average claim prices from the quarterly pricing file and the dispensing-fee ranges. The
 * record layout does not say whether a unit cost already includes a dispensing fee, and the fee
 * varies by pharmacy, so the engine prices every fill three ways:
 *
 * - unit cost alone (the unit cost already includes everything);
 * - unit cost plus the lowest fee of an applicable type at an in-area network pharmacy;
 * - unit cost plus the highest such fee.
 *
 * A figure is a value only when the three agree to the cent. When the fees differ, the gross cost
 * is bounded: the minimum is the unit cost plus the lowest fee and the maximum the unit cost plus
 * the highest fee. A missing fee is never read as $0, no fee is averaged, and a floor price that
 * could bind leaves the gross cost unknown.
 */

/** Which fees apply to a drug, from its selected-drug program options. */
export type FeeSet = "brand_or_generic" | "selected_or_brand" | "any_fee_type";
export type FeeSpan =
  | { status: "value"; lowest: string; highest: string }
  | { status: "unknown"; reason: string };

export interface FeeRangeRef extends FeeRangeEvidence {
  channel: string;
  days_supply: number;
  fee_type: FeeRangeReading["fee_type"];
}

/** A fill's plan-average price before the engine knows which fee type applies. */
export interface PlanAveragePrice {
  status: "plan_average";
  basis: "cms_plan_average";
  /** Dollars per proxy-NDC unit, numeric(12,4) text as published. */
  unit_cost: string;
  quantity: string;
  quantity_basis: "caller_asserted_ndc_units";
  days_supply: number;
  caveat: string;
  /** Unit cost times quantity, exact decimal dollars. */
  unit_cost_total: string;
  fees: Record<FeeSet, FeeSpan>;
  /** The highest floor price over the same pharmacies; unknown when any floor is unreadable. */
  floor:
    | { status: "value"; highest: string | null }
    | { status: "unknown"; reason: "floor_price_unreadable" };
  pricing_row: RowRef;
  fee_ranges: FeeRangeRef[];
}

export type PriceFigure =
  | { status: "value"; cents: number }
  | {
      status: "bounded";
      cents: null;
      minimum_cents: number;
      maximum_cents: number;
      reason: string;
    }
  | { status: "unknown"; cents: null; reason: string };

/** One way to price the claim; a null gross is a reading no file settles. */
export type PriceReadingKey =
  | "unit_cost"
  | "lowest_fee"
  | "highest_fee"
  | "floor_price"
  | "fee_unknown"
  | "mfp_lowest_fee"
  | "mfp_highest_fee"
  | "mfp_unknown";
export interface PriceReading {
  key: PriceReadingKey;
  gross: Rational | null;
}

/**
 * A fill's maximum fair price (mfp.ts): the unit price times the quantity, rounded to the cent,
 * or why there is none. Null when the fill is not priced from plan averages.
 */
export type FillMfp =
  | {
      status: "value";
      unit_price: string;
      total: Rational;
      effective_from: string;
      effective_to: string | null;
    }
  | { status: "unknown"; reason: string };

/**
 * What the ingredient cost of a fill is: the plan-average unit cost, the maximum fair price of a
 * selected drug, or either while the drug's program is open.
 */
export type Ingredient = "plan_average" | "maximum_fair_price" | "open";

/** The readings and the price figures for one fill once its fee set is known. */
export interface FillPricing {
  fee_set: FeeSet;
  ingredient: Ingredient;
  readings: PriceReading[];
  /** Why the readings disagree or give no price; null when one reading prices the claim. */
  reason: string | null;
  /** The maximum fair price the claim uses for a selected drug; null when there is none. */
  mfp: Extract<FillMfp, { status: "value" }> | null;
  figures: {
    unit_cost_total: PriceFigure;
    total_lowest_fee: PriceFigure;
    total_highest_fee: PriceFigure;
    gross: PriceFigure;
    maximum_fair_price_total: PriceFigure;
  };
}

/** Reasons a whole fee table cannot answer; per-plan gaps all read `dispensing_fee_unknown`. */
const RELEASE_FEE_REASONS = new Set([
  "release_not_active",
  "pricing_release_mismatch",
  "pricing_not_published_for_year",
  "dispensing_fees_not_loaded",
]);
export const FEE_UNKNOWN = "dispensing_fee_unknown";
export const FLOOR_MAY_APPLY = "floor_price_may_apply";
/** The program is open and the maximum fair price and the plan average give different prices. */
export const MFP_MAY_APPLY = "maximum_fair_price_may_apply";
export const NOT_SELECTED = "drug_not_selected";

const tenThousandths = (text: string | null): Rational | null =>
  text === null ? null : parseDecimal(text);

/** Lowest and highest readable fee over the union of the given fee types. */
export function feeSpan(
  readings: readonly (FeeRangeReading | undefined)[],
): FeeSpan {
  let lowest: Rational | null = null;
  let highest: Rational | null = null;
  for (const reading of readings) {
    if (!reading || reading.fees_readable === 0) continue;
    const low = tenThousandths(reading.min_fee);
    const high = tenThousandths(reading.max_fee);
    if (!low || !high) return { status: "unknown", reason: FEE_UNKNOWN };
    if (!lowest || cmp(low, lowest) < 0) lowest = low;
    if (!highest || cmp(high, highest) > 0) highest = high;
  }
  if (!lowest || !highest) return { status: "unknown", reason: FEE_UNKNOWN };
  return {
    status: "value",
    lowest: formatDecimal(lowest),
    highest: formatDecimal(highest),
  };
}

/**
 * A selected drug pays the selected-drug fee, or the brand fee where a pharmacy files none (SPUF
 * methodology). The stored ranges are per fee type, so a mix of pharmacies with and without a
 * selected fee settles an end of the range only when the brand fees cannot move it.
 */
function selectedSpan(
  selected: FeeRangeReading | undefined,
  brand: FeeRangeReading | undefined,
  span: PricingDeps["feeSpan"],
): FeeSpan {
  if (!selected || selected.fees_readable === 0) return span([brand]);
  if (selected.fees_missing === 0) return span([selected]);
  const own = span([selected]);
  const fallback = span([brand]);
  if (own.status !== "value" || fallback.status !== "value") return own;
  const lowSettled =
    cmp(parseDecimal(fallback.lowest)!, parseDecimal(own.lowest)!) >= 0;
  const highSettled =
    cmp(parseDecimal(fallback.highest)!, parseDecimal(own.highest)!) <= 0;
  return lowSettled && highSettled
    ? own
    : { status: "unknown", reason: FEE_UNKNOWN };
}

/**
 * Which ingredient cost a fill's program options call for. A drug settled as selected is priced
 * from its maximum fair price alone; a drug that may or may not be selected is priced both ways;
 * a drug that is not selected never uses a maximum fair price.
 */
export function ingredientFor(programs: readonly string[]): Ingredient {
  if (programs.length && programs.every((item) => item === "selected"))
    return "maximum_fair_price";
  return programs.includes("selected") ? "open" : "plan_average";
}

/** The rules a planted mutant may replace; production uses `pricingDeps`. */
export interface PricingDeps {
  /** Lowest and highest readable fee over some fee types; no readable fee is unknown, never 0. */
  feeSpan: typeof feeSpan;
  /** The figure for two different amounts in cents: both bounds, in order, never one value. */
  between: (low: number, high: number) => PriceFigure;
  /** Which ingredient cost the program options call for. */
  ingredient: typeof ingredientFor;
}
export const pricingDeps: PricingDeps = {
  ingredient: ingredientFor,
  feeSpan,
  between: (low, high) => ({
    status: "bounded",
    cents: null,
    minimum_cents: low,
    maximum_cents: high,
    reason: FEE_UNKNOWN,
  }),
};

/** Builds a fill's plan-average price from the price reader's answers, or says why it has none. */
export function planAveragePrice(
  unitCost: UnitCost,
  fees: FeeRanges,
  quantity: string,
  deps: PricingDeps = pricingDeps,
): PlanAveragePrice | { status: "unknown"; reason: string } {
  if (unitCost.status !== "value")
    return { status: "unknown", reason: unitCost.reason };
  const amount = parseDecimal(quantity);
  if (!amount || cmp(amount, ZERO) <= 0)
    return { status: "unknown", reason: "quantity_unreadable" };
  const perUnit = parseDecimal(unitCost.unit_cost)!;
  const base = {
    status: "plan_average" as const,
    basis: "cms_plan_average" as const,
    unit_cost: unitCost.unit_cost,
    quantity,
    quantity_basis: unitCost.quantity_basis,
    days_supply: unitCost.days_supply,
    caveat: unitCost.caveat,
    unit_cost_total: formatDecimal(mul(perUnit, amount)),
    pricing_row: unitCost.evidence,
  };
  if (fees.status !== "value") {
    const reason = RELEASE_FEE_REASONS.has(fees.reason)
      ? fees.reason
      : FEE_UNKNOWN;
    const none: FeeSpan = { status: "unknown", reason };
    return {
      ...base,
      fees: {
        brand_or_generic: none,
        selected_or_brand: none,
        any_fee_type: none,
      },
      floor: { status: "value", highest: null },
      fee_ranges: [],
    };
  }
  const of = (type: FeeRangeReading["fee_type"]) =>
    fees.ranges.find((range) => range.fee_type === type);
  let floor: PlanAveragePrice["floor"] = { status: "value", highest: null };
  for (const range of fees.ranges) {
    if (range.floors_missing > 0) {
      floor = { status: "unknown", reason: "floor_price_unreadable" };
      break;
    }
    const value = tenThousandths(range.max_floor_price);
    if (
      value &&
      (floor.highest === null || cmp(value, parseDecimal(floor.highest)!) > 0)
    )
      floor = { status: "value", highest: formatDecimal(value) };
  }
  return {
    ...base,
    fees: {
      brand_or_generic: deps.feeSpan([of("brand"), of("generic")]),
      selected_or_brand: selectedSpan(
        of("selected"),
        of("brand"),
        deps.feeSpan,
      ),
      any_fee_type: deps.feeSpan([of("brand"), of("generic"), of("selected")]),
    },
    floor,
    fee_ranges: fees.ranges.map((range) => ({
      ...range.evidence,
      channel: fees.channel,
      days_supply: fees.days_supply,
      fee_type: range.fee_type,
    })),
  };
}

/** The fee set for a drug's program options: selected, not selected, or still open. */
export function feeSetFor(programs: readonly string[]): FeeSet {
  if (programs.length && programs.every((item) => item === "selected"))
    return "selected_or_brand";
  if (!programs.includes("selected")) return "brand_or_generic";
  return "any_fee_type";
}

const cents = (value: Rational) => Number(roundHalfUpCents(value));
const valueFigure = (value: Rational): PriceFigure => ({
  status: "value",
  cents: cents(value),
});
const unknownFigure = (reason: string): PriceFigure => ({
  status: "unknown",
  cents: null,
  reason,
});

/**
 * The readings for one fill and its price figures. The gross cost is a value when every reading
 * gives the same cents, bounded by the lowest and highest fee when only the fee moves it, and
 * unknown when a fee is missing or a floor price could bind.
 *
 * A selected drug's ingredient cost is its maximum fair price, not the plan average: the law caps
 * a selected drug's negotiated price at the maximum fair price plus any dispensing fee (C7,
 * footnote 7) and CMS prices its worked example at that cap (C12, example 1). Its readings are the
 * maximum fair price plus the lowest and plus the highest selected-drug fee. The maximum fair
 * price excludes the fee, so there is no "already includes the fee" reading, and no floor price
 * can raise the price above the cap. Without a maximum fair price in effect the gross cost stays
 * unknown. While the program is open both sets of readings count.
 */
export function fillPricing(
  price: PlanAveragePrice,
  programs: readonly string[],
  deps: PricingDeps = pricingDeps,
  mfp: FillMfp | null = null,
): FillPricing {
  const feeSet = feeSetFor(programs);
  const ingredient = deps.ingredient(programs);
  const unitTotal = parseDecimal(price.unit_cost_total)!;
  const known = mfp?.status === "value" ? mfp : null;
  const mfpMissing =
    mfp?.status === "unknown" ? mfp.reason : "maximum_fair_price_not_in_effect";
  const mfpFigure: PriceFigure = known
    ? valueFigure(known.total)
    : unknownFigure(ingredient === "plan_average" ? NOT_SELECTED : mfpMissing);

  // The maximum fair price readings, with the selected-drug fee.
  const selectedFee = price.fees.selected_or_brand;
  const mfpReadings: PriceReading[] = [];
  let mfpLow: Rational | null = null;
  let mfpHigh: Rational | null = null;
  let mfpReason: string | null = null;
  if (!known) {
    mfpReadings.push({ key: "mfp_unknown", gross: null });
    mfpReason = mfpMissing;
  } else if (selectedFee.status !== "value") {
    mfpReadings.push({ key: "fee_unknown", gross: null });
    mfpReason = selectedFee.reason;
  } else {
    mfpLow = add(known.total, parseDecimal(selectedFee.lowest)!);
    mfpHigh = add(known.total, parseDecimal(selectedFee.highest)!);
    mfpReadings.push(
      { key: "mfp_lowest_fee", gross: mfpLow },
      { key: "mfp_highest_fee", gross: mfpHigh },
    );
  }

  if (ingredient === "maximum_fair_price") {
    const figures = {
      unit_cost_total: valueFigure(unitTotal),
      maximum_fair_price_total: mfpFigure,
    };
    if (!mfpLow || !mfpHigh) {
      const missing = unknownFigure(mfpReason!);
      return {
        fee_set: feeSet,
        ingredient,
        readings: mfpReadings,
        reason: mfpReason,
        mfp: known,
        figures: {
          ...figures,
          total_lowest_fee: missing,
          total_highest_fee: missing,
          gross: missing,
        },
      };
    }
    const agree = cents(mfpLow) === cents(mfpHigh);
    return {
      fee_set: feeSet,
      ingredient,
      readings: agree ? [mfpReadings[0]!] : mfpReadings,
      reason: agree ? null : FEE_UNKNOWN,
      mfp: known,
      figures: {
        ...figures,
        total_lowest_fee: valueFigure(mfpLow),
        total_highest_fee: valueFigure(mfpHigh),
        gross: agree
          ? valueFigure(mfpLow)
          : deps.between(cents(mfpLow), cents(mfpHigh)),
      },
    };
  }

  const fee = price.fees[feeSet];
  const readings: PriceReading[] = [{ key: "unit_cost", gross: unitTotal }];
  let low: Rational | null = null;
  let high: Rational | null = null;
  if (fee.status === "value") {
    low = add(unitTotal, parseDecimal(fee.lowest)!);
    high = add(unitTotal, parseDecimal(fee.highest)!);
    readings.push(
      { key: "lowest_fee", gross: low },
      { key: "highest_fee", gross: high },
    );
  } else readings.push({ key: "fee_unknown", gross: null });
  // A floor no file explains could raise the price above the unit cost.
  let floorBinds = false;
  if (price.floor.status === "unknown") {
    floorBinds = true;
    readings.push({ key: "floor_price", gross: null });
  } else if (price.floor.highest !== null) {
    const floor = parseDecimal(price.floor.highest)!;
    if (cmp(floor, unitTotal) > 0) {
      floorBinds = true;
      readings.push({ key: "floor_price", gross: floor });
    }
  }
  // While the program is open, the selected-drug readings count as well.
  if (ingredient === "open")
    for (const reading of mfpReadings)
      if (!readings.some((item) => item.key === reading.key))
        readings.push(reading);
  const priced = readings.every((reading) => reading.gross !== null);
  const distinct = new Set(
    readings.map((reading) =>
      reading.gross === null ? "none" : String(cents(reading.gross)),
    ),
  );
  const agree = priced && distinct.size === 1;
  let reason: string | null = null;
  if (!agree) {
    if (floorBinds) reason = FLOOR_MAY_APPLY;
    else reason = ingredient === "open" ? MFP_MAY_APPLY : FEE_UNKNOWN;
  }
  const feeReason = fee.status === "unknown" ? fee.reason : FEE_UNKNOWN;
  let gross: PriceFigure;
  if (agree) gross = valueFigure(unitTotal);
  else if (floorBinds || !low || !high)
    gross = unknownFigure(floorBinds ? FLOOR_MAY_APPLY : feeReason);
  else if (ingredient === "open") gross = unknownFigure(reason!);
  else gross = deps.between(cents(low), cents(high));
  return {
    fee_set: feeSet,
    ingredient,
    readings: agree ? [readings[0]!] : readings,
    reason,
    mfp: ingredient === "open" ? known : null,
    figures: {
      unit_cost_total: valueFigure(unitTotal),
      total_lowest_fee: low ? valueFigure(low) : unknownFigure(feeReason),
      total_highest_fee: high ? valueFigure(high) : unknownFigure(feeReason),
      gross,
      maximum_fair_price_total: mfpFigure,
    },
  };
}
