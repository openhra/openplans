import {
  sbeAvailabilitySources,
  availabilityGeography,
  availabilityRateEvidence,
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

/** Imported rate evidence and supported rating policy are separate requirements. */
export async function dataAvailability(
  db: SqlSession,
): Promise<Record<string, unknown>[]> {
  const manifest = await coverageManifest(db);
  const drugs = await drugAvailability(db);
  const providers = await providerAvailability(db);
  const sbe = (await sbeAvailabilitySources(db)).rows;
  const geography = (await availabilityGeography(db)).rows;
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
    const { rows } = await availabilityRateEvidence(db, entry);
    const evidence = rows[0];
    if (!evidence) return result;
    const rule = await ratingRule(
      db,
      entry.state,
      entry.plan_year,
      entry.market,
    );
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
  for (const scope of scopes) {
    const rows = await stateCatalog(db, scope.plan_year, scope.state);
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
        state: scope.state,
        plan_year: scope.plan_year,
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
        on_exchange: scope.state === "NY" ? "unknown" : true,
        enrollment_eligibility: "unknown",
        subsidy_status: "requires_state_rules",
        rating_area_geography: stateRatingArea(
          scope.state,
          scope.plan_year,
          scope.state === "NY" ? "36061" : "50007",
        ),
        provenance: {
          publication_snapshot_ids: [
            ...new Set(rates.map((r) => r.publication_snapshot_id)),
          ],
        },
      });
    }
  }
  return combined.map((entry) => {
    const source = sbe.find((s) => s.import_id === entry.snapshot_id);
    if (!source) return entry;
    const gap = { status: "unknown", reason: "sbe_no_index_registry" };
    return {
      ...entry,
      source: "cms_sbe_puf",
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
}
