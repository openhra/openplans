import type { SqlSession } from "../../db/database.js";
import { drugIdentity } from "../../domain/drugs/repository.js";
import type { DrugIdentityStage } from "../../domain/drugs/repository.js";
import type { PassThroughEvidence } from "@openplans/plugin-sdk";
import { createRxnormRepository } from "../../ingest/rxnorm/repository.js";
import type { DrugConcept } from "../../ingest/rxnorm/repository.js";
import * as v from "../../api/validation.js";

/** Both spellings integrations send for an RxNorm id; either one is the drug identity. */
export const RXCUI_FIELDS = ["rxcui", "rx_cui_id"] as const;
const RXCUI_PATTERN = /^\d{1,20}$/;
/** Term types whose concept name is a brand name. */
const BRAND_TTYS = ["SBD", "BN", "BPCK"];

/**
 * The optional RxCUI of a query string or a `drug_packages` entry, under either accepted name. A
 * numeric string or a non-negative integer is accepted; two names that disagree are rejected.
 */
export function optionalRxcui(
  source: Record<string, unknown>,
  prefix: string,
): string | undefined {
  let found: string | undefined;
  for (const field of RXCUI_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    const text =
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : value;
    if (typeof text !== "string" || !RXCUI_PATTERN.test(text))
      return v.fail(`${prefix}${field}`);
    if (found !== undefined && found !== text)
      return v.fail(`${prefix}${field}`, "CONFLICTING_RXCUI");
    found = text;
  }
  return found;
}

export interface CompatDrugPackage {
  id: string;
  description: null;
  med_id: null;
  rx_cui_id: string;
}
/** One concept as a compatibility drug row with its published NDC packages (5-4-2). */
export function drugRow(concept: DrugConcept, ndcs: string[]) {
  const packageIds = ndcs.map(
    (ndc) => `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`,
  );
  const brand = BRAND_TTYS.includes(concept.tty);
  return {
    drug: {
      id: `rxnorm:${concept.rxcui}`,
      active_ingredient_strength: null,
      proprietary_name: brand ? concept.name : null,
      non_proprietary_name: brand ? null : concept.name,
      drug_package_ids: packageIds,
    },
    packages: packageIds.map((id): CompatDrugPackage => ({
      id,
      description: null,
      med_id: null,
      rx_cui_id: concept.rxcui,
    })),
  };
}

/**
 * The attribution a body carries when the identity source confirmed the RxCUI: the source's own
 * statement (for RxNav, NLM's acknowledgement) and terms link, never the raw evidence block.
 */
export function identityAttribution(evidence: PassThroughEvidence | undefined) {
  if (!evidence || typeof evidence.source !== "string") return undefined;
  return {
    source_id: evidence.source_id,
    source: evidence.source,
    terms_url: evidence.terms_url,
  };
}

/** Gap label when the identity source, not a local release, identified the RxCUI. */
export const RXCUI_CONFIRMED_UPSTREAM = "rxcui_identity_confirmed_upstream";

/**
 * The drug an RxCUI names, through the same identity step as the coverage routes. A loaded
 * release supplies the concept and its packages. Without one, an RxCUI the identity stage
 * confirmed is returned by id only: names and packages need the local release. Anything else
 * returns no drug and its reason; an RxCUI is never taken on trust.
 */
export async function drugByRxcui(
  db: SqlSession,
  rxcui: string,
  year: number,
  stage?: DrugIdentityStage,
) {
  const identity = await drugIdentity(db, rxcui, year, stage);
  if (identity.status === "release") {
    const concept = identity.concepts[0]!;
    const row = drugRow(
      concept,
      await createRxnormRepository(db).ndcsForRxcui(rxcui),
    );
    return {
      drugs: [row.drug],
      drug_packages: row.packages,
      gaps: [],
      attribution: undefined,
    };
  }
  if (identity.status !== "confirmed")
    return {
      drugs: [],
      drug_packages: [],
      gaps: [identity.status],
      attribution: undefined,
    };
  return {
    drugs: [
      {
        id: `rxnorm:${rxcui}`,
        active_ingredient_strength: null,
        proprietary_name: null,
        non_proprietary_name: null,
        drug_package_ids: [],
      },
    ],
    drug_packages: [],
    gaps: [RXCUI_CONFIRMED_UPSTREAM],
    attribution: identityAttribution(identity.evidence),
  };
}
