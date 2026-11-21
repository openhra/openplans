import type { SqlSession } from "@openplans/plugin-sdk";
import type { IssuerScope } from "./args.js";
import { checkItem, pufCostSharing } from "./sbc-compare.js";
import type { ItemCheck, SbcItem } from "./sbc-compare.js";
import type { SbcLink } from "./sbc-discover.js";
import type { ExtractedSbc } from "./sbc-extract.js";
import type { CatalogVariant, SbcPlanLink } from "./sbc-match.js";

export const SBC_DOCUMENT_TABLE = "plg_carrierdoc_sbc_document";
export const SBC_ROW_TABLE = "plg_carrierdoc_sbc_row";
export const SBC_LINK_TABLE = "plg_carrierdoc_sbc_link";
export const SBC_CHECK_TABLE = "plg_carrierdoc_sbc_check";

/** The variants of an issuer's active federal catalog for one plan year (medical, individual). */
export async function catalogVariants(
  tx: SqlSession,
  issuer: IssuerScope,
  planYear: number,
): Promise<CatalogVariant[]> {
  const { rows } = await tx.query<{
    variant_plan_id: string;
    base_plan_id: string;
    name: string;
  }>(
    `SELECT v.variant_plan_id, v.base_plan_id,
            coalesce(nullif(trim(v.variant_name), ''), p.plan_name) AS name
     FROM plan_variant v
     JOIN plan p ON p.snapshot_id = v.snapshot_id AND p.base_plan_id = v.base_plan_id
     JOIN puf_import_file f ON f.snapshot_id = v.snapshot_id AND f.kind = 'plan-attributes'
     JOIN puf_active_catalog a ON a.import_id = f.import_id
       AND a.state = v.state AND a.plan_year = v.plan_year
     WHERE v.state = $1 AND v.issuer_id = $2 AND v.plan_year = $3
       AND NOT p.dental_only AND lower(p.market) = 'individual'
     ORDER BY v.variant_plan_id`,
    [issuer.state, issuer.issuerId, planYear],
  );
  return rows.map((row) => ({
    variantPlanId: row.variant_plan_id,
    basePlanId: row.base_plan_id,
    name: row.name,
  }));
}

/** Every question and chart row of a document, numbered in reading order. */
export function sbcItems(
  extracted: ExtractedSbc,
): (SbcItem & { ordinal: number; confidence: string })[] {
  return [
    ...extracted.questions.map((q) => ({
      section: "question" as const,
      label: q.label,
      subLabel: null,
      network: q.answer,
      confidence: q.confidence,
    })),
    ...extracted.chart.map((row) => ({
      section: "chart" as const,
      label: row.label,
      subLabel: row.sub_label,
      network: row.network,
      confidence: row.confidence,
    })),
  ].map((item, index) => ({ ...item, ordinal: index + 1 }));
}

/** The item name a row is stored and answered under: the label, with a carrier sub-row after it. */
export const itemName = (
  label: string | null,
  subLabel: string | null,
  text: string,
) => {
  if (!label) return text;
  return subLabel ? `${label}: ${subLabel}` : label;
};

/** Drop what an earlier run staged for the same documents, issuers and years. */
export async function clearEarlierSbc(
  tx: SqlSession,
  urls: readonly string[],
  issuerIds: readonly string[],
  years: readonly number[],
): Promise<void> {
  const earlier = `SELECT snapshot_id FROM ${SBC_DOCUMENT_TABLE} WHERE url = ANY($1::text[])`;
  for (const table of [SBC_ROW_TABLE, SBC_LINK_TABLE, SBC_CHECK_TABLE])
    await tx.query(`DELETE FROM ${table} WHERE snapshot_id IN (${earlier})`, [
      urls,
    ]);
  await tx.query(
    `DELETE FROM ${SBC_CHECK_TABLE} WHERE snapshot_id IN (SELECT snapshot_id FROM ${SBC_LINK_TABLE}
       WHERE issuer_id = ANY($1::text[]) AND plan_year = ANY($2::int[]))`,
    [issuerIds, years],
  );
  await tx.query(
    `DELETE FROM ${SBC_LINK_TABLE} WHERE issuer_id = ANY($1::text[]) AND plan_year = ANY($2::int[])`,
    [issuerIds, years],
  );
  await tx.query(
    `DELETE FROM ${SBC_DOCUMENT_TABLE} WHERE url = ANY($1::text[])`,
    [urls],
  );
}

