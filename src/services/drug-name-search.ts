import { DRUG_NAME_SEARCH_KIND } from "@openplans/plugin-sdk";
import type {
  CandidateAnswer,
  DrugNameCandidate,
  PassThroughApi,
  PassThroughEvidence,
  PassThroughScope,
} from "@openplans/plugin-sdk";
import { passThroughEvidence } from "../domain/drugs/repository.js";
import { consultPassThrough } from "./upstream-disclosure.js";

/** What a name-search source suggested: concepts to pick from, never coverage answers. */
export interface DrugNameSuggestions {
  candidates: DrugNameCandidate[];
  evidence: PassThroughEvidence;
}

/** Lower case, single spaces, no outer spaces: one upstream question per spelling. */
export const normalizeDrugName = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Asks the name-search pass-through (kind `drug-name-search`) for RxNorm concepts matching a drug
 * name. The caller asks only when no RxNorm release is ACTIVE; a loaded release always wins. It
 * goes through the host's disclosure: `passthrough=off` asks nothing, and a source that was asked
 * is named in `x-openplans-upstream`. Returns null when no source served the name.
 */
export async function suggestDrugNames(
  api: Pick<PassThroughApi, "apply">,
  name: string,
  scope: PassThroughScope,
): Promise<DrugNameSuggestions | null> {
  const asked: CandidateAnswer = {
    status: "unknown",
    reason: "rxnorm_terminology_unavailable",
    identity: normalizeDrugName(name),
    plan_year: new Date().getUTCFullYear(),
  };
  const [answer] = await consultPassThrough(
    api,
    DRUG_NAME_SEARCH_KIND,
    [asked],
    scope,
  );
  if (answer?.status !== "passthrough") return null;
  const evidence = passThroughEvidence(answer);
  if (!evidence || !Array.isArray(answer.candidates)) return null;
  return { candidates: answer.candidates, evidence };
}
