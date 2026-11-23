import { guardCatalogPlans } from "./catalog-policy.js";
import { cmsFallbackUnavailable } from "../config/cms-fallback.js";
import type { SqlSession } from "../db/database.js";
import { providerParticipation } from "../domain/providers/repository.js";
import { drugCoverage } from "../domain/drugs/repository.js";
import type { ProviderParticipation } from "../domain/providers/index.js";
import type { DrugCoverage } from "../domain/drugs/index.js";
import { cmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { passThrough } from "../plugins/sources/passthrough.js";
import { consultPassThrough } from "./upstream-disclosure.js";
import { identityStage } from "./drugs.js";
import type { CmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { loadConfig } from "../config/index.js";
import { linkOutFloor } from "../domain/link-outs.js";

export function quoteFallbackEnabled(): boolean {
  const { cmsFallback } = loadConfig();
  return (
    !cmsFallbackUnavailable() &&
    cmsFallback.quotes &&
    cmsFallback.enabled &&
    Boolean(cmsFallback.apiKey)
  );
}

export function quoteFallbackContext(
  db: SqlSession,
  client: string,
  writer: SqlSession = db,
) {
  return quoteFallbackEnabled()
    ? cmsFallbackContext(db, writer, { client })
    : undefined;
}

export interface QuoteCoverage {
  providers: ProviderParticipation[];
  drugs: DrugCoverage[];
}

/**
 * `cms` is the quote's pass-through scope. When present, drug identity goes through the identity
 * stage with that same scope, which `applyQuoteFallback` later passes to `apply("drug")`.
 */
export async function readQuoteCoverage(
  db: SqlSession,
  requestedId: string,
  npis: string[],
  rxcuis: string[],
  year: number,
  cms?: CmsFallbackContext,
): Promise<QuoteCoverage> {
  await guardCatalogPlans([requestedId], year);
  const providers = [],
    drugs = [];
  for (const code of npis)
    providers.push(await providerParticipation(db, requestedId, code, year));
  for (const code of rxcuis)
    drugs.push(
      await drugCoverage(db, requestedId, code, year, identityStage(cms)),
    );
  return { providers, drugs };
}

/** All plans and both kinds share the inbound request's call allowance. */
export async function applyQuoteFallback<T extends QuoteCoverage>(
  quotes: T[],
  cms?: CmsFallbackContext,
): Promise<T[]> {
  if (!quoteFallbackEnabled() || !cms) return quotes;
  // The pass-through core runs the CMS source registered while OPENPLANS_CMS_FALLBACK=on.
  const providers = await consultPassThrough(
    passThrough,
    "provider",
    quotes.flatMap((q) => q.providers),
    cms,
  );
  if (!quoteFallbackEnabled()) return quotes;
  const drugs = await consultPassThrough(
    passThrough,
    "drug",
    quotes.flatMap((q) => q.drugs),
    cms,
  );
  if (!quoteFallbackEnabled()) return quotes;
  function label<A extends ProviderParticipation | DrugCoverage>(answer: A): A {
    if (!answer.cms_api) return answer;
    let freshness: "fresh" | "stale" | "refetched" = "fresh";
    if (answer.cms_api.served_from === "live") freshness = "refetched";
    if (answer.cms_api.served_from === "absorbed_stale") freshness = "stale";
    return { ...answer, cms_api: { ...answer.cms_api, freshness } };
  }
  let providerIndex = 0,
    drugIndex = 0;
  // Answers a pass-through source filled leave without the links their unknown carried.
  return quotes.map((quote) => ({
    ...quote,
    providers: linkOutFloor(
      providers
        .slice(providerIndex, (providerIndex += quote.providers.length))
        .map(label),
    ),
    drugs: linkOutFloor(
      drugs.slice(drugIndex, (drugIndex += quote.drugs.length)).map(label),
    ),
  }));
}
