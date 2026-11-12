import {
  sbeAvailabilitySources,
  availabilityGeography,
  availabilityRateEvidence,
  countedRateEvidence,
  activeStateScopes,
} from "../api/repository.js";
import {
  catalogRule,
  stateCatalog,
  stateRatingArea,
} from "../ingest/state/catalog.js";
import { providerAvailability } from "../domain/providers/availability.js";
import { drugAvailability } from "../domain/drugs/availability.js";
import { coverageManifest } from "../db/availability.js";
import type { SqlSession } from "../db/database.js";
import { ratingRule } from "../ingest/rating-rules/index.js";
import { federalCatalog } from "../api/repository.js";
import { ichraParameters } from "../domain/ichra/index.js";
import { CMS_API_SOURCE } from "../ingest/cms-api/fallback.js";
import type { CmsApiAvailability } from "../ingest/cms-api/fallback.js";
import { passThrough } from "../plugins/sources/passthrough.js";

import { nyLcspAvailability, vtLcspAvailability } from "./ichra.js";

const ICHRA_STATE_RULES = new Set(["NY", "VT"]);
/**
 * ICHRA fields for one availability row. `available` means the gross-premium LCSP can be computed:
 * premiums and the year's catalog and parameters are available. State catalogs also need
 * complete candidate evidence. The EHB-portion figure can still be unknown.
 */
async function ichraAvailability(
  entry: Record<string, unknown>,
  loaded: (state: string, year: number) => Promise<boolean>,
  filed: (state: string, year: number) => ReturnType<typeof nyLcspAvailability>,
) {
  const state = String(entry.state),
    year = Number(entry.plan_year);
  const parameters = ichraParameters(year);
  const rules =
    parameters.status === "confirmed"
      ? {
          affordability: parameters.parameters.rules.affordability.status,
          employer_safe_harbors:
            parameters.parameters.rules.employer_safe_harbors.status,
        }
      : null;
  let status: string, reason: string | null;
  if (ICHRA_STATE_RULES.has(state)) {
    if (year === 2026) {
      ({ status, reason } = await filed(state, year));
    } else {
      status = "unknown";
      reason = "catalog_not_loaded";
    }
  } else if (!rules) {
    status = "unknown";
    reason = "parameters_unconfirmed";
  } else if (entry.premium_status === "unsupported") {
    status = "unsupported";
    reason = "rating_method_unsupported";
  } else if (entry.premium_status !== "available") {
    status = "unknown";
    reason = "premium_not_available";
  } else if (!(await loaded(state, year))) {
    status = "unknown";
    reason = "catalog_not_loaded";
  } else {
    status = "available";
    reason = null;
  }
  return {
    ichra_status: status,
    ichra_reason: reason,
    ichra_lookback_status:
      !ICHRA_STATE_RULES.has(state) &&
      status === "available" &&
      (await loaded(state, year - 1))
        ? "available"
        : "unknown",
    ichra_rules: rules,
    ...(ICHRA_STATE_RULES.has(state)
      ? {
          ichra_documentation: "docs/ichra.md#new-york-and-vermont",
          ichra_lookback_reason: "catalog_not_loaded",
        }
      : {}),
  };
}

