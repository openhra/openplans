import type { SqlSession } from "@openplans/plugin-sdk";
import {
  SBC_SOURCE_LABEL,
  SBC_UNKNOWN_REASON,
  SERVED_CONFIDENCE,
} from "./constants.js";
import { checkItem, pufCostSharing, pufHasCostSharing } from "./sbc-compare.js";

/** Where an SBC prints an item: the PDF, its hash and coverage period, and the page. */
export interface SbcCitation {
  url: string;
  sha256: string;
  plan_year: number;
  coverage_period: { start: string; end: string };
  printed_plan_name: string | null;
  page: number;
}

/** One question or chart row of the SBC for the plan, and how it may be used. */
export type SbcItemAnswer =
  | {
      /** The federal tables have no value for this item: the SBC's value is served, labelled as such. */
      item: string;
      status: "served";
      source: typeof SBC_SOURCE_LABEL;
      value: string;
      evidence: SbcCitation;
    }
  | {
      /** The federal tables and the SBC disagree; neither is picked. */
      item: string;
      status: "conflicting";
      puf: { benefit: string; value: string };
      sbc: { value: string; evidence: SbcCitation };
    }
  | {
      /** The federal tables answer this item; the SBC is only a check (`agrees` null: not comparable). */
      item: string;
      status: "puf_value";
      agrees: boolean | null;
    }
  | { item: string; status: "unknown"; reason: string };

export type SbcCostSharingAnswer =
  | { status: "unknown"; reason: string }
  | {
      status: "available";
      plan_id: string;
      plan_year: number;
      items: SbcItemAnswer[];
    };

const VARIANT = /^[0-9]{5}[A-Z]{2}[0-9]{7}-[0-9]{2}$/;

const ACTIVE_SBC_LINKS = `
  FROM plg_carrierdoc_sbc_link l
  JOIN snapshot s ON s.snapshot_id = l.snapshot_id AND s.validation_state = 'ACTIVE'`;

/**
 * Cost sharing from the active SBC documents for one plan variant and plan year
 * (D-PDF-5: SBC values cross-check the federal tables and fill only what they lack).
 *
 * - Only a document attached to exactly this variant is read; ambiguous and unmapped documents
 *   answer `unknown`.
 * - Each item is checked against the federal tables as they are now. Where the tables have a value,
 *   it stays theirs: `puf_value` when the SBC agrees or cannot be compared, `conflicting` (both
 *   values named, neither picked) when it disagrees.
 * - Only where the tables hold no cost sharing for the variant at all (an SBE scope without
 *   benefit files or deductible columns) is the SBC's value `served`, with
 *   `source: "sbc_document"` and the page it is printed on. A plan the tables cover answers the
 *   items they leave out `unknown` (`puf_has_cost_sharing`), never from the SBC.
 * - Only `high` confidence rows are compared or served; the rest are `unknown`
 *   (`pdf_low_confidence`).
 */
export async function sbcCostSharingEvidence(
  db: SqlSession,
  query: { planId: string; planYear: number },
): Promise<SbcCostSharingAnswer> {
  if (!VARIANT.test(query.planId))
    return { status: "unknown", reason: SBC_UNKNOWN_REASON.variantRequired };
  const links = await db.query<{
    snapshot_id: string;
    status: string;
    variant_plan_id: string | null;
  }>(
    `SELECT l.snapshot_id, l.status, l.variant_plan_id ${ACTIVE_SBC_LINKS}
     WHERE l.issuer_id = $1 AND l.plan_year = $2`,
    [query.planId.slice(0, 5), query.planYear],
  );
  const mine = links.rows.filter(
    (row) => row.status === "attached" && row.variant_plan_id === query.planId,
  );
  if (mine.length !== 1) {
    let reason: string = SBC_UNKNOWN_REASON.noDocument;
    if (
      mine.length > 1 ||
      links.rows.some((row) => row.status === "plan_mapping_ambiguous")
    )
      reason = SBC_UNKNOWN_REASON.ambiguous;
    else if (links.rows.length) reason = SBC_UNKNOWN_REASON.notMapped;
    return { status: "unknown", reason };
  }
  const snapshotId = mine[0]!.snapshot_id;
  const { rows } = await db.query<{
    section: "question" | "chart";
    item: string;
    label: string | null;
    sub_label: string | null;
    network: string;
    confidence: string;
    page: number;
    url: string;
    document_sha256: string;
    plan_year: number;
    coverage_start: string;
    coverage_end: string;
    printed_plan_name: string | null;
  }>(
    `SELECT r.section, r.item, r.label, r.sub_label, r.network, r.confidence, r.page,
            d.url, d.document_sha256, d.plan_year, d.coverage_start::text, d.coverage_end::text,
            d.printed_plan_name
     FROM plg_carrierdoc_sbc_row r JOIN plg_carrierdoc_sbc_document d USING (snapshot_id)
     WHERE r.snapshot_id = $1 AND r.label IS NOT NULL ORDER BY r.ordinal`,
    [snapshotId],
  );
  const puf = await pufCostSharing(db, query.planId, query.planYear);
  const pufCoversPlan = pufHasCostSharing(puf);
  const items = rows.map((row): SbcItemAnswer => {
    if (row.confidence !== SERVED_CONFIDENCE)
      return {
        item: row.item,
        status: "unknown",
        reason: SBC_UNKNOWN_REASON.lowConfidence,
      };
    const evidence: SbcCitation = {
      url: row.url,
      sha256: row.document_sha256,
      plan_year: row.plan_year,
      coverage_period: { start: row.coverage_start, end: row.coverage_end },
      printed_plan_name: row.printed_plan_name,
      page: row.page,
    };
    const check = checkItem(
      {
        section: row.section,
        label: row.label,
        subLabel: row.sub_label,
        network: row.network,
      },
      puf,
    );
    switch (check.status) {
      case "conflicting":
        return {
          item: row.item,
          status: "conflicting",
          puf: { benefit: check.pufBenefit!, value: check.pufValue! },
          sbc: { value: row.network, evidence },
        };
      case "agrees":
        return { item: row.item, status: "puf_value", agrees: true };
      case "not_compared":
        return { item: row.item, status: "puf_value", agrees: null };
      case "no_puf_counterpart":
      case "puf_absent":
        if (pufCoversPlan)
          return {
            item: row.item,
            status: "unknown",
            reason: SBC_UNKNOWN_REASON.pufCoversPlan,
          };
        break;
    }
    return {
      item: row.item,
      status: "served",
      source: SBC_SOURCE_LABEL,
      value: row.network,
      evidence,
    };
  });
  return {
    status: "available",
    plan_id: query.planId,
    plan_year: query.planYear,
    items,
  };
}
