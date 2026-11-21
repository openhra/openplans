import {
  DRUG_IDENTITY_KIND,
  DRUG_NAME_SEARCH_KIND,
  MAX_CANDIDATES,
} from "@openplans/plugin-sdk";
import type {
  CandidateAnswer,
  DrugNameCandidate,
  IdentityAnswer,
  PassThroughApi,
  PassThroughScope,
  SqlSession,
} from "@openplans/plugin-sdk";

/** The source's evidence block, kept with a joined row: who answered, when, under which terms. */
export type LookupEvidence = Record<string, unknown>;

export type NameSearch =
  | {
      status: "answered";
      candidates: DrugNameCandidate[];
      evidence: LookupEvidence;
    }
  | { status: "unavailable"; reason: string };
export type Confirmation =
  | { status: "confirmed" | "not_confirmed"; evidence: LookupEvidence }
  | { status: "unavailable"; reason: string };

/**
 * What the RxCUI join asks the drug identity stage. `unavailable` (switched off, budget spent,
 * outage) stops the run without recording anything, so the next run asks again.
 */
export interface IdentityLookup {
  /** The `identity_source` recorded on rows this lookup resolves. */
  readonly sourceId: string;
  /** False for a local lookup that needs no wait between calls; defaults to true. */
  readonly paced?: boolean;
  /** `termType` is the term type the row needs (`SCD` or `SBD`); a lookup may narrow by it. */
  searchName(query: string, termType?: string): Promise<NameSearch>;
  confirm(rxcui: string): Promise<Confirmation>;
}

/** The `identity_source` of rows confirmed through the pass-through identity stage (RxNav). */
export const PASSTHROUGH_IDENTITY_SOURCE = "rxnav";
/** The `identity_source` of rows matched and confirmed against the ACTIVE RxNorm release. */
export const RELEASE_IDENTITY_SOURCE = "rxnorm-release";

/** The identity source's evidence block on a pass-through answer, with its `source_id`. */
function evidenceOf(answer: object): LookupEvidence | null {
  for (const value of Object.values(answer))
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).source_id === "string" &&
      typeof (value as Record<string, unknown>).served_from === "string"
    )
      return value as LookupEvidence;
  return null;
}

/** The reason the pass-through core gives a source that answered but did not confirm. */
const NOT_CONFIRMED = "passthrough_identity_not_confirmed";
/** The question both kinds open on: no local RxNorm release is ACTIVE. */
const OPENING_REASON = "rxnorm_terminology_unavailable";

/**
 * The identity stage through the host's pass-through core: `drug-name-search` for candidates,
 * then `drug-identity` (RxNav `properties.json`) to confirm the one RxCUI a row matched. An answer
 * the core did not fill (no source registered, `passthrough=off`, budget or outage) is
 * `unavailable`.
 */
export function passThroughIdentityLookup(
  api: Pick<PassThroughApi, "apply">,
  scope: () => PassThroughScope,
  planYear: number,
): IdentityLookup {
  return {
    sourceId: PASSTHROUGH_IDENTITY_SOURCE,
    async searchName(query) {
      const asked: CandidateAnswer = {
        status: "unknown",
        reason: OPENING_REASON,
        identity: query,
        plan_year: planYear,
      };
      const [answer] = await api.apply(DRUG_NAME_SEARCH_KIND, [asked], scope());
      const evidence = answer && evidenceOf(answer);
      if (
        answer?.status !== "passthrough" ||
        !evidence ||
        !Array.isArray(answer.candidates)
      )
        return { status: "unavailable", reason: answer?.reason ?? "no_answer" };
      return { status: "answered", candidates: answer.candidates, evidence };
    },
    async confirm(rxcui) {
      const asked: IdentityAnswer = {
        status: "unknown",
        reason: OPENING_REASON,
        identity: rxcui,
        plan_year: planYear,
      };
      const [answer] = await api.apply(DRUG_IDENTITY_KIND, [asked], scope());
      const evidence = answer && evidenceOf(answer);
      if (answer?.status === "confirmed" && evidence)
        return { status: "confirmed", evidence };
      if (answer?.reason === NOT_CONFIRMED && evidence)
        return { status: "not_confirmed", evidence };
      return { status: "unavailable", reason: answer?.reason ?? "no_answer" };
    },
  };
}

/** The newest ACTIVE RxNorm release, as the core's drug identity step picks it; null without one. */
export async function activeRxnormRelease(
  db: SqlSession,
): Promise<{ snapshot_id: string; source_version: string } | null> {
  const { rows } = await db.query<{
    snapshot_id: string;
    source_version: string;
  }>(
    `SELECT r.snapshot_id, r.source_version::text AS source_version
     FROM rx_release r JOIN snapshot s USING (snapshot_id)
     WHERE s.validation_state = 'ACTIVE' ORDER BY r.source_version DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * The identity stage against a loaded RxNorm release: the name search lists the release's current
 * concepts of the row's term type whose name contains the query, and confirmation checks that the
 * RxCUI is a current concept of the release. Nothing leaves the database, so no pacing is needed.
 * The evidence names the release snapshot and version. The candidate list keeps the same cut as
 * the pass-through search (`MAX_CANDIDATES`), so a longer list stays `candidate_list_truncated`.
 */
export function releaseIdentityLookup(
  db: SqlSession,
  release: { snapshot_id: string; source_version: string },
  now: () => Date = () => new Date(),
): IdentityLookup {
  const evidence = (): LookupEvidence => ({
    source_id: RELEASE_IDENTITY_SOURCE,
    served_from: "release",
    snapshot_id: release.snapshot_id,
    source_version: release.source_version,
    retrieved_at: now().toISOString(),
  });
  return {
    sourceId: RELEASE_IDENTITY_SOURCE,
    paced: false,
    async searchName(query, termType) {
      const { rows } = await db.query<
        DrugNameCandidate & Record<string, unknown>
      >(
        `SELECT DISTINCT rxcui, name, tty FROM rx_concept
         WHERE snapshot_id = $1 AND suppress = 'N' AND tty = ANY($2::text[])
           AND strpos(lower(name), lower($3)) > 0
         ORDER BY rxcui, tty, name LIMIT $4`,
        [
          release.snapshot_id,
          termType ? [termType] : ["SCD", "SBD"],
          query,
          MAX_CANDIDATES,
        ],
      );
      return {
        status: "answered",
        candidates: rows.map(({ rxcui, name, tty }) => ({ rxcui, name, tty })),
        evidence: evidence(),
      };
    },
    async confirm(rxcui) {
      const { rows } = await db.query(
        `SELECT 1 FROM rx_concept WHERE snapshot_id = $1 AND rxcui = $2 AND suppress = 'N' LIMIT 1`,
        [release.snapshot_id, rxcui],
      );
      return {
        status: rows.length ? "confirmed" : "not_confirmed",
        evidence: evidence(),
      };
    },
  };
}