/** Imported rate evidence and supported rating policy are separate requirements. */
export async function dataAvailability(
  db: SqlSession,
  scope?: { state: string; year: number; issuers?: ReadonlySet<string> },
): Promise<Record<string, unknown>[]> {
  const inScope = (entry: Record<string, unknown>) =>
    !scope ||
    (entry.state === scope.state &&
      entry.plan_year === scope.year &&
      (!scope.issuers?.size || scope.issuers.has(entry.issuer_id as string)));
  // Quote availability must not rate-check every catalog in a national import.
  const manifest = (await coverageManifest(db)).filter(inScope);
  const drugs = (await drugAvailability(db)).filter(inScope);
  const providers = (await providerAvailability(db)).filter(inScope);
  const sbe = (await sbeAvailabilitySources(db)).rows;
  const geography = (await availabilityGeography(db)).rows;
  // One statement reads the kept per-plan counts for every rated entry. An entry whose rate
  // file has none is counted from the rate rows, one query per entry, as before.
  const rated = manifest.filter(
    (entry) => entry.catalog_status === "available",
  );
  const counted = new Map<
    (typeof manifest)[number],
    Awaited<ReturnType<typeof countedRateEvidence>>["rows"][number]
  >();
  if (rated.length)
    for (const row of (await countedRateEvidence(db, rated)).rows)
      counted.set(rated[row.at - 1]!, row);
  const rules = new Map<string, ReturnType<typeof ratingRule>>();
  const rateRule = (state: string, year: number, market: string) => {
    const key = JSON.stringify([state, year, market]);
    if (!rules.has(key)) rules.set(key, ratingRule(db, state, year, market));
    return rules.get(key)!;
  };
  const entryAvailability = async (entry: (typeof manifest)[number]) => {
    const drug = drugs.find(
      (d) =>
        d.issuer_id === entry.issuer_id &&
        d.plan_year === entry.plan_year &&
        d.state === entry.state,
    );
    const result = {
      ...entry,
      drug_coverage: drug ?? {
        status: "unknown",
        reason: "source_set_not_available",
      },
      drug_status: drug?.status ?? "unknown",
    };
    if (drug && drug.status !== "complete") result.formulary_status = "unknown";
    for (const key of [
      "catalog_status",
      "premium_status",
      "provider_status",
      "formulary_status",
    ] as const) {
      if (result[key] === "not_yet_verified") result[key] = "unknown";
    }
    if (entry.catalog_status !== "available") return result;
    const kept = counted.get(entry);
    const evidence = kept?.counted
      ? kept
      : kept && (await availabilityRateEvidence(db, entry)).rows[0];
    if (!evidence) return result;
    const rule = await rateRule(entry.state, entry.plan_year, entry.market);
    const geo = geography.find(
      (g) => g.state === entry.state && g.plan_year === entry.plan_year,
    );
    const hasGeography =
      geo !== undefined && geo.county_areas + geo.zip3_areas > 0;
    if (rule?.method === "per_member" && evidence.medical_plans > 0) {
      if (evidence.rate_rows > 0 && hasGeography) {
        result.premium_status = "available";
      } else {
        result.premium_status = "unknown";
      }
    } else {
      result.premium_status = "unsupported";
    }
    return {
      ...result,
      rate_snapshot_id: evidence.snapshot_id,
      rate_rows: evidence.rate_rows,
      rating_area_geography: geo
        ? { county_areas: geo.county_areas, zip3_areas: geo.zip3_areas }
        : null,
      ...(result.premium_status === "unknown" && !hasGeography
        ? { premium_reason: "UNRESOLVED_RATING_AREA" }
        : {}),
      rating_rule_snapshot_id: rule?.snapshot_id ?? null,
    };
  };
  const entries: Awaited<ReturnType<typeof entryAvailability>>[] = [];
  // Bound work below the five-connection pool limit. A national manifest must not
  // enqueue hundreds of acquisitions against its two-second checkout timeout.
  for (let at = 0; at < manifest.length; at += 4) {
    entries.push(
      ...(await Promise.all(manifest.slice(at, at + 4).map(entryAvailability))),
    );
  }
  // Only with the CMS API fallback on: how many stored API answers each entry has.
  const cms = (await passThrough.availability(CMS_API_SOURCE, db)) as {
    configured: boolean;
    byIssuer: Map<string, CmsApiAvailability>;
  } | null;
  if (cms)
    for (const entry of entries)
      (entry as Record<string, unknown>).cms_api = cms.byIssuer.get(
        `${entry.issuer_id}|${entry.state}|${entry.plan_year}`,
      ) ?? {
        configured: cms.configured,
        absorbed_rows: 0,
        last_absorbed_at: null,
      };
  // Discovery has issuer/year evidence even when catalog data has not been imported.
  const additional = drugs
    .filter(
      (drug) =>
        !manifest.some(
          (e) =>
            e.issuer_id === drug.issuer_id &&
            e.plan_year === drug.plan_year &&
            e.state === drug.state,
        ),
    )
    .map((drug) => ({
      state: drug.state,
      plan_year: drug.plan_year,
      market: null,
      issuer_id: drug.issuer_id,
      catalog_status: "unknown",
      premium_status: "unknown",
      provider_status: "unknown",
      formulary_status: drug.status === "complete" ? "available" : "unknown",
      snapshot_id: drug.snapshot_id,
      drug_coverage: drug,
      drug_status: drug.status,
    }));
  const combined: Record<string, unknown>[] = [...entries, ...additional].map(
    (entry) => {
      const provider = providers.find(
        (p) =>
          p.issuer_id === entry.issuer_id &&
          p.plan_year === entry.plan_year &&
          p.state === entry.state,
      );
      return provider
        ? {
            ...entry,
            provider_coverage: provider,
            provider_status:
              provider.status === "complete" ? "available" : "unknown",
          }
        : entry;
    },
  );
  for (const provider of providers)
    if (
      !combined.some(
        (e) =>
          e.issuer_id === provider.issuer_id &&
          e.plan_year === provider.plan_year &&
          e.state === provider.state,
      )
    )
      combined.push({
        state: provider.state,
        plan_year: provider.plan_year,
        market: null,
        issuer_id: provider.issuer_id,
        catalog_status: "unknown",
        premium_status: "unknown",
        provider_status:
          provider.status === "complete" ? "available" : "unknown",
        formulary_status: "unknown",
        snapshot_id: provider.snapshot_id,
        drug_coverage: {
          status: "unknown",
          reason: "source_set_not_available",
        },
        drug_status: "unknown",
        provider_coverage: provider,
      });
  const scopes = (await activeStateScopes(db)).rows;
  for (const stateScope of scopes) {
    if (
      scope &&
      (stateScope.state !== scope.state || stateScope.plan_year !== scope.year)
    )
      continue;
    const rows = await stateCatalog(db, stateScope.plan_year, stateScope.state);
    for (const issuer of [...new Set(rows.map((r) => r.raw_record.issuer))]) {
      const rates = rows.filter((r) => r.raw_record.issuer === issuer);
      const supported = rates.every((r) => catalogRule(r) !== null);
      const counts = new Map<string, number>();
      for (const r of rates)
        counts.set(
          `${r.plan_key}:${r.region}`,
          (counts.get(`${r.plan_key}:${r.region}`) ?? 0) + 1,
        );
      combined.push({
        state: stateScope.state,
        plan_year: stateScope.plan_year,
        market: "Individual",
        issuer_id: issuer,
        catalog_status: "available",
        premium_status: supported ? "available" : "unsupported",
        premium_scope: "supported_subscriber_spouse_children_under_26",
        conflicting_plan_area_keys: [...counts.values()].filter((n) => n > 1)
          .length,
        provider_status: "unknown",
        formulary_status: "unknown",
        drug_status: "unknown",
        snapshot_id: rates[0]!.import_id,
        rate_rows: rates.length,
        medical_plans: new Set(rates.map((r) => r.plan_key)).size,
        rating_method: "community_family_tier",
        quote_method: "state_filed_tier",
        bindable_quote: false,
        on_exchange: stateScope.state === "NY" ? "unknown" : true,
        enrollment_eligibility: "unknown",
        subsidy_status: "requires_state_rules",
        rating_area_geography: stateRatingArea(
          stateScope.state,
          stateScope.plan_year,
          stateScope.state === "NY" ? "36061" : "50007",
        ),
        provenance: {
          publication_snapshot_ids: [
            ...new Set(rates.map((r) => r.publication_snapshot_id)),
          ],
        },
      });
    }
  }
  const catalogs = new Map<string, Promise<boolean>>();
  const loaded = (state: string, year: number) => {
    const key = `${state}:${year}`;
    if (!catalogs.has(key))
      catalogs.set(
        key,
        federalCatalog(db, state, year).then((r) => r.rows.length > 0),
      );
    return catalogs.get(key)!;
  };
  const withSources = combined.filter(inScope).map((entry) => {
    const source = sbe.find((s) => s.import_id === entry.snapshot_id);
    if (!source) return entry;
    const gap = { status: "unknown", reason: "sbe_no_index_registry" };
    return {
      ...entry,
      source: source.source,
      source_provenance: {
        bundle_url: source.bundle_url,
        sha256: source.bundle_sha256,
      },
      ...(entry.drug_status === "complete"
        ? {}
        : {
            drug_coverage: gap,
            drug_status: "unknown",
            formulary_status: "unknown",
          }),
      ...(entry.provider_status === "available"
        ? {}
        : { provider_coverage: gap, provider_status: "unknown" }),
      ...(entry.state === "CA" && entry.premium_status === "available"
        ? {
            premium_status: "partial",
            premium_reason:
              "COUNTY_SCOPED_ZIP3_CROSS_COUNTY_PREFIXES_AMBIGUOUS",
          }
        : {}),
      ...(entry.premium_status === "unsupported"
        ? { premium_reason: "STATE_OR_FILED_RATING_METHOD_UNSUPPORTED" }
        : {}),
    };
  });
  const readiness = new Map<string, ReturnType<typeof nyLcspAvailability>>();
  const filed = (state: string, year: number) => {
    const key = `${state}:${year}`;
    if (!readiness.has(key))
      readiness.set(
        key,
        state === "VT"
          ? vtLcspAvailability(db, year)
          : nyLcspAvailability(db, year),
      );
    return readiness.get(key)!;
  };
  const result = [];
  for (const entry of withSources)
    result.push({
      ...entry,
      ...(await ichraAvailability(entry, loaded, filed)),
    });
  return result;
}
