/** `source.source_id`, `sourced_by` of every stored answer, and the raw cache prefix. */
export const CMS_API_SOURCE = "cms-marketplace-api";
export const CMS_API_HOST = "marketplace.api.healthcare.gov";
export const CMS_API_KEY_ENV = "CMS_API_KEY";
export const CMS_API_TERMS_URL = "https://developer.cms.gov/marketplace-api/";
export const CMS_API_ATTRIBUTION =
  "Centers for Medicare & Medicaid Services, Marketplace API (HealthCare.gov)";
/** Reasons that mean OpenPlans has not sourced the issuer's files; nothing else opens a call. */
export const OPENING_REASONS: readonly string[] = [
  "source_set_not_available",
  "source_access_denied",
  "source_set_not_validated",
  "source_set_not_active",
];
/** Plan years the reviewed manifest entry covers. */
export const SERVED_YEARS = [2025, 2026, 2027];
export const MAX_PLANS_PER_CALL = 10;
export const MAX_IDS_PER_CALL = 10;
export const MAX_CALLS_PER_REQUEST = 2;
/** Share of the daily allowance one inbound client may use. */
export const CLIENT_SHARE = 0.1;
/** Record policies from migration 992; operators change their intervals in `record_policy`. */
export const RECORD_POLICY = "cms_api_fallback";
export const RECORD_POLICY_NO_DATA = "cms_api_fallback_no_data";

/**
 * Tables whose rows come from the CMS Marketplace API or describe calls to it. The backup
 * commands in docs/self-host.md leave their data out, so a dump never carries API answers.
 * Receipts in `snapshot` stay. They hold a hash and a redacted URL, not the answer.
 */
export const CMS_API_EXPORT_EXCLUDED_TABLES: readonly string[] = [
  "cms_api_attempt",
  "cms_api_conflict",
  "cms_api_drug_coverage",
  "cms_api_provider_coverage",
  "cms_zip_attempt",
  "cms_zip_lookup",
];
/** Raw response bodies under the data directory that the backup archive leaves out. */
export const CMS_API_EXPORT_EXCLUDED_RAW = "raw/cms-marketplace-*";

export type CmsKind = "drug" | "provider";
export type Endpoint = "drugs/covered" | "providers/covered";
export const endpointOf = (kind: string): Endpoint =>
  kind === "drug" ? "drugs/covered" : "providers/covered";
export const limitsOf = (kind: string) =>
  kind === "drug"
    ? "coverage flag only; tier, prior authorization, step therapy, quantity limit and cost are not published by this source"
    : "coverage flag only; network tier and address participation are not published by this source";
