/** `source.source_id`, the evidence key and the `identity_source` value coverage sources report. */
export const RXNAV_SOURCE = "rxnav";
export const RXNAV_HOST = "rxnav.nlm.nih.gov";
/** The core registers this source while this variable is `on`; it is off by default. */
export const RXNAV_IDENTITY_ENV = "OPENPLANS_RXNAV_IDENTITY";
export const RXNAV_TERMS_URL =
  "https://www.lhncbc.nlm.nih.gov/RxNav/TermsofService.html";
export const RXNAV_PUBLISHER =
  "U.S. National Library of Medicine, RxNav (RxNorm API)";
/**
 * The statement NLM's terms of service ask every application that uses NLM data to include,
 * verbatim (RXNAV_TERMS_URL, "Your Own Apps").
 */
export const NLM_ACKNOWLEDGEMENT =
  "This product uses publicly available data from the U.S. National Library of Medicine (NLM), National Institutes of Health, Department of Health and Human Services; NLM is not responsible for the product and does not endorse or recommend this or any other product.";
export const RXNAV_LIMITS =
  "identity only: whether an RxCUI is a current, unsuppressed RxNorm concept; nothing about coverage, tier or cost";

export const NAME_SEARCH_LIMITS =
  "suggestions only: current RxNorm concepts whose names match, for picking an exact RxCUI; nothing about coverage, tier or cost";

/** The name search; the shipped manifest entry permits it. */
export const DRUGS_PATH = "/REST/drugs.json";
/**
 * Names the source looks up: 2 to 100 letters, digits, spaces and the punctuation drug names
 * use. Anything else is not asked.
 */
export const DRUG_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .,'/()+%&-]{1,99}$/u;

/** Path prefix of both per-RxCUI lookups; the shipped manifest entry permits it. */
export const RXCUI_PATH = "/REST/rxcui/";
export const propertiesPath = (rxcui: string) =>
  `${RXCUI_PATH}${rxcui}/properties.json`;
export const historyPath = (rxcui: string) =>
  `${RXCUI_PATH}${rxcui}/historystatus.json`;
/**
 * An RxCUI that is not a concept may come back as a 404 instead of a 200 with `{}`. Both mean
 * "not confirmed" (`rxcui_not_in_rxnorm`), not an outage (`rxnorm_terminology_unavailable`).
 */
export const ABSENT_STATUSES: readonly number[] = Object.freeze([404]);
/** RxCUIs are decimal integers; the per-RxCUI path takes one at a time. */
export const RXCUI_PATTERN = /^\d{1,10}$/;
/** RxNorm's suppress flag for a concept that is not suppressed. */
export const NOT_SUPPRESSED = "N";

/**
 * Identity is confirmed per request and kept in memory only, never in the database or backups
 * (D-PRX-2). NLM recommends caching results for 12 to 24 hours.
 */
export const RXNAV_CACHE = Object.freeze({
  level: "memory" as const,
  ttl: "24 hours",
  negativeTtl: "1 hour",
  maxEntries: 100_000,
});

/** NLM's published limit per IP address. The budget below stays far under it. */
export const NLM_REQUESTS_PER_SECOND = 20;
/**
 * The fetcher's pacing floor for a host without a key. Spacing calls this far apart refuses a
 * call that would otherwise wait on the host lease.
 */
export const HOST_FLOOR_MS = 5000;
export const RXNAV_BUDGET = Object.freeze({
  dailyMax: 5000,
  minIntervalMs: HOST_FLOOR_MS,
  clientShare: 0.1,
  breaker: Object.freeze({ failures: 3, windowMs: 300_000, pauseMs: 900_000 }),
});
