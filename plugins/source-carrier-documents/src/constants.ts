/** The feed's `source.source_id`, fetch cache directory and snapshot id prefix. */
export const SOURCE_ID = "carrier-formulary-pdf";
/** The formulary feed kind; the SBC feed is `SBC_FEED_KIND`. */
export const FEED_KIND = "formulary-pdf";
export const PUBLISHER = "Issuer-published formulary documents";
export const FORMULARY_ARGV = Object.freeze([
  "ingest",
  "carrier-formulary",
] as const);
export const FORMULARY_USAGE =
  "Usage: worker ingest carrier-formulary --discovery URL [--discovery URL ...] --issuer ST:NNNNN [--issuer ST:NNNNN ...] --years YYYY[,YYYY...]";

/**
 * Hosts whose website terms and robots were reviewed for plan documents. Each must also be
 * `allowed` in the operator's admission manifest, or the run stops before `plan`.
 */
export const DOCUMENT_HOSTS = Object.freeze([
  "www.christushealthplan.org",
  "chppayment.christushealth.org",
] as const);

export const DISCOVERY_MAX_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
/** Discovery pages listing more documents than this are refused rather than read in part. */
export const MAX_DOCUMENTS = 40;

/** Only rows the extractor labelled `high` are served; everything else answers `unknown`. */
export const SERVED_CONFIDENCE = "high";

/**
 * The share of a document's rows that may print a tier the document never defines. Such rows are
 * kept as `unknown` (`UNKNOWN_REASON.tierNotDefined`) and never served as tier answers; above this
 * share the whole document is refused. A fixed policy, never tuned to let a document pass.
 */
export const MAX_UNDEFINED_TIER_SHARE = 0.1;

/** Reason codes, recorded by the core in `quality_issue` when a run is refused. */
export const REFUSAL = Object.freeze({
  empty: "formulary_empty",
  legendMissing: "formulary_legend_missing",
  histogram: "formulary_tier_histogram",
  quantityLimit: "formulary_ql_round_trip",
  yearUnresolved: "document_year_unresolved",
  yearOutsideRun: "document_year_outside_run",
  notStaged: "formulary_not_staged",
});

/** Reasons an evidence lookup answers `unknown`. */
export const UNKNOWN_REASON = Object.freeze({
  noDocument: "formulary_document_not_available",
  ambiguous: "plan_mapping_ambiguous",
  notOnCover: "plan_not_on_document_cover",
  lowConfidence: "pdf_low_confidence",
  notListed: "name_not_found_in_document",
  tierNotDefined: "tier_not_defined_in_document",
});

/** The RxCUI join's worker command: an ingest-time batch, never run while answering a request. */
export const IDENTITY_JOIN_ARGV = Object.freeze([
  "ingest",
  "carrier-formulary-identity",
] as const);
export const IDENTITY_JOIN_USAGE =
  "Usage: worker ingest carrier-formulary-identity [--max-lookups N]";
/**
 * Live identity lookups (name searches plus confirmations) one join run may make. RxNav's budget is
 * 5,000 calls a day, shared with the identity questions requests ask, so a run takes a fifth of it;
 * at one call per `IDENTITY_JOIN_PACING_MS` it lasts about 85 minutes. A formulary of about 3,500
 * rows needs a few runs; each run resumes where the last one stopped.
 */
export const IDENTITY_JOIN_DEFAULT_LOOKUPS = 1000;
export const IDENTITY_JOIN_MAX_LOOKUPS = 5000;
/** The wait before every live lookup: RxNav's pacing floor for a client without a key. */
export const IDENTITY_JOIN_PACING_MS = 5000;
/** A row's identity found by an earlier run for the same printed name is reused for this long. */
export const IDENTITY_REUSE_DAYS = 30;
/**
 * A resolved row answers coverage only while its RxCUI was confirmed within this many days; an
 * older confirmation answers `unknown` (`identity_confirmation_stale`). NLM asks applications that
 * keep RxNav data to refresh it regularly, so stored identities are confirmed again monthly.
 */
export const IDENTITY_CONFIRMATION_MAX_AGE_DAYS = 35;
/**
 * Each join run first confirms again every resolved row confirmed longer ago than this, before it
 * joins new rows. A monthly run keeps every served row under `IDENTITY_CONFIRMATION_MAX_AGE_DAYS`.
 */
export const IDENTITY_REFRESH_AGE_DAYS = 30;

/** Reasons a drug coverage answer from a formulary document is `unknown`. */
export const COVERAGE_UNKNOWN_REASON = Object.freeze({
  joinOff: "identity_join_off",
  identityUnresolved: "identity_unresolved",
  rowsConflict: "document_rows_conflict",
  identityStale: "identity_confirmation_stale",
});

/** The SBC feed's `source.source_id`, fetch cache directory and snapshot id prefix. */
export const SBC_SOURCE_ID = "carrier-sbc-pdf";
export const SBC_FEED_KIND = "sbc-pdf";
export const SBC_PUBLISHER =
  "Issuer-published Summary of Benefits and Coverage documents";
export const SBC_ARGV = Object.freeze(["ingest", "carrier-sbc"] as const);
export const SBC_USAGE =
  "Usage: worker ingest carrier-sbc --discovery URL [--discovery URL ...] --issuer ST:NNNNN [--issuer ST:NNNNN ...] --years YYYY[,YYYY...]";
/** An issuer publishes one SBC per plan variant; a page listing more than this is refused. */
export const SBC_MAX_DOCUMENTS = 120;
export const SBC_MAX_BYTES = 16 * 1024 * 1024;
/** What every value served from an SBC says it is. */
export const SBC_SOURCE_LABEL = "sbc_document";

/** Reason codes for a refused SBC document, recorded by the core in `quality_issue`. */
export const SBC_REFUSAL = Object.freeze({
  empty: "sbc_chart_empty",
  periodUnresolved: "sbc_coverage_period_unresolved",
  /** The printed coverage period's year differs from the year the link names, or is outside the run. */
  periodMismatch: "sbc_coverage_period_mismatch",
  notStaged: "sbc_not_staged",
});

/** Reasons an SBC answer, or one item of it, is `unknown`. */
export const SBC_UNKNOWN_REASON = Object.freeze({
  noDocument: "sbc_document_not_available",
  ambiguous: "plan_mapping_ambiguous",
  notMapped: "plan_not_mapped_to_document",
  variantRequired: "plan_variant_required",
  lowConfidence: "pdf_low_confidence",
  /** The plan has federal cost-sharing rows, so a row they do not cover is not filled from the SBC. */
  pufCoversPlan: "puf_has_cost_sharing",
});
