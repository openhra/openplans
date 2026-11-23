import { DRUG_IDENTITY_KIND } from "@openplans/plugin-sdk";
import type {
  IdentityAnswer,
  PassThroughApi,
  PassThroughEvidence,
  PassThroughScope,
} from "@openplans/plugin-sdk";
import type { SqlSession } from "../../db/database.js";
import { parse_hios } from "../hios/index.js";
import { createRxnormRepository } from "../../ingest/rxnorm/repository.js";
import type { DrugConcept } from "../../ingest/rxnorm/repository.js";
import { drugAvailability } from "./availability.js";
import { withDocumentCoverage } from "./documents.js";
import { classifyDrugEvidence } from "./index.js";
import type { DrugCoverage, DrugEvidence } from "./index.js";
import {
  PLAN_LINK_COLUMNS,
  PLAN_LINK_JOINS,
  planLinkOuts,
  withLinkOuts,
} from "../link-outs.js";
import type { PlanLinkCells } from "../link-outs.js";

/**
 * The request-time identity stage: the pass-through API and the inbound request's scope. It is
 * asked only when no RxNorm release is ACTIVE; a loaded release always wins.
 */
export interface DrugIdentityStage {
  api: Pick<PassThroughApi, "apply">;
  scope: PassThroughScope;
}
type IdentityVerdict =
  "confirmed" | "rxcui_not_in_rxnorm" | "rxnorm_terminology_unavailable";

/** The pass-through evidence block on an identity answer: the object naming its `source_id`. */
export function passThroughEvidence(
  answer: object,
): PassThroughEvidence | undefined {
  for (const value of Object.values(answer)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const block = value as Partial<PassThroughEvidence>;
    if (
      typeof block.source_id === "string" &&
      typeof block.served_from === "string"
    )
      return block as PassThroughEvidence;
  }
  return undefined;
}

/**
 * Asks the identity stage whether an RxCUI is a current RxNorm concept. Only `confirmed` lets the
 * coverage check continue. A source that answered without confirming means the RxCUI is not a
 * concept; a source that could not answer means the terminology is unavailable. With no identity
 * source the answer is unchanged and the reason stays `rxcui_not_in_rxnorm`.
 */
async function confirmRxcui(
  stage: DrugIdentityStage,
  rxcui: string,
  year: number,
): Promise<{ verdict: IdentityVerdict; evidence?: PassThroughEvidence }> {
  const asked: IdentityAnswer = {
    status: "unknown",
    reason: "rxnorm_terminology_unavailable",
    identity: rxcui,
    plan_year: year,
  };
  const [answer] = await stage.api.apply(
    DRUG_IDENTITY_KIND,
    [asked],
    stage.scope,
  );
  if (answer?.status === "confirmed")
    return { verdict: "confirmed", evidence: passThroughEvidence(answer) };
  if (!answer || answer === asked) return { verdict: "rxcui_not_in_rxnorm" };
  return {
    verdict:
      answer.reason === "passthrough_identity_not_confirmed"
        ? "rxcui_not_in_rxnorm"
        : "rxnorm_terminology_unavailable",
  };
}

/** Only without an ACTIVE release may the identity stage confirm an RxCUI. */
async function askableStage(
  rxnorm: ReturnType<typeof createRxnormRepository>,
  identity: DrugIdentityStage | undefined,
): Promise<DrugIdentityStage | undefined> {
  if (!identity || (await rxnorm.activeRelease())) return undefined;
  return identity;
}

/** How a requested RxCUI was identified, or why it was not. */
export type DrugIdentity =
  | { status: "release"; concepts: DrugConcept[] }
  | { status: "confirmed"; evidence?: PassThroughEvidence }
  | {
      status: "rxcui_suppressed" | Exclude<IdentityVerdict, "confirmed">;
    };

/**
 * The identity step of `drugCoverage` for routes that need only the drug. A loaded ACTIVE release
 * decides; without one, only the identity stage's `confirmed` identifies the RxCUI.
 */
