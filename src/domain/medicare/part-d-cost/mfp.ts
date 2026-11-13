import type { DrugListFile } from "./classification.js";
import { loadDrugListFile } from "./classification.js";
import type { Rational } from "./decimal.js";
import {
  ZERO,
  cmp,
  fromCents,
  mul,
  parseDecimal,
  roundHalfUpCents,
} from "./decimal.js";
import type { Citation } from "./program-rules.js";

/**
 * The maximum fair price of a selected drug, read from the CMS Selected Drug List and Maximum Fair
 * Price data file (C16) as pinned in data/medicare-part-d/drug-lists.json. The negotiated price of
 * a selected drug must not exceed the maximum fair price plus any dispensing fee (C7, footnote 7),
 * and CMS's worked example prices a selected drug at exactly that: ingredient cost equal to the
 * maximum fair price, plus the dispensing fee (C12, example 1).
 *
 * Only an exact NDC-11 matches, and only a period whose dates hold the fill date. Another year's
 * prices are never used. The file gives a price per unit of the NDC-9; the quantity is the
 * caller's count of NDC units, the same basis as the plan-average unit cost.
 */

/** One row of the CMS file in effect during a year. */
export interface MfpPeriod {
  ndc11: string;
  from: string;
  /** Null when the row has no end date. */
  to: string | null;
  /** Dollars per unit, as the file gives it without the dollar sign. */
  unit_price: string;
  row: number;
}

export interface MfpFile extends DrugListFile {
  maximumFairPrices: {
    document: string;
    member: string;
    column: string;
    rule: string;
    citations: Citation[];
    years: Record<string, MfpPeriod[]>;
  };
}

export type MfpLookup =
  | {
      status: "value";
      /** Dollars per NDC unit. */
      unit_price: string;
      effective_from: string;
      effective_to: string | null;
      citations: Citation[];
    }
  | {
      status: "unknown";
      reason:
        | "maximum_fair_price_not_pinned"
        | "maximum_fair_price_not_in_effect"
        | "maximum_fair_price_rows_disagree";
      citations: Citation[];
    };

/** The maximum fair price per unit in effect for an NDC-11 on a date of the contract year. */
export function maximumFairPrice(
  year: number,
  ndc: string,
  date: string,
  lists: MfpFile = loadDrugListFile() as MfpFile,
): MfpLookup {
  const prices = lists.maximumFairPrices;
  const periods = prices?.years[String(year)];
  if (!periods || !date.startsWith(`${year}-`))
    return {
      status: "unknown",
      reason: "maximum_fair_price_not_pinned",
      citations: [],
    };
  const { document, member } = prices;
  const fileCitations = prices.citations;
  const found = periods.filter(
    (item) =>
      item.ndc11 === ndc &&
      item.from <= date &&
      (item.to === null || item.to >= date),
  );
  const cite = (item: MfpPeriod): Citation => ({
    document,
    member,
    row: item.row,
    section: `Maximum fair price per unit, NDC-11 ${item.ndc11}, ${item.from} to ${item.to ?? "open"}`,
  });
  if (!found.length)
    return {
      status: "unknown",
      reason: "maximum_fair_price_not_in_effect",
      citations: [
        {
          document,
          member,
          section: `Maximum fair price: NDC-11 ${ndc} has no row in effect on ${date}`,
        },
      ],
    };
  if (new Set(found.map((item) => item.unit_price)).size > 1)
    return {
      status: "unknown",
      reason: "maximum_fair_price_rows_disagree",
      citations: found.map(cite),
    };
  const first = found[0]!;
  return {
    status: "value",
    unit_price: first.unit_price,
    effective_from: first.from,
    effective_to: first.to,
    citations: [...found.map(cite), ...fileCitations],
  };
}

/** A fill's maximum fair price: the unit price times the quantity, rounded to the cent. */
export function mfpTotal(unitPrice: string, quantity: string): Rational | null {
  const price = parseDecimal(unitPrice);
  const amount = parseDecimal(quantity);
  if (!price || !amount || cmp(amount, ZERO) <= 0 || cmp(price, ZERO) <= 0)
    return null;
  return fromCents(roundHalfUpCents(mul(price, amount)));
}
