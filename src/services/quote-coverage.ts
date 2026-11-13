import type { SqlSession } from "../db/database.js";
import { providerParticipation } from "../domain/providers/repository.js";
import { drugCoverage } from "../domain/drugs/repository.js";
import type { ProviderParticipation } from "../domain/providers/index.js";
import type { DrugCoverage } from "../domain/drugs/index.js";
import { cmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { passThrough } from "../plugins/sources/passthrough.js";
import type { CmsFallbackContext } from "../ingest/cms-api/fallback.js";
import { loadConfig } from "../config/index.js";

export function quoteFallbackEnabled(): boolean {
  const { cmsFallback } = loadConfig();
  return (
    cmsFallback.quotes && cmsFallback.enabled && Boolean(cmsFallback.apiKey)
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

export async function readQuoteCoverage(
  db: SqlSession,
  requestedId: string,
  npis: string[],
  rxcuis: string[],
  year: number,
): Promise<QuoteCoverage> {
  const providers = [],
    drugs = [];
  for (const code of npis)
    providers.push(await providerParticipation(db, requestedId, code, year));
  for (const code of rxcuis)
    drugs.push(await drugCoverage(db, requestedId, code, year));
  return { providers, drugs };
}

/** All plans and both kinds share the inbound request's call allowance. */
export async function applyQuoteFallback<T extends QuoteCoverage>(
  quotes: T[],
  cms?: CmsFallbackContext,
): Promise<T[]> {
  if (!quoteFallbackEnabled() || !cms) return quotes;
  // The pass-through core runs the CMS source registered while OPENPLANS_CMS_FALLBACK=on.
  const providers = await passThrough.apply(
    "provider",
    quotes.flatMap((q) => q.providers),
    cms,
  );
  const drugs = await passThrough.apply(
    "drug",
    quotes.flatMap((q) => q.drugs),
    cms,
  );
  function label<A extends ProviderParticipation | DrugCoverage>(answer: A): A {
    if (!answer.cms_api) return answer;
    let freshness: "fresh" | "stale" | "refetched" = "fresh";
    if (answer.cms_api.served_from === "live") freshness = "refetched";
    if (answer.cms_api.served_from === "absorbed_stale") freshness = "stale";
    return { ...answer, cms_api: { ...answer.cms_api, freshness } };
  }
  let providerIndex = 0,
    drugIndex = 0;
  return quotes.map((quote) => ({
    ...quote,
    providers: providers
      .slice(providerIndex, (providerIndex += quote.providers.length))
      .map(label),
    drugs: drugs.slice(drugIndex, (drugIndex += quote.drugs.length)).map(label),
  }));
}