export async function drugIdentity(
  db: SqlSession,
  rxcui: string,
  year: number,
  identity?: DrugIdentityStage,
): Promise<DrugIdentity> {
  const rxnorm = createRxnormRepository(db);
  const concepts = await rxnorm.conceptByRxcui(rxcui);
  const current = concepts.filter((c) => c.suppress === "N");
  if (current.length) return { status: "release", concepts: current };
  if (concepts.length) return { status: "rxcui_suppressed" };
  const stage = await askableStage(rxnorm, identity);
  if (!stage) return { status: "rxcui_not_in_rxnorm" };
  const { verdict, evidence } = await confirmRxcui(stage, rxcui, year);
  if (verdict !== "confirmed") return { status: verdict };
  return evidence ? { status: verdict, evidence } : { status: verdict };
}

export function createDrugRepository(db: SqlSession) {
  return {
    drugCoverage: (
      planId: string,
      rxcui: string,
      year: number,
      identity?: DrugIdentityStage,
    ) => drugCoverage(db, planId, rxcui, year, identity),
  };
}
/**
 * One plan, RxCUI and year. The issuer's machine-readable files answer first; an `unknown` they
 * leave for a missing or incomplete source set may then be answered from issuer-published
 * documents (`withDocumentCoverage`). The request's pass-through sources run after this, on what
 * is still `unknown`. An answer still `unknown` carries the plan's published formulary page as a
 * link-out, read in the same statement as the plan.
 */
export async function drugCoverage(
  db: SqlSession,
  planId: string,
  rxcui: string,
  year: number,
  identity?: DrugIdentityStage,
): Promise<DrugCoverage> {
  const read: { plan?: PlanLinkCells } = {};
  // The floor runs after the document step: an answer it fills leaves without links.
  return withLinkOuts(
    await withDocumentCoverage(
      db,
      await issuerFileCoverage(db, planId, rxcui, year, identity, read),
      identity?.scope.writer,
    ),
    planLinkOuts(read.plan, "drug"),
  );
}

