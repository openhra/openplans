import type { Rational } from "./decimal.js";
import { parseDecimal } from "./decimal.js";

/**
 * Drug-program figures that the annual parameter file does not hold: the selected drug subsidy,
 * the manufacturer discount and the special rules for covered insulin and ACIP-recommended adult
 * vaccines. Every figure cites a pinned CMS document (ids from data/medicare-part-d/documents.json).
 * A year without a documented rate keeps a range, and anything that depends on where in the range
 * the rate falls stays unknown.
 */

export interface Citation {
  document: string;
  section: string;
  page?: number;
  /** For a pinned archive: the member, sheet and row cited inside it. */
  member?: string;
  sheet?: string;
  row?: number;
  /** The words of the cited document, where a pin records them. */
  quote?: string;
}

export type DrugProgram = "selected" | "applicable" | "not_applicable";

export interface ProgramClass {
  /** Who pays the initial-coverage share: the selected drug subsidy, the discount, or nobody. */
  payer: "selected_drug_subsidy" | "manufacturer_discount" | "none";
  /** Initial-coverage rate as [lowest, highest]; equal ends mean the rate is documented. */
  initial: readonly [Rational, Rational];
  /** Catastrophic-phase rate, or null when no pinned document gives it for the year. */
  catastrophic: Rational | null;
  citations: Citation[];
}

export interface ProgramRules {
  contract_year: number;
  classes: Record<DrugProgram, ProgramClass>;
  insulin: {
    /** Statutory ceiling for a one-month supply: the lesser of this copay and this share. */
    copay_cap: Rational;
    price_share_cap: Rational;
    citations: Citation[];
  };
  vaccine: { citations: Citation[] };
}

const rate = (text: string) => parseDecimal(text)!;
const fixed = (text: string) => [rate(text), rate(text)] as const;

const subsidy2026: Citation[] = [
  {
    document: "C4",
    section:
      "Section 70, Selected Drug Subsidy: 10 percent of the negotiated price, available in the initial coverage phase",
    page: 39,
  },
  {
    document: "C7",
    section: "Section 1, Calculating and Reporting the Selected Drug Subsidy",
    page: 3,
  },
];
const discount2026: Citation[] = [
  {
    document: "C4",
    section:
      "Section 20, Redesigned Part D Benefit in CY 2026: Discount Program typically 10 percent in initial coverage and 20 percent in the catastrophic phase",
    page: 25,
  },
  {
    document: "C7",
    section: "Section 3, Example #9",
    page: 14,
  },
];
const notApplicable: Citation[] = [
  {
    document: "C4",
    section:
      "Section 20, footnote 25: definition of an applicable drug, which excludes a selected drug",
    page: 25,
  },
];
const insulinCitations = (year: number): Citation[] => [
  {
    document: "C8",
    section:
      "Insulin Cost Sharing: for 2026 and each subsequent year, the lesser of $35, 25% of the maximum fair price or 25% of the negotiated price",
  },
  ...(year === 2026
    ? [
        {
          document: "C7",
          section: "Section 3, Covered Insulin Product Lesser of Logic",
          page: 12,
        },
      ]
    : [
        {
          document: "C10",
          section:
            "Attachment III, Section A, Annual Adjustments to Medicare Part D Benefit Parameters in 2027",
          page: 69,
        },
      ]),
];
const vaccineCitations: Citation[] = [
  {
    document: "C8",
    section:
      "Vaccine Cost Sharing: no deductible and no cost sharing for an ACIP-recommended adult vaccine",
  },
];
/** 2027: the documents give 25% beneficiary cost sharing for applicable drugs but no subsidy rate. */
const bounded2027: Citation[] = [
  {
    document: "C10",
    section:
      "Attachment III, Section A3, Table III-6: 25% initial-coverage cost sharing for applicable, non-applicable and selected drugs in 2027; no subsidy or discount rate is given",
    page: 76,
  },
];

const tables: Record<number, ProgramRules> = {
  2026: {
    contract_year: 2026,
    classes: {
      selected: {
        payer: "selected_drug_subsidy",
        initial: fixed("0.10"),
        catastrophic: rate("0"),
        citations: subsidy2026,
      },
      applicable: {
        payer: "manufacturer_discount",
        initial: fixed("0.10"),
        catastrophic: rate("0.20"),
        citations: discount2026,
      },
      not_applicable: {
        payer: "none",
        initial: fixed("0"),
        catastrophic: rate("0"),
        citations: notApplicable,
      },
    },
    insulin: {
      copay_cap: rate("35"),
      price_share_cap: rate("0.25"),
      citations: insulinCitations(2026),
    },
    vaccine: { citations: vaccineCitations },
  },
  2027: {
    contract_year: 2027,
    classes: {
      selected: {
        payer: "selected_drug_subsidy",
        initial: [rate("0"), rate("0.75")],
        catastrophic: null,
        citations: bounded2027,
      },
      applicable: {
        payer: "manufacturer_discount",
        initial: [rate("0"), rate("0.75")],
        catastrophic: null,
        citations: bounded2027,
      },
      not_applicable: {
        payer: "none",
        initial: fixed("0"),
        catastrophic: rate("0"),
        citations: notApplicable,
      },
    },
    insulin: {
      copay_cap: rate("35"),
      price_share_cap: rate("0.25"),
      citations: insulinCitations(2027),
    },
    vaccine: { citations: vaccineCitations },
  },
};

export function programRules(year: number): ProgramRules | null {
  return tables[year] ?? null;
}