export async function writeSbcDocument(
  tx: SqlSession,
  file: SbcLink & { snapshotId: string },
  extracted: ExtractedSbc,
): Promise<void> {
  const period = extracted.coverage_period!;
  const items = sbcItems(extracted);
  const confidence: Record<string, number> = {};
  for (const item of items)
    confidence[item.confidence] = (confidence[item.confidence] ?? 0) + 1;
  await tx.query(
    `INSERT INTO ${SBC_DOCUMENT_TABLE}(snapshot_id,document_sha256,url,url_year,plan_year,coverage_start,
       coverage_end,printed_plan_name,file_hios_ids,states,pages,confidence_counts,missing_services)
     VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,$8,$9::jsonb,$10::text[],$11,$12::jsonb,$13::jsonb)`,
    [
      file.snapshotId,
      extracted.sha256,
      file.url,
      file.urlYear,
      period.plan_year,
      period.start,
      period.end,
      extracted.plan_name,
      JSON.stringify(file.hiosIds),
      file.states,
      extracted.pages,
      JSON.stringify(confidence),
      JSON.stringify(extracted.missing_services),
    ],
  );
  const rows = [
    ...extracted.questions.map((q) => ({
      section: "question",
      label: q.label,
      sub_label: null,
      label_match: q.matched ? "exact" : null,
      label_text: q.label_text,
      page: q.page,
      event: null,
      network: q.answer,
      out_of_network: null,
      limitations: null,
      raw_text: q.raw.join("\n"),
      confidence: q.confidence,
      reasons: [],
    })),
    ...extracted.chart.map((row) => ({
      section: "chart",
      label: row.label,
      sub_label: row.sub_label,
      label_match: row.match,
      label_text: row.label_text,
      page: row.page,
      event: row.event,
      network: row.network,
      out_of_network: row.out_of_network,
      limitations: row.limitations,
      raw_text: row.raw.join("\n"),
      confidence: row.confidence,
      reasons: row.reasons,
    })),
  ].map((row, index) => ({
    ...row,
    ordinal: index + 1,
    item: itemName(row.label, row.sub_label, row.label_text),
  }));
  await tx.query(
    `INSERT INTO ${SBC_ROW_TABLE}(snapshot_id,ordinal,section,item,label,sub_label,label_match,label_text,page,
       event,network,out_of_network,limitations,raw_text,confidence,reasons)
     SELECT $1, r.ordinal, r.section, r.item, r.label, r.sub_label, r.label_match, r.label_text, r.page,
       r.event, r.network, r.out_of_network, r.limitations, r.raw_text, r.confidence, r.reasons
     FROM jsonb_to_recordset($2::jsonb) AS r(ordinal int, section text, item text, label text,
       sub_label text, label_match text, label_text text, page int, event text, network text,
       out_of_network text, limitations text, raw_text text, confidence text, reasons jsonb)`,
    [file.snapshotId, JSON.stringify(rows)],
  );
}

export async function writeSbcLink(
  tx: SqlSession,
  snapshotId: string,
  issuer: IssuerScope,
  planYear: number,
  link: SbcPlanLink,
): Promise<void> {
  const variants = link.status === "attached" ? link.variantPlanIds : [null];
  await tx.query(
    `INSERT INTO ${SBC_LINK_TABLE}(snapshot_id,state,issuer_id,plan_year,method,status,variant_plan_id,candidates)
     SELECT $1, $2, $3, $4, $5, $6, v, $7 FROM unnest($8::text[]) AS v`,
    [
      snapshotId,
      issuer.state,
      issuer.issuerId,
      planYear,
      link.method,
      link.status,
      link.candidates,
      variants,
    ],
  );
}

/** Cross-check every item of an attached document against each variant's PUF values. */
export async function writeSbcChecks(
  tx: SqlSession,
  snapshotId: string,
  planYear: number,
  variantPlanIds: readonly string[],
  extracted: ExtractedSbc,
): Promise<Record<ItemCheck["status"], number>> {
  const counts = {
    agrees: 0,
    conflicting: 0,
    puf_absent: 0,
    not_compared: 0,
    no_puf_counterpart: 0,
  };
  const items = sbcItems(extracted).filter((item) => item.label);
  for (const variant of variantPlanIds) {
    const puf = await pufCostSharing(tx, variant, planYear);
    const checks = items.map((item) => {
      const check = checkItem(item, puf);
      counts[check.status]++;
      return {
        ordinal: item.ordinal,
        item: itemName(item.label, item.subLabel, ""),
        status: check.status,
        puf_benefit: check.pufBenefit,
        puf_value: check.pufValue,
        sbc_value: item.network,
      };
    });
    if (!checks.length) continue;
    await tx.query(
      `INSERT INTO ${SBC_CHECK_TABLE}(snapshot_id,variant_plan_id,ordinal,item,status,puf_benefit,puf_value,sbc_value)
       SELECT $1, $2, c.ordinal, c.item, c.status, c.puf_benefit, c.puf_value, c.sbc_value
       FROM jsonb_to_recordset($3::jsonb) AS c(ordinal int, item text, status text, puf_benefit text,
         puf_value text, sbc_value text)`,
      [snapshotId, variant, JSON.stringify(checks)],
    );
  }
  return counts;
}
