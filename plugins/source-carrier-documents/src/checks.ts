import { MAX_UNDEFINED_TIER_SHARE, REFUSAL } from "./constants.js";
import { statedTierSchema } from "./extract.js";
import type { ExtractedFormulary } from "./extract.js";

/** What `validate` reads back from the staged tables for one document. */
export interface StagedDocument {
  rows: number;
  /** Tier numbers the document's own legend defines. */
  legendTiers: number[];
  /**
   * Tiers the legend leaves out that the document's text states, keyed by tier number, each with
   * the page, line and raw text that states it. Anything without that evidence is not admitted.
   */
  statedTiers: Record<string, unknown>;
  /** Tier numbers of the rows not kept as `unknown`; each must be admitted. */
  rowTiers: number[];
  /** Rows kept as `unknown` because their tier is neither in the legend nor stated by the text. */
  undefinedTierRows: number;
  qlFlagRows: number;
  qlTextRows: number;
  /** The year printed on the cover, or null when it could not be read. */
  planYear: number | null;
}

/**
 * The tiers a document's rows may use: its legend's, plus each tier its own text states with
 * evidence (page, line and the raw line). A tier with no such statement is never admitted.
 */
export function admittedTiers(
  document: Pick<StagedDocument, "legendTiers" | "statedTiers">,
): number[] {
  const stated = Object.entries(document.statedTiers)
    .filter(([tier, evidence]) => {
      const parsed = statedTierSchema.safeParse(evidence);
      return (
        /^\d{1,2}$/.test(tier) &&
        parsed.success &&
        parsed.data.raw.includes(tier)
      );
    })
    .map(([tier]) => Number(tier));
  return [...new Set([...document.legendTiers, ...stated])];
}

/**
 * The round trips of the carrier-document plan (section 4.2) for one document; the reason code
 * of the first failure, or undefined when the document passes. Any failure refuses that document (the run's other documents are judged on their own):
 * a drug list whose legend is missing, whose served rows use a tier neither its legend nor its own
 * text defines (`admittedTiers`), whose undefined-tier rows exceed `MAX_UNDEFINED_TIER_SHARE` of
 * its rows, or whose QL text outnumbers its QL flags has been misread. Undefined-tier rows within
 * the share are kept as `unknown` and never served.
 */
export function documentRefusal(
  document: StagedDocument,
  runYears: readonly number[],
): string | undefined {
  if (document.rows === 0) return REFUSAL.empty;
  if (!document.legendTiers.length) return REFUSAL.legendMissing;
  const admitted = admittedTiers(document);
  if (document.rowTiers.some((tier) => !admitted.includes(tier)))
    return REFUSAL.histogram;
  if (document.undefinedTierRows > document.rows * MAX_UNDEFINED_TIER_SHARE)
    return REFUSAL.histogram;
  if (document.qlFlagRows < document.qlTextRows) return REFUSAL.quantityLimit;
  if (document.planYear === null) return REFUSAL.yearUnresolved;
  if (!runYears.includes(document.planYear)) return REFUSAL.yearOutsideRun;
  return undefined;
}

/** The checks' view of one freshly extracted document, the same one `validate` reads back. */
export function stagedFromExtracted(
  extracted: ExtractedFormulary,
): StagedDocument {
  const legendTiers = Object.keys(extracted.legend.tiers).map(Number);
  const admitted = admittedTiers({
    legendTiers,
    statedTiers: extracted.legend.stated_tiers,
  });
  const served = extracted.rows.filter((row) => admitted.includes(row.tier));
  return {
    rows: extracted.rows.length,
    legendTiers,
    statedTiers: extracted.legend.stated_tiers,
    rowTiers: [...new Set(served.map((row) => row.tier))],
    undefinedTierRows: extracted.rows.length - served.length,
    qlFlagRows: extracted.rows.filter((row) => row.flags.includes("QL")).length,
    qlTextRows: extracted.rows.filter((row) => row.ql_text).length,
    planYear: extracted.cover.plan_year,
  };
}
