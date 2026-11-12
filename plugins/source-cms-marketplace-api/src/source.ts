import type {
  PassThroughAnswer,
  PassThroughResult,
  PassThroughSource,
  SqlSession,
} from "@openplans/plugin-sdk";
import {
  CLIENT_SHARE,
  CMS_API_ATTRIBUTION,
  CMS_API_HOST,
  CMS_API_KEY_ENV,
  CMS_API_SOURCE,
  CMS_API_TERMS_URL,
  MAX_CALLS_PER_REQUEST,
  MAX_IDS_PER_CALL,
  MAX_PLANS_PER_CALL,
  OPENING_REASONS,
  RECORD_POLICY,
  RECORD_POLICY_NO_DATA,
  SERVED_YEARS,
  limitsOf,
} from "./constants.js";
import type { CmsKind } from "./constants.js";
import { buildRequest, mapResponse } from "./response.js";
import type { CmsQuestion, CmsStatement } from "./response.js";
import { storage, storedCounts } from "./storage.js";

export interface CmsApiEvidence {
  coverage: string;
  generic_rxcui?: string | null;
  accepting?: string | null;
  snapshot_id: string;
  sourced_by: typeof CMS_API_SOURCE;
  sourced_at: string;
  sourced_slug: string;
  served_from: "live" | "absorbed" | "absorbed_stale";
  /** Quote provenance label, derived from served_from. */
  freshness?: "fresh" | "stale" | "refetched";
  source: string;
  terms_url: string;
  limits: string;
}

/** What the host knows that the plugin cannot read itself. */
export interface CmsSourceHost {
  /** The 14-character base plan id of a requested plan id; throws when it is not one. */
  planBase(requestedPlanId: string): string;
  /** RxCUIs that resolve to an unsuppressed concept in the active local RxNorm release. */
  knownRxcuis?(db: SqlSession, rxcuis: string[]): Promise<Set<string>>;
  /** Whether the API key is set. Never the key itself. */
  keyConfigured?(): boolean;
}

const defaultPlanBase = (id: string) => {
  const match = /^(\d{5}[A-Z]{2}\d{7})(?:-\d{2})?$/.exec(id);
  if (!match) throw new Error("Not a HIOS plan id");
  return match[1]!;
};

/** Folds a served CMS statement into the loaded-files answer (migration 970 semantics). */
function withEvidence<T extends PassThroughAnswer>(
  kind: string,
  answer: T,
  evidence: CmsApiEvidence,
  identityKnown: boolean,
): T {
  const covered = ["Covered", "GenericCovered"].includes(evidence.coverage);
  // CMS also returns NotCovered for identities it cannot resolve: unknown unless known locally.
  if (evidence.coverage === "NotCovered" && !identityKnown)
    return {
      ...answer,
      status: "unknown",
      reason: "cms_api_reports_not_covered",
      cms_api: evidence,
    };
  if (
    evidence.coverage === "DataNotProvided" ||
    !["Covered", "GenericCovered", "NotCovered"].includes(evidence.coverage)
  )
    return {
      ...answer,
      reason: "cms_api_data_not_provided",
      cms_api: evidence,
    };
  const statuses = {
    drug: ["listed_covered", "explicitly_not_covered"],
    provider: ["listed_participating", "explicitly_not_participating"],
  } as const;
  const status = statuses[kind as CmsKind][covered ? 0 : 1];
  return { ...answer, status, reason: null, covered, cms_api: evidence };
}

function serve<T extends PassThroughAnswer>(
  kind: string,
  answer: T,
  result: PassThroughResult<CmsStatement>,
): T {
  const said = result.answer!;
  const evidence: CmsApiEvidence = {
    coverage: said.coverage,
    ...(kind === "drug"
      ? { generic_rxcui: said.generic_rxcui ?? null }
      : { accepting: said.accepting ?? null }),
    snapshot_id: result.snapshotId!,
    sourced_by: CMS_API_SOURCE,
    sourced_at: result.sourcedAt,
    sourced_slug: said.sourced_slug!,
    served_from: result.servedFrom as CmsApiEvidence["served_from"],
    source: CMS_API_ATTRIBUTION,
    terms_url: CMS_API_TERMS_URL,
    limits: limitsOf(kind),
  };
  return withEvidence(kind, answer, evidence, result.confirmed);
}

/**
 * States and years whose active catalog comes from a state-based exchange bundle. The CMS API
 * answers only for plans sold through HealthCare.gov and rejects these, so no call is spent.
 */
