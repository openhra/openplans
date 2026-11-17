import { centsRatio } from "../ichra/affordability.js";

export interface OfferPrice {
  plan_id: string;
  monthly_cents: number;
}

/** One base plan per offer. Nearest-rank quartiles are selected before any paging. */
export function offerStatistics(offers: readonly OfferPrice[]) {
  const ids = new Set<string>();
  for (const offer of offers) {
    if (
      ids.has(offer.plan_id) ||
      /^\d{5}[A-Z]{2}\d{7}-0[0-6]$/.test(offer.plan_id)
    )
      throw new Error("distinct_base_plans_required");
    if (!Number.isSafeInteger(offer.monthly_cents) || offer.monthly_cents < 0)
      throw new Error("integer_cents_required");
    ids.add(offer.plan_id);
  }
  const prices = offers
    .map((offer) => offer.monthly_cents)
    .sort((a, b) => a - b);
  const count = prices.length;
  const ratio = (numerator: bigint, denominator: bigint) => {
    const exact = centsRatio(numerator, denominator);
    return {
      numerator: exact.numerator,
      denominator: exact.denominator,
      display_cents: exact.display,
    };
  };
  const middle = Math.floor(count / 2);
  return {
    median: count
      ? ratio(
          BigInt(prices[middle]!) +
            (count % 2 ? 0n : BigInt(prices[middle - 1]!)),
          count % 2 ? 1n : 2n,
        )
      : null,
    mean: count
      ? ratio(
          prices.reduce((sum, price) => sum + BigInt(price), 0n),
          BigInt(count),
        )
      : null,
    lowest_cents: prices[0] ?? null,
    p25_cents: count ? prices[Math.ceil(count / 4) - 1]! : null,
    p75_cents: count ? prices[Math.ceil((3 * count) / 4) - 1]! : null,
    small_offer_set: count < 4,
    quantile_method: "nearest_rank" as const,
    weighting: "unweighted_distinct_base_plan" as const,
    currency: "USD" as const,
    period: "month" as const,
  };
}