/** The answer from the issuer's machine-readable files alone. */
async function issuerFileCoverage(
  db: SqlSession,
  planId: string,
  rxcui: string,
  year: number,
  identity: DrugIdentityStage | undefined,
  read: { plan?: PlanLinkCells },
): Promise<DrugCoverage> {
  const result: DrugCoverage = {
    status: "unknown",
    reason: null,
    base_hios_id: null,
    requested_plan_id: planId,
    rxcui,
    plan_year: year,
    drug_tier: null,
    tier_status: null,
    cost_sharing: null,
    prior_authorization: null,
    step_therapy: null,
    quantity_limit: null,
    patient_price: null,
    evidence: [],
    snapshot_id: null,
    manifest_snapshot_id: null,
  };
  let hios: ReturnType<typeof parse_hios>;
  try {
    hios = parse_hios(planId);
  } catch {
    return { ...result, reason: "invalid_plan_id" };
  }
  result.base_hios_id = hios.base;
  if (!Number.isInteger(year) || year < 2014 || year > 2100)
    return { ...result, reason: "invalid_year" };
  if (typeof rxcui !== "string" || !/^\d+$/.test(rxcui))
    return { ...result, reason: "rxcui_not_in_rxnorm" };
  const rxnorm = createRxnormRepository(db);
  const concepts = await rxnorm.conceptByRxcui(rxcui);
  if (!concepts.length) {
    const stage = await askableStage(rxnorm, identity);
    if (!stage) return { ...result, reason: "rxcui_not_in_rxnorm" };
    const { verdict, evidence } = await confirmRxcui(stage, rxcui, year);
    if (verdict !== "confirmed") return { ...result, reason: verdict };
    // The answer rests on the source's confirmation, so it carries the source's attribution
    // (for RxNav, NLM's acknowledgement statement) whatever the coverage step finds.
    if (evidence) result.rxnorm_identity = evidence;
  } else if (!concepts.some((c) => c.suppress === "N"))
    return { ...result, reason: "rxcui_suppressed" };
  const plan = (
    await db.query<
      { issuer_id: string; state: string; snapshot_id: string } & PlanLinkCells
    >(
      `SELECT p.issuer_id,p.state,p.snapshot_id,${PLAN_LINK_COLUMNS}
    FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id AND f.kind='plan-attributes'
    JOIN plan p ON p.snapshot_id=f.snapshot_id AND p.state=a.state AND p.plan_year=a.plan_year
    ${PLAN_LINK_JOINS}
    WHERE p.base_plan_id=$1 AND a.plan_year=$2`,
      [hios.base, year],
    )
  ).rows[0];
  if (!plan) return { ...result, reason: "plan_not_in_catalog" };
  read.plan = plan;
  if (
    hios.variant &&
    !(
      await db.query(
        `SELECT 1 FROM plan_variant WHERE snapshot_id=$1 AND variant_plan_id=$2`,
        [plan.snapshot_id, hios.full],
      )
    ).rows.length
  )
    return { ...result, reason: "variant_not_in_catalog" };
  const availability = (
    await drugAvailability(db, {
      issuer: plan.issuer_id,
      year,
      state: plan.state,
    })
  )[0];
  if (availability?.status === "access_denied")
    return {
      ...result,
      reason: "source_access_denied",
      manifest_snapshot_id: availability.snapshot_id,
    };
  // One SQL statement observes the active pointer and current manifest consistently during publication.
  const rows = (
    await db.query<
      DrugEvidence & {
        manifest_status: string;
        manifest_id: string;
        active_id: string;
      }
    >(
      `SELECT
    m.status AS manifest_status,m.snapshot_id AS manifest_id,a.snapshot_id AS active_id,
    e.*,s.source_set_id,s.raw_snapshot_id,p.source_id,p.final_url AS source_url
    FROM qhp_coverage_manifest m
    LEFT JOIN formulary_active_set a ON a.issuer_id=m.issuer_id AND a.plan_year=m.plan_year AND a.state=m.state
    LEFT JOIN formulary_shard s ON s.source_set_id=a.snapshot_id
    LEFT JOIN snapshot p ON p.snapshot_id=s.snapshot_id AND p.validation_state='ACTIVE'
    LEFT JOIN formulary_edge e ON e.snapshot_id=p.snapshot_id AND e.base_hios_id=$4 AND e.rxcui=$5 AND e.plan_year=$2
    WHERE m.issuer_id=$1 AND m.plan_year=$2 AND m.state=$3 AND m.kind='drug'
    ORDER BY s.snapshot_id,e.source_record,e.source_plan_index`,
      [plan.issuer_id, year, plan.state, hios.base, rxcui],
    )
  ).rows;
  const manifest = rows[0];
  if (!manifest) return { ...result, reason: "source_set_not_available" };
  result.snapshot_id = manifest.active_id ?? null;
  result.manifest_snapshot_id = manifest.manifest_id;
  const evidence = rows
    .filter((row) => row.drug_tier !== null && row.drug_tier !== undefined)
    .map((row) => ({
      drug_tier: row.drug_tier,
      tier_status: row.tier_status,
      cost_sharing: null,
      prior_authorization: row.prior_authorization,
      step_therapy: row.step_therapy,
      quantity_limit: row.quantity_limit,
      evidence_status: row.evidence_status,
      snapshot_id: row.snapshot_id,
      source_id: row.source_id,
      source_record: Number(row.source_record),
      source_plan_index: row.source_plan_index,
      source_set_id: row.source_set_id,
      raw_snapshot_id: row.raw_snapshot_id,
      source_url: row.source_url,
      source_updated_at: row.source_updated_at,
    }));
  const complete =
    availability?.status === "complete" &&
    manifest.manifest_status === "complete" &&
    manifest.manifest_id === manifest.active_id;
  const status = classifyDrugEvidence(evidence, complete);
  const flags = (
    key: "prior_authorization" | "step_therapy" | "quantity_limit",
  ) => evidence.map((row) => row[key]).find((value) => value !== null) ?? null;
  function coverageReason() {
    if (status === "unknown") {
      return "source_set_incomplete";
    } else if (status === "conflicting") {
      return "conflicting_source_records";
    } else {
      return null;
    }
  }
  return {
    ...result,
    status,
    reason: coverageReason(),
    evidence,
    ...(evidence.length && status !== "conflicting"
      ? {
          drug_tier: evidence[0]!.drug_tier,
          tier_status: evidence.every((e) => e.tier_status === "resolved")
            ? "resolved"
            : "unresolved",
          prior_authorization: flags("prior_authorization"),
          step_therapy: flags("step_therapy"),
          quantity_limit: flags("quantity_limit"),
        }
      : {}),
  };
}