async function notServed(
  db: SqlSession,
  questions: CmsQuestion[],
): Promise<(string | null)[]> {
  if (!questions.length) return [];
  const rows = (
    await db.query<{ state: string; plan_year: number }>(
      `SELECT a.state,a.plan_year FROM puf_active_catalog a
      JOIN sbe_catalog s ON s.import_id=a.import_id WHERE a.state=ANY($1::text[])`,
      [[...new Set(questions.map((q) => q.planId.slice(5, 7)))]],
    )
  ).rows;
  const exchange = new Set(rows.map((row) => `${row.state}|${row.plan_year}`));
  return questions.map((q) =>
    exchange.has(`${q.planId.slice(5, 7)}|${q.year}`)
      ? "cms_api_state_not_served"
      : null,
  );
}

interface LoadedAnswer extends PassThroughAnswer {
  requested_plan_id: string;
  plan_year: number;
  rxcui?: string;
  identity?: string;
}

/**
 * The CMS Marketplace API as a stored pass-through source: `drugs/covered` and
 * `providers/covered`, asked only about pairs that loaded files leave `unknown` for a "not sourced
 * yet" reason. Answers go to the `cms_api_*` tables, never to issuer or PUF tables.
 */
export function createCmsMarketplaceSource(
  host: Partial<CmsSourceHost> = {},
): PassThroughSource<CmsQuestion, CmsStatement> {
  const planBase = host.planBase ?? defaultPlanBase;
  const keyConfigured =
    host.keyConfigured ?? (() => Boolean(process.env[CMS_API_KEY_ENV]));
  return {
    kind: "passthrough",
    id: CMS_API_SOURCE,
    publisher: CMS_API_ATTRIBUTION,
    kinds: ["drug", "provider"],
    manifest: {
      host: CMS_API_HOST,
      accessMode: "api-key",
      apiKeyEnv: CMS_API_KEY_ENV,
      permittedPaths: ["/api/v1/drugs/covered", "/api/v1/providers/covered"],
      shippedOnly: true,
    },
    cache: {
      level: "stored",
      recordPolicy: { name: RECORD_POLICY, noDataName: RECORD_POLICY_NO_DATA },
    },
    eligibility: {
      openingReasons: OPENING_REASONS,
      years: SERVED_YEARS,
      accepts: (q) => q.kind === "drug" || /^\d{10}$/.test(q.identity),
      notServed,
    },
    question(kind, answer) {
      const loaded = answer as LoadedAnswer;
      return {
        kind: kind as CmsKind,
        planId: planBase(loaded.requested_plan_id),
        identity: (kind === "drug" ? loaded.rxcui : loaded.identity)!,
        year: loaded.plan_year,
      };
    },
    async confirmIdentities(db, kind, identities) {
      if (kind === "drug")
        return host.knownRxcuis
          ? host.knownRxcuis(db, identities)
          : new Set<string>();
      const rows = await db.query<{ npi: string }>(
        "SELECT npi FROM npi_provider WHERE npi=ANY($1::text[])",
        [identities],
      );
      return new Set(rows.rows.map((row) => row.npi));
    },
    batch: {
      maxQuestionsPerCall: MAX_PLANS_PER_CALL * MAX_IDS_PER_CALL,
      maxCallsPerRequest: MAX_CALLS_PER_REQUEST,
      grid: { maxPlans: MAX_PLANS_PER_CALL, maxIdentities: MAX_IDS_PER_CALL },
    },
    // Defaults only: the shared `cms_api_budget` row (storage.budget) holds the live values.
    budget: {
      dailyMax: 500,
      minIntervalMs: 1000,
      clientShare: CLIENT_SHARE,
      breaker: { failures: 3, windowMs: 300_000, pauseMs: 900_000 },
    },
    buildRequest,
    mapResponse,
    evidence: {
      key: "cms_api",
      source: CMS_API_ATTRIBUTION,
      termsUrl: CMS_API_TERMS_URL,
      limits: limitsOf,
    },
    storage,
    reasons: {
      passthrough_not_configured: "cms_api_not_configured",
      passthrough_year_not_served: "cms_api_year_not_served",
      passthrough_request_cap: "cms_api_request_cap",
      passthrough_client_share: "cms_api_client_share",
      passthrough_budget_exhausted: "cms_api_budget_exhausted",
      passthrough_unavailable: "cms_api_unavailable",
      // Read-only scopes (MCP tools) serve stored rows and otherwise leave the answer as it was.
      passthrough_not_available_read_only: null,
    },
    serve,
    availability: (db) => storedCounts(db, keyConfigured()),
  };
}
