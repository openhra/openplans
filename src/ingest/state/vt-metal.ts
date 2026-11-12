import { readFile } from "node:fs/promises";
import type { StateCatalogRow } from "./catalog.js";

export interface VtMetalAttribute {
  source_row: number;
  metal: string;
  on_exchange: boolean;
  off_exchange: boolean;
  raw: Record<string, string>;
}
const document = JSON.parse(
  await readFile(
    new URL(
      "../../../data/rating-rules/vt-plan-metals-2026.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  schema_version: string;
  plan_year: number;
  rate_url: string;
  rate_sha256: string;
  bundle_url: string;
  bundle_sha256: string;
  member: string;
  plans: {
    plan_key: string;
    source_record: string;
    prices: Record<string, number>;
    hios_id: string;
    metal: string;
    attributes: {
      source_row: number;
      plan_id: string;
      metal: string;
      exchange: string;
      child_only_offering: string;
      ehb_fraction: string;
    }[];
  }[];
};
if (
  document.schema_version !== "vt-plan-metals-v1" ||
  document.plan_year !== 2026
)
  throw new Error("Invalid VT metal source cut");

export function vtMetalCatalogComplete(rows: StateCatalogRow[]) {
  return document.plans.every(
    (plan) => rows.filter((row) => row.plan_key === plan.plan_key).length === 1,
  );
}

/** Literal CMS metal cells corroborate the existing filed-to-HIOS identity.
 * A missing row or conflicting cell invalidates the whole plan's evidence. */
export function vtFiledMetal(
  row: StateCatalogRow,
  attributes: VtMetalAttribute[],
  bundle: { bundle_url: string; bundle_sha256: string } | undefined,
) {
  const plan = document.plans.find((p) => p.plan_key === row.plan_key);
  if (
    row.state !== "VT" ||
    row.plan_year !== document.plan_year ||
    row.region !== "Vermont" ||
    row.rate.childOnly ||
    row.hios_match !== "matched" ||
    !plan ||
    row.hios_id !== plan.hios_id ||
    row.rate.provenance.sourceUrl !== document.rate_url ||
    row.rate.provenance.sourceSha256 !== document.rate_sha256 ||
    row.rate.provenance.sourceRecord !== plan.source_record ||
    Object.entries(row.rate.prices).some(
      ([tier, price]) => plan.prices[tier] !== price,
    ) ||
    bundle?.bundle_url !== document.bundle_url ||
    bundle.bundle_sha256 !== document.bundle_sha256 ||
    attributes.length !== plan.attributes.length ||
    new Set(attributes.map((a) => a.source_row)).size !== attributes.length ||
    attributes.some((a) => {
      const cell = plan.attributes.find((p) => p.source_row === a.source_row);
      return (
        !cell ||
        a.metal !== cell.metal ||
        a.metal !== plan.metal ||
        a.raw.MetalLevel !== cell.metal ||
        !a.on_exchange ||
        !a.off_exchange ||
        a.raw.PlanId !== cell.plan_id ||
        a.raw["QHP NONQHP TYPE ID"] !== cell.exchange ||
        a.raw.ChildOnlyOffering !== cell.child_only_offering ||
        a.raw["EHB PERCENT PREMIUM"] !== cell.ehb_fraction
      );
    })
  )
    return null;
  return {
    source: "cms_sbe_puf_plan_attributes" as const,
    evidence: "filed_plan_identity" as const,
    metal: plan.metal,
    off_exchange: plan.attributes.every(
      (a) => a.exchange === "Off the Exchange",
    ),
    source_url: document.bundle_url,
    source_sha256: document.bundle_sha256,
    member: document.member,
    source_rows: plan.attributes.map((a) => a.source_row),
    columns: { metal: "METAL LEVEL", hios_id: "STANDARD COMPONENT ID" },
  };
}
