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
  "unit_cost" | "lowest_fee" | "highest_fee" | "floor_price" | "fee_unknown";
export interface PriceReading {
  key: PriceReadingKey;
  gross: Rational | null;
}

/** The readings and the price figures for one fill once its fee set is known. */
export interface FillPricing {
  fee_set: FeeSet;
  readings: PriceReading[];
  /** Why the readings disagree; null when one reading prices the claim. */
  reason: "dispensing_fee_unknown" | "floor_price_may_apply" | null;
  figures: {
    unit_cost_total: PriceFigure;
    total_lowest_fee: PriceFigure;
    total_highest_fee: PriceFigure;
    gross: PriceFigure;
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

/** The two rules a planted mutant may replace; production uses `pricingDeps`. */
export interface PricingDeps {
  /** Lowest and highest readable fee over some fee types; no readable fee is unknown, never 0. */
  feeSpan: typeof feeSpan;
  /** The figure for two different amounts in cents: both bounds, in order, never one value. */
  between: (low: number, high: number) => PriceFigure;
}
export const pricingDeps: PricingDeps = {
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
 */
export function fillPricing(
  price: PlanAveragePrice,
  programs: readonly string[],
  deps: PricingDeps = pricingDeps,
): FillPricing {
  const feeSet = feeSetFor(programs);
  const fee = price.fees[feeSet];
  const unitTotal = parseDecimal(price.unit_cost_total)!;
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
  const priced = readings.every((reading) => reading.gross !== null);
  const distinct = new Set(
    readings.map((reading) =>
      reading.gross === null ? "none" : String(cents(reading.gross)),
    ),
  );
  const agree = priced && distinct.size === 1;
  let reason: FillPricing["reason"] = null;
  if (!agree) reason = floorBinds ? FLOOR_MAY_APPLY : FEE_UNKNOWN;
  const feeReason = fee.status === "unknown" ? fee.reason : FEE_UNKNOWN;
  let gross: PriceFigure;
  if (agree) gross = valueFigure(unitTotal);
  else if (floorBinds || !low || !high)
    gross = unknownFigure(floorBinds ? FLOOR_MAY_APPLY : feeReason);
  else gross = deps.between(cents(low), cents(high));
  return {
    fee_set: feeSet,
    readings: agree ? [readings[0]!] : readings,
    reason,
    figures: {
      unit_cost_total: valueFigure(unitTotal),
      total_lowest_fee: low ? valueFigure(low) : unknownFigure(feeReason),
      total_highest_fee: high ? valueFigure(high) : unknownFigure(feeReason),
      gross,
    },
  };
}
