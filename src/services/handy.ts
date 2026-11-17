import { z } from "zod";
import { fail, premiumRequest } from "../api/validation.js";
import { canonical } from "../api/cache/index.js";
import type { ResponseCache } from "../api/cache/index.js";
import type { SqlSession } from "../db/database.js";
import type { LowestInput } from "../api/handy.js";
import {
  householdHandyInput,
  lowestInput,
  marketSummaryInput,
} from "../api/handy.js";
import {
  countyPlans,
  activeCatalog,
  countyState,
  resolveLocation,
  locationZipCounties,
  snapshots as planSnapshots,
} from "../api/repository.js";
import { requestReads } from "./request-reads.js";
import { familyOffer } from "./coverage-family.js";
import { ratePremium } from "./premiums.js";
import { dataGeneration } from "../api/cache/generation.js";
import {
  handyManifest,
  handyVersion,
  handySnapshots,
  handyScopeSnapshotIds,
  readLowestCell,
  digest,
} from "../db/handy-repository.js";
import {
  nyLcspCatalog,
  vtLcspCatalog,
  stateRatingArea,
  refusedTemplatePlans,
} from "../ingest/state/catalog.js";
import { vtMetalCatalogComplete } from "../ingest/state/vt-metal.js";

export class HandyDataChanged extends Error {}

/** Full enumeration; no quote-page limit and no EHB or dental benchmark adjustments. */
export async function enumerateLowest(
  db: SqlSession,
  input: LowestInput,
  manifest: string,
  scan?: { unknown: Record<string, unknown>[]; consumeOffer(): void },
) {
  const location = await resolveLocation(db, input, {
    allowCmsLive: false,
    year: input.year,
  });
  const base = {
    schema_version: "1" as const,
    status: "unknown" as string,
    reason: null as string | null,
    year: input.year,
    location,
    basis: {
      market: input.market,
      coverage: input.coverage,
      metal: input.metal,
      premium_basis: input.premium_basis,
      age: input.age,
      tobacco: input.tobacco,
      coverage_start: input.coverage_start!,
      market_segment: input.market_segment,
      selection_universe: "public_catalog",
      age_rating: "filed_age_cell" as string,
      rating_method: "per_member" as string,
      family_tier: null as string | null,
    },
    lowest: {
      plan_id: null as string | null,
      monthly_cents: null as number | null,
      tied_plan_count: null as number | null,
    },
    ties: [] as string[],
    candidate_count: null as number | null,
    completeness: { catalog: "unknown", rates: "unknown" },
    issues: [] as string[],
    provenance: {
      input_manifest: manifest,
      snapshots: [] as Record<string, unknown>[],
      candidates: [] as Record<string, unknown>[],
      excluded: [] as Record<string, unknown>[],
      evidence: [] as unknown[],
      offer_set: null as string | null,
      offered_plan_count: 0,
    },
    bindable_quote: false as const,
    subsidy_status: "not_evaluated" as const,
  };
  const evidenceRef = (value: unknown) => {
    const bytes = JSON.stringify(value);
    const found = base.provenance.evidence.findIndex(
      (entry) => JSON.stringify(entry) === bytes,
    );
    if (found >= 0) return found;
    base.provenance.evidence.push(value);
    return base.provenance.evidence.length - 1;
  };
  const refuse = (status: string, reason: string, issues: string[] = []) => ({
    ...base,
    status,
    reason,
    issues,
  });
  if (location.status !== "available" || !location.county)
    return refuse(
      location.status,
      location.status === "ambiguous"
        ? "location_ambiguous"
        : "zip_not_in_loaded_geography",
    );
  const state = countyState(location.county);
  if ((state === "NY" || state === "VT") && input.tobacco)
    return refuse("unknown", "unsupported_rating_method");
  if (!(await activeCatalog(db, input.year, state)).rows.length)
    return refuse("unknown", "catalog_not_loaded");
  base.completeness.catalog = "available";
  const scopeSnapshots = await handyScopeSnapshotIds(db, state, input.year);
  base.provenance.snapshots = await handySnapshots(db, scopeSnapshots, true);
  const reads = requestReads(db);
  const all = await reads.countyPlans(
    location.county,
    input.year,
    location.zip,
  );
  // Unknown classification can hide an eligible cheaper plan.
  if (
    state !== "NY" &&
    state !== "VT" &&
    all.some((p) => !p.metal || p.metal.toLowerCase() === "unknown")
  )
    return refuse("unknown", "metal_level_unknown");
  let stateEntries:
    | Awaited<ReturnType<typeof nyLcspCatalog>>
    | Awaited<ReturnType<typeof vtLcspCatalog>>
    | undefined;
  if (state === "NY" || state === "VT") {
    base.basis.age_rating = "none";
    base.basis.rating_method = "community_family_tier";
    base.basis.family_tier = "single";
    const area = stateRatingArea(state, input.year, location.county);
    if (!area) return refuse("unknown", "unsupported_rating_method");
    const refused = (
      await refusedTemplatePlans(db, state, input.year, area.rating_area_id)
    ).filter(
      (p) =>
        !(
          p.metals.length === 1 &&
          [
            "bronze",
            "expanded bronze",
            "gold",
            "platinum",
            "catastrophic",
          ].includes(p.metals[0]!)
        ),
    );
    if (refused.length)
      return refuse(
        "unknown",
        refused[0]!.reason,
        refused.map((r) => r.reason),
      );
    const entries =
      state === "NY"
        ? await nyLcspCatalog(db, input.year, area.rating_area_id)
        : await vtLcspCatalog(db, input.year, area.rating_area_id);
    if (state === "VT" && !vtMetalCatalogComplete(entries.map((e) => e.row)))
      return refuse("unknown", "metal_level_unknown");
    for (const entry of entries) {
      if ("off_exchange" in entry && entry.off_exchange) continue;
      const metals = new Set(
        entry.attributes.map((a) => a.metal.trim().toLowerCase()),
      );
      if (entry.filed_identity)
        metals.add(entry.filed_identity.metal.toLowerCase());
      if (entry.row.raw_record.metal)
        metals.add(entry.row.raw_record.metal.toLowerCase());
      if (metals.size !== 1) return refuse("unknown", "metal_level_unknown");
      if (!metals.has(input.metal)) continue;
      if (entry.filed_identity?.off_exchange) {
        if (entry.exchange_evidence)
          return refuse("unknown", "exchange_offering_conflict");
        continue;
      }
      if (!entry.exchange_evidence)
        return refuse("unknown", "exchange_offering_unverified");
    }
    stateEntries = entries;
    for (const plan of all) {
      const entry = entries.find((e) => e.row.plan_key === plan.base_plan_id);
      const metal = entry?.filed_identity?.metal ?? entry?.attributes[0]?.metal;
      if (metal) plan.metal = metal;
    }
  }
  const selectedMetal = (p: {
    metal: string;
    on_exchange: boolean;
    base_plan_id: string;
  }) =>
    p.metal.toLowerCase() === input.metal &&
    (stateEntries
      ? stateEntries.some(
          (e) =>
            e.row.plan_key === p.base_plan_id &&
            e.exchange_evidence &&
            !e.filed_identity?.off_exchange &&
            !("off_exchange" in e && e.off_exchange),
        )
      : p.on_exchange);
  if (!location.zip) {
    const restricted = (
      await reads.countyRows(location.county, input.year)
    ).some((p) => !p.dental_only && selectedMetal(p) && p.zip_restricted);
    if (restricted)
      return refuse("location_requires_zip", "zip_limited_service_area");
    if (
      all
        .filter(selectedMetal)
        .some(
          (p) =>
            (p.premium_availability as { reason?: string } | undefined)
              ?.reason === "UNRESOLVED_RATING_AREA",
        )
    )
      return refuse("location_requires_zip", "sub_county_rating_area");
  }
  const offered = all.filter(selectedMetal).sort((a, b) => {
    if (a.base_plan_id < b.base_plan_id) return -1;
    return Number(a.base_plan_id > b.base_plan_id);
  });
  base.provenance.offered_plan_count = offered.length;
  base.provenance.offer_set = digest(
    JSON.stringify(
      offered.map((p) => [p.base_plan_id, p.snapshot_id, p.source_row]),
    ),
  );
  if (!offered.length) {
    base.candidate_count = 0;
    base.completeness.rates = "complete";
    return refuse("no_plans", "no_matching_plans");
  }
  const request = premiumRequest({
    ...input,
    ...(offered[0]?.base_plan_id.includes(":")
      ? { plan_keys: [offered[0].base_plan_id] }
      : { plan_ids: [offered[0]!.base_plan_id] }),
    members: [
      { age: input.age, tobacco: input.tobacco, relationship: "subscriber" },
    ],
  });
  const rated: { id: string; cents: number }[] = [];
  const snapshots = new Set<string>(scopeSnapshots);
  reads.plan(offered);
  for (const plan of offered) {
    scan?.consumeOffer();
    const entry = stateEntries?.find(
      (e) => e.row.plan_key === plan.base_plan_id,
    );
    const attributes =
      entry?.attributes ?? (await reads.exchangeAttributes(plan)).rows;
    const eligible = familyOffer(attributes, input.age >= 21, input.age < 21);
    snapshots.add(plan.snapshot_id);
    for (const id of Object.values(await planSnapshots(reads.db, plan)))
      if (typeof id === "string") snapshots.add(id);
    if (eligible === false) {
      base.provenance.excluded.push({
        plan_id: plan.base_plan_id,
        reason: "coverage_family_ineligible",
        snapshot_id: plan.snapshot_id,
        attribute_rows: attributes.map((a) => a.source_row),
      });
      continue;
    }
    if (eligible === null && scan) {
      scan.unknown.push({
        plan_id: plan.base_plan_id,
        reason: "coverage_family_eligibility_unknown",
        snapshot_id: plan.snapshot_id,
        attribute_rows: attributes.map((a) => a.source_row),
      });
      continue;
    }
    if (eligible === null)
      return refuse("unknown", "coverage_family_eligibility_unknown", [
        plan.base_plan_id,
      ]);
    const { estimate } = await ratePremium(
      db,
      plan,
      plan.base_plan_id,
      request,
      location,
      reads,
    );
    if (
      estimate.status !== "rated" ||
      !("total_cents" in estimate) ||
      estimate.total_cents === undefined
    ) {
      base.completeness.rates = "incomplete";
      if (scan) {
        scan.unknown.push({
          plan_id: plan.base_plan_id,
          reason:
            estimate.status === "unsupported_rating_method"
              ? "unsupported_rating_method"
              : "rate_rows_missing",
          status: estimate.status,
          snapshot_id: plan.snapshot_id,
        });
        continue;
      }
      return refuse(
        "unknown",
        estimate.status === "unsupported_rating_method"
          ? "unsupported_rating_method"
          : "rate_rows_missing",
        [`${plan.base_plan_id}: ${estimate.status}`],
      );
    }
    rated.push({ id: plan.base_plan_id, cents: estimate.total_cents });
    snapshots.add(plan.snapshot_id);
    if (entry?.exchange_evidence?.snapshot_id)
      snapshots.add(entry.exchange_evidence.snapshot_id);
    if (
      "rating_area_provenance" in estimate &&
      "snapshot_id" in estimate.rating_area_provenance &&
      typeof estimate.rating_area_provenance.snapshot_id === "string"
    )
      snapshots.add(estimate.rating_area_provenance.snapshot_id);
    for (const id of Object.values(estimate.provenance.snapshot_ids))
      if (typeof id === "string") snapshots.add(id);
    const rule = estimate.provenance.rating_rule;
    if (rule && "snapshot_id" in rule && typeof rule.snapshot_id === "string")
      snapshots.add(rule.snapshot_id);
    for (const row of estimate.rate_rows_used) {
      if (
        "publication_snapshot_id" in row &&
        typeof row.publication_snapshot_id === "string"
      )
        snapshots.add(row.publication_snapshot_id);
    }
    const sourceRef = evidenceRef(estimate.provenance);
    const areaRef =
      "rating_area_provenance" in estimate
        ? evidenceRef(estimate.rating_area_provenance)
        : null;
    base.provenance.candidates.push({
      ...(scan ? { status: estimate.status, members: estimate.members } : {}),
      plan_id: plan.base_plan_id,
      monthly_cents: estimate.total_cents,
      catalog: { snapshot_id: plan.snapshot_id, source_row: plan.source_row },
      attribute_rows: attributes.map((a) => ({ source_row: a.source_row })),
      evidence_ref: sourceRef,
      rate_rows_used: estimate.rate_rows_used,
      rating_area_ref: areaRef,
      ...(entry ? { exchange_evidence: entry.exchange_evidence } : {}),
      ...("rule_trace" in estimate ? { rule_trace: estimate.rule_trace } : {}),
    });
  }
  base.provenance.snapshots = await handySnapshots(
    db,
    [...snapshots].sort(),
    true,
  );
  base.candidate_count = rated.length;
  if (scan?.unknown.length) {
    base.completeness.rates = "incomplete";
    return refuse("unknown", "incomplete_offer_cohort");
  }
  base.completeness.rates = "complete";
  if (!rated.length) return refuse("no_plans", "no_matching_plans");
  const minimum = Math.min(...rated.map((r) => r.cents));
  base.ties = rated.filter((r) => r.cents === minimum).map((r) => r.id);
  base.lowest = {
    plan_id: base.ties[0]!,
    monthly_cents: minimum,
    tied_plan_count: base.ties.length,
  };
  return { ...base, status: "calculated", reason: null };
}
export type LowestCell = Awaited<ReturnType<typeof enumerateLowest>>;
export function isLowestCell(value: unknown): value is LowestCell {
  if (!value || typeof value !== "object") return false;
  const cell = value as LowestCell;
  if (
    cell.schema_version !== "1" ||
    !cell.lowest ||
    !cell.basis ||
    !cell.location ||
    typeof cell.lowest !== "object" ||
    typeof cell.basis !== "object" ||
    typeof cell.location !== "object" ||
    typeof cell.provenance?.input_manifest !== "string" ||
    !Array.isArray(cell.ties) ||
    !Array.isArray(cell.provenance?.candidates) ||
    !Array.isArray(cell.provenance?.snapshots) ||
    !Array.isArray(cell.provenance?.excluded) ||
    !Array.isArray(cell.provenance?.evidence)
  )
    return false;
  if (
    cell.provenance.snapshots.some(
      (snapshot) =>
        !snapshot ||
        typeof snapshot !== "object" ||
        !("retrieved_at" in snapshot) ||
        typeof snapshot.retrieved_at !== "string",
    )
  )
    return false;
  if (cell.status === "no_plans")
    return cell.candidate_count === 0 && cell.lowest.monthly_cents === null;
  if (cell.status !== "calculated") return true;
  const candidates = cell.provenance.candidates;
  if (
    !candidates.length ||
    cell.candidate_count !== candidates.length ||
    candidates.length + cell.provenance.excluded.length !==
      cell.provenance.offered_plan_count ||
    !candidates.every(
      (c) =>
        Number.isSafeInteger(c.monthly_cents) &&
        Number(c.monthly_cents) >= 0 &&
        Array.isArray(c.rate_rows_used) &&
        c.rate_rows_used.length > 0 &&
        Number.isInteger(c.evidence_ref) &&
        cell.provenance.evidence[Number(c.evidence_ref)] &&
        Number.isInteger(c.rating_area_ref) &&
        cell.provenance.evidence[Number(c.rating_area_ref)] &&
        c.catalog,
    )
  )
    return false;
  const minimum = Math.min(...candidates.map((c) => Number(c.monthly_cents)));
  const ties = candidates
    .filter((c) => c.monthly_cents === minimum)
    .map((c) => c.plan_id);
  return (
    new Set(candidates.map((c) => c.plan_id)).size === candidates.length &&
    JSON.stringify(ties) === JSON.stringify(cell.ties) &&
    cell.lowest.monthly_cents === minimum &&
    cell.lowest.tied_plan_count === ties.length &&
    cell.lowest.plan_id === ties[0]
  );
}

/** Generation verification covers autocommit adapters too. A publication retries once. */
export async function lowestPremiums(
  db: SqlSession,
  value: unknown,
  options: {
    slow?: boolean;
    cache?: ResponseCache;
    evidencePage?: number;
  } = {},
) {
  const input = lowestInput(value);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { generation, manifest } = await handyVersion(db);
    const accepts = (value: unknown): value is LowestCell =>
      isLowestCell(value) &&
      value.provenance.input_manifest === manifest &&
      value.year === input.year &&
      value.location.zip === input.zip &&
      (!input.county || value.location.county === input.county) &&
      value.basis.age === input.age &&
      value.basis.coverage_start === input.coverage_start &&
      value.basis.metal === input.metal &&
      value.basis.tobacco === input.tobacco &&
      value.basis.premium_basis === input.premium_basis &&
      value.basis.market_segment === input.market_segment;
    const load = async () => {
      const cached = options.slow
        ? undefined
        : await readLowestCell(db, input, manifest);
      return accepts(cached)
        ? cached
        : await enumerateLowest(db, input, manifest);
    };
    const cell =
      options.cache && !options.slow
        ? await options.cache.lowest(
            { input, generation, manifest, accept: accepts },
            load,
          )
        : await load();
    const after = await handyVersion(db);
    if (after.generation !== generation || after.manifest !== manifest)
      continue;
    const start = (input.page - 1) * 50;
    const evidencePage = options.evidencePage ?? 1;
    const evidenceSize = 10;
    const evidenceStart = (evidencePage - 1) * evidenceSize;
    const candidates = cell.provenance.candidates.slice(
      evidenceStart,
      evidenceStart + evidenceSize,
    );
    const refs = [
      ...new Set(
        candidates
          .flatMap((candidate) => [
            candidate.evidence_ref,
            candidate.rating_area_ref,
          ])
          .filter((ref): ref is number => Number.isInteger(ref)),
      ),
    ].sort((a, b) => a - b);
    const evidence = refs.map((ref) => cell.provenance.evidence[ref]);
    const remap = new Map(refs.map((ref, index) => [ref, index]));
    return {
      ...cell,
      ties: cell.ties.slice(start, start + 50),
      provenance: {
        ...cell.provenance,
        candidates: candidates.map((candidate) => ({
          ...candidate,
          evidence_ref:
            typeof candidate.evidence_ref === "number"
              ? (remap.get(candidate.evidence_ref) ?? null)
              : null,
          rating_area_ref:
            typeof candidate.rating_area_ref === "number"
              ? (remap.get(candidate.rating_area_ref) ?? null)
              : null,
        })),
        excluded: cell.provenance.excluded.slice(
          evidenceStart,
          evidenceStart + evidenceSize,
        ),
        evidence,
      },
      page: input.page,
      page_size: 50,
      next_page: start + 50 < cell.ties.length ? input.page + 1 : null,
      evidence_page: evidencePage,
      evidence_page_size: evidenceSize,
      next_evidence_page:
        evidenceStart + evidenceSize <
        Math.max(
          cell.provenance.candidates.length,
          cell.provenance.excluded.length,
        )
          ? evidencePage + 1
          : null,
      evidence_total: cell.provenance.evidence.length,
      candidates_total: cell.provenance.candidates.length,
      data_generation: generation,
    };
  }
  throw new HandyDataChanged("DATA_CHANGED");
}

const MARKET_METALS = [
  "bronze",
  "expanded bronze",
  "silver",
  "gold",
  "platinum",
  "catastrophic",
] as const;

/** Complete base-plan counts, with optional gross ranges from the full rating enumerator. */
export async function getMarketSummary(db: SqlSession, value: unknown) {
  const input = marketSummaryInput(value);
  const generation = await dataGeneration(db);
  const location = await resolveLocation(db, input, {
    allowCmsLive: false,
    year: input.year,
  });
  const result = {
    schema_version: "1",
    status: "unknown" as
      | "unknown"
      | "calculated"
      | "partial"
      | "no_plans"
      | "ambiguous"
      | "location_requires_zip",
    reason: null as string | null,
    year: input.year,
    location,
    basis: {
      market: "individual",
      coverage: "medical",
      market_segment: input.market_segment,
      count_unit: "base_plan",
      premium_basis: input.age === undefined ? "not_requested" : "gross",
      ...(input.age === undefined
        ? {}
        : {
            age: input.age,
            tobacco: input.tobacco ?? false,
            coverage_start: input.coverage_start,
          }),
    },
    plan_count: null as number | null,
    carrier_count: null as number | null,
    by_metal: [] as Record<string, unknown>[],
    provenance: {
      availability_ref: "openplans://availability",
      missing_evidence: [] as string[],
      snapshots: [] as unknown[],
    },
    bindable_quote: false,
  };
  if (location.status !== "available" || !location.county) {
    result.status = location.status as typeof result.status;
    result.reason =
      location.status === "ambiguous"
        ? "location_ambiguous"
        : "zip_not_in_loaded_geography";
    result.provenance.missing_evidence.push("geography");
    return result;
  }
  const state = countyState(location.county);
  if (!(await activeCatalog(db, input.year, state)).rows.length) {
    result.reason = "catalog_not_loaded";
    result.provenance.missing_evidence.push("catalog");
    return result;
  }
  const reads = requestReads(db);
  const countyRows = await reads.countyRows(location.county, input.year);
  if (
    !location.zip &&
    countyRows.some((p) => !p.dental_only && p.on_exchange && p.zip_restricted)
  ) {
    result.status = "location_requires_zip";
    result.reason = "zip_limited_service_area";
    result.provenance.missing_evidence.push("zip");
    return result;
  }
  const catalog = await reads.countyPlans(
    location.county,
    input.year,
    location.zip,
  );
  const offers = new Map(
    catalog.filter((p) => p.on_exchange).map((p) => [p.base_plan_id, p]),
  );
  const plans = [...offers.values()].sort((a, b) =>
    a.base_plan_id.localeCompare(b.base_plan_id),
  );
  const scopedPlans = input.metal
    ? plans.filter((p) => p.metal.toLowerCase() === input.metal)
    : plans;
  const catalogSnapshots = [...new Set(plans.map((p) => p.snapshot_id))].sort();
  const sourceSnapshots = new Set(catalogSnapshots);
  const unknownMetal = scopedPlans.some(
    (p) =>
      !MARKET_METALS.includes(
        p.metal.toLowerCase() as (typeof MARKET_METALS)[number],
      ),
  );
  if (unknownMetal) {
    result.provenance.snapshots = await handySnapshots(
      db,
      catalogSnapshots,
      true,
    );
    result.reason = "metal_level_unknown";
    result.provenance.missing_evidence.push("metal_level");
    return result;
  }
  const groups = input.metal
    ? [input.metal]
    : MARKET_METALS.filter((metal): metal is LowestInput["metal"] =>
        ["bronze", "expanded bronze", "silver", "gold"].includes(metal),
      );
  const issuers = new Set(scopedPlans.map((p) => p.issuer_id).filter(Boolean));
  result.plan_count = scopedPlans.length;
  const issuerIdentityMissing = scopedPlans.some((p) => !p.issuer_id);
  result.carrier_count = issuerIdentityMissing ? null : issuers.size;
  if (issuerIdentityMissing) {
    result.reason = "issuer_identity_unknown";
    result.provenance.missing_evidence.push("issuer_identity");
    result.status = "partial";
  }
  for (const metal of input.metal ? [input.metal] : MARKET_METALS) {
    const selected = scopedPlans.filter((p) => p.metal.toLowerCase() === metal);
    const issuersForMetal = new Set(
      selected.map((p) => p.issuer_id).filter(Boolean),
    );
    const row: Record<string, unknown> = {
      metal,
      plan_count: selected.length,
      evidence_refs: {
        catalog_snapshots: [
          ...new Set(selected.map((p) => p.snapshot_id)),
        ].sort(),
      },
      carrier_count: selected.some((p) => !p.issuer_id)
        ? null
        : issuersForMetal.size,
    };
    if (
      input.age !== undefined &&
      !groups.includes(metal as LowestInput["metal"])
    )
      row.pricing_status = "unsupported_metal";
    if (
      input.age !== undefined &&
      groups.includes(metal as LowestInput["metal"])
    ) {
      if (!selected.length) {
        Object.assign(row, {
          rated_count: 0,
          unknown_rate_count: 0,
          minimum_monthly_cents: null,
          maximum_monthly_cents: null,
        });
      } else {
        const rated = await enumerateLowest(
          db,
          {
            ...input,
            age: input.age,
            metal: metal as LowestInput["metal"],
            tobacco: input.tobacco ?? false,
            market: "individual",
            coverage: "medical",
            premium_basis: "gross",
            page: 1,
            market_segment: "on_exchange",
            coverage_start: `${input.year}-01-01`,
          },
          await handyManifest(db),
        );
        const cents = rated.provenance.candidates.map((candidate) =>
          Number(candidate.monthly_cents),
        );
        const pricingSnapshots = rated.provenance.snapshots.flatMap(
          (snapshot) =>
            snapshot &&
            typeof snapshot === "object" &&
            "snapshot_id" in snapshot &&
            typeof snapshot.snapshot_id === "string"
              ? [snapshot.snapshot_id]
              : [],
        );
        for (const snapshot of pricingSnapshots) sourceSnapshots.add(snapshot);
        row.evidence_refs = {
          catalog_snapshots: [
            ...new Set(selected.map((p) => p.snapshot_id)),
          ].sort(),
          pricing_snapshots: pricingSnapshots,
        };
        Object.assign(row, {
          rated_count: cents.length,
          unknown_rate_count:
            rated.status === "calculated" || rated.status === "no_plans"
              ? 0
              : Math.max(
                  0,
                  selected.length -
                    cents.length -
                    rated.provenance.excluded.length,
                ),
          minimum_monthly_cents: cents.length ? Math.min(...cents) : null,
          maximum_monthly_cents: cents.length ? Math.max(...cents) : null,
          status: rated.status,
          reason: rated.reason,
        });
        if (rated.status !== "calculated" && rated.status !== "no_plans")
          result.status = "partial";
      }
    }
    result.by_metal.push(row);
  }
  if (!plans.length) {
    result.status = "no_plans";
    result.reason = "no_matching_plans";
  } else if (result.status !== "partial") {
    result.status = "calculated";
  }
  result.provenance.snapshots = await handySnapshots(
    db,
    [...sourceSnapshots].sort(),
    true,
  );
  if ((await dataGeneration(db)) !== generation) {
    result.status = "unknown";
    result.reason = "data_changed";
    result.plan_count = null;
    result.carrier_count = null;
    result.by_metal = [];
    result.provenance.snapshots = [];
    result.provenance.missing_evidence.push("stable_data_generation");
  }
  return result;
}

export const HOUSEHOLD_METALS = [
  "bronze",
  "expanded bronze",
  "silver",
  "gold",
  "platinum",
] as const;
type HouseholdMetal = (typeof HOUSEHOLD_METALS)[number];
const householdMember = z.strictObject({
  age: z.int().min(0).max(120),
  relationship: z.enum(["subscriber", "spouse", "child", "other"]),
  tobacco: z.boolean(),
});
export type HandyMember = z.output<typeof householdMember>;
const householdSchema = z.strictObject({
  zip: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  county: z
    .string()
    .regex(/^\d{5}$/)
    .optional(),
  year: z.int().min(2014).max(9999),
  coverage_start: z.string().optional(),
  preset: z.literal("family-40-40-10-8-v1").optional(),
  members: z.array(householdMember).min(1).max(100).optional(),
});
const PRESET_MEMBERS: readonly HandyMember[] = [
  { age: 40, relationship: "subscriber", tobacco: false },
  { age: 40, relationship: "spouse", tobacco: false },
  { age: 10, relationship: "child", tobacco: false },
  { age: 8, relationship: "child", tobacco: false },
];

/** Explicit ages and flags, or one selected, versioned preset. No household is inferred. */
export function householdInput(value: unknown) {
  const parsed = householdSchema.safeParse(value);
  if (!parsed.success)
    return fail(String(parsed.error.issues[0]?.path[0] ?? "input"));
  const input = parsed.data;
  if ((input.preset === undefined) === (input.members === undefined))
    return fail("members");
  // Reuse the quote boundary's date, location and member validation.
  const members = input.members ?? PRESET_MEMBERS.map((m) => ({ ...m }));
  const request = premiumRequest({
    ...input,
    members,
    coverage_start: input.coverage_start ?? `${input.year}-01-01`,
    plan_ids: ["00000TX0000000"],
  });
  if (request.year !== input.year) return fail("coverage_start");
  return {
    ...request.location,
    year: input.year,
    coverage_start: request.coverage,
    members,
    origin: input.preset
      ? ("product_preset" as const)
      : ("operator_input" as const),
    preset: input.preset ?? null,
    preset_hash: input.preset ? digest(JSON.stringify(PRESET_MEMBERS)) : null,
  };
}
export type HouseholdInput = ReturnType<typeof householdInput>;

/** The sales profiles require the complete, explicitly ordered four-member basis. */
export function householdProfiles(members: readonly HandyMember[]) {
  if (
    members.length !== 4 ||
    members.map((m) => m.relationship).join(",") !==
      "subscriber,spouse,child,child"
  )
    return fail("members");
  return [
    { id: "employee_only", members: members.slice(0, 1) },
    { id: "employee_spouse", members: members.slice(0, 2) },
    { id: "employee_spouse_child", members: members.slice(0, 3) },
    { id: "employee_spouse_children", members: members.slice(0, 4) },
  ];
}
interface HouseholdCandidate {
  plan_id: string;
  monthly_cents: number | null;
  status: "rated" | "unknown";
  reason: string | null;
  evidence_ref: number;
}
interface HouseholdPoint {
  rank: number;
  denominator: number;
  monthly_cents: number;
  plan_id: string;
  tied_plan_count: number;
  tied_plan_ids: string[];
  evidence_refs: number[];
}
function householdGroup(metal: HouseholdMetal) {
  return {
    metal,
    status: "unknown" as "unknown" | "calculated" | "no_plans",
    reasons: [] as string[],
    counts: {
      catalog: null as number | null,
      eligible: null as number | null,
      rated: null as number | null,
      unknown: null as number | null,
      excluded: null as number | null,
    },
    completeness: { catalog: "unknown", rates: "unknown" },
    candidates: [] as HouseholdCandidate[],
    excluded: [] as { plan_id: string; reason: string; evidence_ref: number }[],
    points: {
      minimum: null as HouseholdPoint | null,
      p25: null as HouseholdPoint | null,
      median: null as HouseholdPoint | null,
      p75: null as HouseholdPoint | null,
      maximum: null as HouseholdPoint | null,
    },
  };
}
function finishHouseholdGroup(group: ReturnType<typeof householdGroup>) {
  const rated = group.candidates
    .filter((c) => c.status === "rated")
    .sort(
      (a, b) =>
        a.monthly_cents! - b.monthly_cents! ||
        (a.plan_id < b.plan_id ? -1 : Number(a.plan_id > b.plan_id)),
    );
  group.counts.rated = rated.length;
  group.counts.unknown = group.candidates.length - rated.length;
  group.counts.excluded = group.excluded.length;
  group.counts.eligible = group.candidates.length;
  if (group.reasons.length || group.counts.unknown) {
    group.completeness.rates = "incomplete";
    return;
  }
  group.completeness.rates = "complete";
  group.status = rated.length ? "calculated" : "no_plans";
  if (!rated.length) return;
  const point = (rank: number): HouseholdPoint => {
    const selected = rated[rank - 1]!;
    const ties = rated.filter(
      (c) => c.monthly_cents === selected.monthly_cents,
    );
    return {
      rank,
      denominator: rated.length,
      monthly_cents: selected.monthly_cents!,
      plan_id: ties[0]!.plan_id,
      tied_plan_count: ties.length,
      tied_plan_ids: ties.map((c) => c.plan_id),
      evidence_refs: ties.map((c) => c.evidence_ref),
    };
  };
  group.points = {
    minimum: point(1),
    p25: point(Math.ceil(rated.length / 4)),
    median: point(Math.ceil(rated.length / 2)),
    p75: point(Math.ceil((3 * rated.length) / 4)),
    maximum: point(rated.length),
  };
}

async function enumerateHouseholds(
  db: SqlSession,
  input: HouseholdInput,
  fourProfiles: boolean,
  manifest: string,
) {
  const locationInput = {
    ...(input.zip ? { zip: input.zip } : {}),
    ...(input.county ? { county: input.county } : {}),
  };
  const resolved = await resolveLocation(db, locationInput, {
    allowCmsLive: false,
    year: input.year,
  });
  const location =
    input.zip && !input.county && resolved.counties.length > 1
      ? { ...resolved, status: "ambiguous" as const, county: undefined }
      : resolved;
  const profiles = (
    fourProfiles
      ? householdProfiles(input.members)
      : [{ id: "household", members: input.members }]
  ).map((profile) => ({
    ...profile,
    metals: HOUSEHOLD_METALS.map(householdGroup),
    lowest_silver: null as HouseholdPoint | null,
    median_gold: null as HouseholdPoint | null,
  }));
  const evidence: unknown[] = [];
  const sourceIds = new Set<string>();
  function collectSources(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (
        ["snapshot_id", "publication_snapshot_id", "snapshotId"].includes(
          key,
        ) &&
        typeof child === "string"
      )
        sourceIds.add(child);
      else if (key === "snapshot_ids" && child && typeof child === "object") {
        for (const id of Object.values(child))
          if (typeof id === "string") sourceIds.add(id);
      } else collectSources(child);
    }
  }
  const evidenceIndex = new Map<string, number>();
  const ref = (value: unknown) => {
    const key = JSON.stringify(value);
    const found = evidenceIndex.get(key);
    if (found !== undefined) return found;
    evidenceIndex.set(key, evidence.length);
    collectSources(value);
    evidence.push(value);
    return evidence.length - 1;
  };
  const result = {
    schema_version: "1" as const,
    algorithm_version: "household-nearest-rank-v1" as const,
    status: "unknown" as string,
    reason: null as string | null,
    year: input.year,
    coverage_start: input.coverage_start,
    location,
    basis: {
      origin: input.origin,
      preset: input.preset,
      preset_hash: input.preset_hash,
      members: input.members,
      market: "individual",
      market_segment: "on_exchange",
      coverage: "medical",
      premium_basis: "gross",
      selection_universe: "public_catalog",
      weighting: "equal_per_base_plan",
      quantiles: "nearest_rank",
    },
    profiles,
    provenance: {
      input_manifest: manifest,
      snapshots: [] as Record<string, unknown>[],
      evidence,
      excluded: [] as {
        plan_id: string;
        reason: string;
        evidence_ref: number;
      }[],
    },
    bindable_quote: false as const,
    subsidy_status: "not_evaluated" as const,
  };
  const refuse = (reason: string) => ({ ...result, reason });
  if (location.status !== "available" || !location.county)
    return refuse(
      location.status === "ambiguous"
        ? "location_ambiguous"
        : "zip_not_in_loaded_geography",
    );
  // Postal locality evidence can omit secondary counties.
  if (
    location.zip &&
    (
      await locationZipCounties(db, location.zip, {
        allowCmsLive: false,
        year: input.year,
      })
    ).source === "geonames"
  )
    return refuse("geography_not_exact");
  const state = countyState(location.county);
  if (!(await activeCatalog(db, input.year, state)).rows.length)
    return refuse("catalog_not_loaded");
  for (const id of await handyScopeSnapshotIds(db, state, input.year))
    sourceIds.add(id);
  collectSources(location);
  const reads = requestReads(db);
  const all = await reads.countyPlans(
    location.county,
    input.year,
    location.zip,
  );
  reads.plan(all);
  const groups = profiles.flatMap((p) => p.metals);
  for (const group of groups) {
    group.counts.catalog = 0;
    group.completeness.catalog = "complete";
  }
  const block = (
    reason: string,
    metals: readonly string[] = HOUSEHOLD_METALS,
  ) => {
    for (const group of groups)
      if (metals.includes(group.metal) && !group.reasons.includes(reason))
        group.reasons.push(reason);
  };
  let entries:
    | Awaited<ReturnType<typeof nyLcspCatalog>>
    | Awaited<ReturnType<typeof vtLcspCatalog>>
    | undefined;
  if (state === "NY" || state === "VT") {
    const area = stateRatingArea(state, input.year, location.county);
    if (!area) return refuse("unsupported_rating_method");
    for (const refused of await refusedTemplatePlans(
      db,
      state,
      input.year,
      area.rating_area_id,
    )) {
      const metals = refused.metals.length ? refused.metals : HOUSEHOLD_METALS;
      block(refused.reason, metals);
      ref({ refused });
      for (const group of groups)
        if (metals.includes(group.metal)) {
          group.counts.catalog = null;
          group.completeness.catalog = "incomplete";
        }
    }
    entries =
      state === "NY"
        ? await nyLcspCatalog(db, input.year, area.rating_area_id)
        : await vtLcspCatalog(db, input.year, area.rating_area_id);
    if (state === "VT" && !vtMetalCatalogComplete(entries.map((e) => e.row)))
      block("metal_level_unknown");
  }
  if (!location.zip && state !== "NY" && state !== "VT") {
    const rows = await reads.countyRows(location.county, input.year);
    for (const plan of rows.filter(
      (p) => !p.dental_only && p.on_exchange && p.zip_restricted,
    )) {
      const metal = plan.metal?.toLowerCase();
      block(
        "zip_limited_service_area",
        HOUSEHOLD_METALS.includes(metal as HouseholdMetal)
          ? [metal]
          : HOUSEHOLD_METALS,
      );
    }
  }
  if (!location.zip) {
    for (const plan of all.filter((p) => !p.dental_only && p.on_exchange)) {
      if (
        (plan.premium_availability as { reason?: string } | undefined)
          ?.reason === "UNRESOLVED_RATING_AREA"
      ) {
        const metal = plan.metal?.toLowerCase();
        block(
          "sub_county_rating_area",
          HOUSEHOLD_METALS.includes(metal as HouseholdMetal)
            ? [metal]
            : HOUSEHOLD_METALS,
        );
      }
    }
  }
  for (const plan of all.sort((a, b) =>
    a.base_plan_id < b.base_plan_id
      ? -1
      : Number(a.base_plan_id > b.base_plan_id),
  )) {
    const matched = entries?.filter(
      (e) => e.row.plan_key === plan.base_plan_id,
    );
    const attrs = matched
      ? matched.flatMap((e) => e.attributes)
      : (await reads.exchangeAttributes(plan)).rows;
    const metals = new Set<string>();
    if (matched) {
      for (const each of matched) {
        for (const attr of each.attributes)
          metals.add(attr.metal.trim().toLowerCase());
        if (each.filed_identity)
          metals.add(each.filed_identity.metal.toLowerCase());
        if (each.row.raw_record.metal)
          metals.add(each.row.raw_record.metal.toLowerCase());
      }
    } else if (plan.metal) metals.add(plan.metal.trim().toLowerCase());
    const metal = [...metals][0];
    const offEntries = matched?.filter(
      (e) =>
        e.filed_identity?.off_exchange ||
        ("off_exchange" in e && e.off_exchange),
    );
    const knownOff = matched
      ? Boolean(matched.length && offEntries?.length === matched.length)
      : !plan.on_exchange;
    const on = matched
      ? matched.some((e) => e.exchange_evidence)
      : plan.on_exchange;
    const catalogEvidence = {
      catalog: {
        plan_id: plan.base_plan_id,
        snapshot_id: plan.snapshot_id,
        source_row: plan.source_row,
      },
      attributes: attrs,
      ...(matched
        ? {
            filed_entries: matched.map((each) => ({
              plan_key: each.row.plan_key,
              record_index: each.row.record_index,
              metal: each.row.raw_record.metal,
              provenance: each.row.rate.provenance,
              exchange_evidence: each.exchange_evidence,
              filed_identity: each.filed_identity,
            })),
          }
        : {}),
    };
    if ((knownOff || offEntries?.length) && on) {
      block("exchange_offering_conflict");
      ref(catalogEvidence);
      continue;
    }
    if (
      metals.size !== 1 ||
      !metal ||
      metal === "unknown" ||
      (!HOUSEHOLD_METALS.includes(metal as HouseholdMetal) &&
        metal !== "catastrophic")
    ) {
      if (!knownOff) block("metal_level_unknown");
      const evidence_ref = ref(catalogEvidence);
      if (knownOff)
        result.provenance.excluded.push({
          plan_id: plan.base_plan_id,
          reason: "off_exchange",
          evidence_ref,
        });
      continue;
    }
    if (metal === "catastrophic") {
      result.provenance.excluded.push({
        plan_id: plan.base_plan_id,
        reason: "catastrophic",
        evidence_ref: ref({ ...catalogEvidence, exclusion: "catastrophic" }),
      });
      continue;
    }
    for (const profile of profiles) {
      const group = profile.metals.find((g) => g.metal === metal)!;
      if (group.counts.catalog !== null) group.counts.catalog++;
      const exclude = (reason: string) =>
        group.excluded.push({
          plan_id: plan.base_plan_id,
          reason,
          evidence_ref: ref({ ...catalogEvidence, exclusion: reason }),
        });
      if (knownOff) {
        exclude("off_exchange");
        continue;
      }
      const eligible = familyOffer(
        attrs,
        profile.members.some((m) => m.age >= 21),
        profile.members.some((m) => m.age < 21),
      );
      if (eligible === false) {
        exclude("coverage_family_ineligible");
        continue;
      }
      const unknown = (reason: string, rating?: unknown) => {
        group.candidates.push({
          plan_id: plan.base_plan_id,
          monthly_cents: null,
          status: "unknown",
          reason,
          evidence_ref: ref({ ...catalogEvidence, rating }),
        });
        if (!group.reasons.includes(reason)) group.reasons.push(reason);
      };
      if (!on) {
        unknown("exchange_offering_unverified");
        continue;
      }
      if (eligible === null) {
        unknown("coverage_family_eligibility_unknown");
        continue;
      }
      const identity = plan.base_plan_id.includes(":")
        ? { plan_keys: [plan.base_plan_id] }
        : { plan_ids: [plan.base_plan_id] };
      const request = premiumRequest({
        ...input,
        ...identity,
        members: profile.members,
      });
      const { estimate } = await ratePremium(
        db,
        plan,
        plan.base_plan_id,
        request,
        location,
        reads,
      );
      if (
        estimate.status !== "rated" ||
        !("total_cents" in estimate) ||
        !Number.isSafeInteger(estimate.total_cents) ||
        Number(estimate.total_cents) < 0 ||
        !estimate.rate_rows_used.length
      ) {
        unknown("premium_not_rated", estimate);
        continue;
      }
      group.candidates.push({
        plan_id: plan.base_plan_id,
        monthly_cents: estimate.total_cents!,
        status: "rated",
        reason: null,
        evidence_ref: ref({ ...catalogEvidence, rating: estimate }),
      });
    }
  }
  for (const profile of profiles) {
    for (const group of profile.metals) {
      finishHouseholdGroup(group);
      // A refused/unknown classification can hide further candidates: these denominators are unproved.
      if (
        group.completeness.catalog === "incomplete" ||
        group.reasons.includes("metal_level_unknown") ||
        group.reasons.includes("zip_limited_service_area") ||
        group.reasons.includes("exchange_offering_conflict")
      ) {
        group.counts.catalog = null;
        group.counts.eligible = null;
        group.counts.unknown = null;
        group.counts.excluded = null;
        group.completeness.catalog = "incomplete";
      }
    }
    for (const group of profile.metals) {
      if (
        group.reasons.some((r) =>
          [
            "coverage_family_eligibility_unknown",
            "exchange_offering_unverified",
          ].includes(r),
        )
      )
        group.counts.eligible = null;
    }
    profile.lowest_silver = profile.metals.find(
      (g) => g.metal === "silver",
    )!.points.minimum;
    profile.median_gold = profile.metals.find(
      (g) => g.metal === "gold",
    )!.points.median;
  }
  result.provenance.snapshots = await handySnapshots(db, [...sourceIds].sort());
  const complete = groups.filter((g) => g.status !== "unknown").length;
  if (complete === groups.length)
    result.status = groups.some((g) => g.status === "calculated")
      ? "calculated"
      : "no_plans";
  else if (complete) result.status = "partial";
  return result;
}

/** Core only, default off. Explicit households remain request-scoped; no routes or derived writes. */
export async function householdDistributions(
  db: SqlSession,
  value: unknown,
  options: { enabled?: boolean; fourProfiles?: boolean } = {},
) {
  if (!options.enabled) throw new Error("Household distributions disabled");
  const input = householdInput(value);
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = await dataGeneration(db),
      manifest = await handyManifest(db);
    const result = await enumerateHouseholds(
      db,
      input,
      options.fourProfiles ?? false,
      manifest,
    );
    if (
      (await dataGeneration(db)) !== generation ||
      (await handyManifest(db)) !== manifest
    )
      continue;
    return { ...result, data_generation: generation };
  }
  throw new HandyDataChanged("DATA_CHANGED");
}

export type HouseholdDistributionResult = Awaited<
  ReturnType<typeof householdDistributions>
>;

const householdAttributeEvidence = z
  .object({
    attributes: z.array(
      z
        .object({
          source_row: z.number(),
          raw: z.record(z.string(), z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const householdRateEvidence = z
  .object({
    members: z.array(
      z.object({ rate_rows: z.array(z.unknown()).optional() }).passthrough(),
    ),
    rate_rows_used: z.array(z.unknown()),
  })
  .passthrough();
/** Preserve source rows and the fields used for family, metal and channel decisions. */
function householdEvidence(value: unknown): unknown {
  const parsed = householdAttributeEvidence.safeParse(value);
  if (!parsed.success) return value;
  const result = {
    ...parsed.data,
    attributes: parsed.data.attributes.map((attribute) => ({
      ...attribute,
      raw: Object.fromEntries(
        Object.entries(attribute.raw).filter(([field]) =>
          [
            "ChildOnlyOffering",
            "MetalLevel",
            "QHPNonQHPTypeId",
            "StandardComponentId",
            "PlanId",
          ].includes(field),
        ),
      ),
    })),
  };
  const rated = householdRateEvidence.safeParse(parsed.data.rating);
  if (!rated.success) return result;
  const rowKeys = rated.data.rate_rows_used.map(canonical);
  const refs = rated.data.members.map((member) =>
    member.rate_rows?.map((row) => rowKeys.indexOf(canonical(row))),
  );
  // Keep the original rows if the shared table cannot represent every member exactly.
  if (refs.some((member) => member?.some((ref) => ref < 0))) return result;
  return {
    ...result,
    rating: {
      ...rated.data,
      members: rated.data.members.map((member, index) => {
        if (!member.rate_rows) return member;
        const { rate_rows: _rows, ...fields } = member;
        return { ...fields, rate_row_refs: refs[index] };
      }),
    },
  };
}

const householdRatingBasis = z.object({
  rating: z.object({
    quote_method: z.string().optional(),
    rule_trace: z.object({ tier: z.string() }).optional(),
    provenance: z.object({
      rating_rule: z.object({ method: z.string() }).nullable(),
    }),
  }),
});
/** Public projections share the household reader, never a stored household or individual minima. */
export async function householdHandy(
  db: SqlSession,
  value: unknown,
  summary = false,
) {
  const input = householdHandyInput(value, summary);
  for (let attempt = 0; attempt < 2; attempt++) {
    const distribution = await householdDistributions(
      db,
      {
        zip: input.zip,
        county: input.county,
        year: input.year,
        coverage_start: input.coverage_start,
        members: input.members,
      },
      { enabled: true },
    );
    const groups = distribution.profiles[0]!.metals.filter(
      (g) => input.metal === undefined || g.metal === input.metal,
    );
    const group = groups[0]!;
    let scopedStatus = "unknown";
    if (groups.every((g) => g.status !== "unknown"))
      scopedStatus = groups.some((g) => g.status === "calculated")
        ? "calculated"
        : "no_plans";
    else if (groups.some((g) => g.status !== "unknown"))
      scopedStatus = "partial";
    let status = summary ? scopedStatus : group.status;
    if (distribution.location.status === "ambiguous") status = "ambiguous";
    else if (
      groups.some((g) =>
        g.reasons.some((reason) =>
          ["zip_limited_service_area", "sub_county_rating_area"].includes(
            reason,
          ),
        ),
      )
    )
      status = "location_requires_zip";
    let reason = distribution.reason;
    if (reason === null && status === "location_requires_zip")
      reason = groups
        .flatMap((g) => g.reasons)
        .find((reason) =>
          ["zip_limited_service_area", "sub_county_rating_area"].includes(
            reason,
          ),
        )!;
    if (reason === null && status === "unknown")
      reason = group.reasons[0] ?? "incomplete_offer_cohort";
    if (reason === null && status === "no_plans") reason = "no_matching_plans";
    const candidates = groups.flatMap((g) => g.candidates);
    const evidenceSize = 2;
    const evidenceStart = (input.evidence_page - 1) * evidenceSize;
    const details = candidates.slice(
      evidenceStart,
      evidenceStart + evidenceSize,
    );
    // Every selected extreme keeps its rating evidence even on later detail pages.
    for (const g of groups) {
      for (const point of [
        g.points.minimum,
        ...(summary ? [g.points.maximum] : []),
      ]) {
        const candidate = g.candidates.find(
          (c) => c.plan_id === point?.plan_id,
        );
        if (candidate && !details.includes(candidate)) details.push(candidate);
      }
    }
    const exclusions = [
      ...distribution.provenance.excluded,
      ...groups.flatMap((g) => g.excluded),
    ];
    const excluded = exclusions.slice(
      evidenceStart,
      evidenceStart + evidenceSize,
    );
    const indexed = new Set(
      distribution.profiles
        .flatMap((p) =>
          p.metals.flatMap((g) => [...g.candidates, ...g.excluded]),
        )
        .concat(distribution.provenance.excluded)
        .map((c) => c.evidence_ref),
    );
    const classificationRefs = distribution.provenance.evidence.flatMap(
      (_value, index) => (indexed.has(index) ? [] : [index]),
    );
    const refs = [
      ...new Set(
        [...details, ...excluded]
          .map((c) => c.evidence_ref)
          .concat(classificationRefs),
      ),
    ].sort((a, b) => a - b);
    const remap = new Map(refs.map((ref, i) => [ref, i]));
    const selected = groups.find((g) => g.points.minimum)?.points.minimum;
    const selectedEvidence = selected
      ? distribution.provenance.evidence[selected.evidence_refs[0]!]
      : undefined;
    const ratedBasis = householdRatingBasis.safeParse(selectedEvidence);
    const rating = ratedBasis.success ? ratedBasis.data.rating : null;
    const filedTier = rating?.quote_method === "state_filed_tier";
    let ageRating: string | null = rating ? "filed_age_cell" : null;
    if (filedTier) ageRating = "none";
    const common = {
      schema_version: "1" as const,
      status,
      reason,
      year: input.year,
      location: distribution.location,
      basis: {
        ...distribution.basis,
        coverage_start: distribution.coverage_start,
        rating_method: filedTier
          ? "filed_family_tier"
          : (rating?.provenance.rating_rule?.method ?? null),
        age_rating: ageRating,
        family_tier: rating?.rule_trace?.tier ?? null,
        ...(input.metal ? { metal: input.metal } : {}),
      },
      completeness: summary
        ? {
            catalog: groups.every((g) => g.completeness.catalog === "complete")
              ? "complete"
              : "incomplete",
            rates: groups.every((g) => g.completeness.rates === "complete")
              ? "complete"
              : "incomplete",
          }
        : group.completeness,
      issues: [...new Set(groups.flatMap((g) => g.reasons))],
      provenance: {
        input_manifest: distribution.provenance.input_manifest,
        snapshots: distribution.provenance.snapshots,
        evidence: refs.map((ref) =>
          householdEvidence(distribution.provenance.evidence[ref]),
        ),
        candidates: details.map((c) => ({
          ...c,
          evidence_ref: remap.get(c.evidence_ref)!,
        })),
        excluded_total: exclusions.length,
        excluded: excluded.map((c) => ({
          ...c,
          evidence_ref: remap.get(c.evidence_ref)!,
        })),
      },
      evidence_page: input.evidence_page,
      evidence_page_size: evidenceSize,
      next_evidence_page:
        Math.max(candidates.length, exclusions.length) >
        evidenceStart + evidenceSize
          ? input.evidence_page + 1
          : null,
      candidates_total: candidates.length,
      evidence_total: distribution.provenance.evidence.length,
      bindable_quote: false as const,
      subsidy_status: "not_evaluated" as const,
      data_generation: distribution.data_generation,
    };
    if (summary) {
      const plans = distribution.location.county
        ? await countyPlans(
            db,
            distribution.location.county,
            input.year,
            distribution.location.zip,
          )
        : [];
      const issuers = new Map(plans.map((p) => [p.base_plan_id, p.issuer_id]));
      const by_metal = groups.map((g) => ({
        metal: g.metal,
        status: g.status,
        reason: g.reasons[0] ?? null,
        plan_count: g.counts.eligible,
        carrier_count:
          g.counts.eligible === null
            ? null
            : new Set(g.candidates.map((c) => issuers.get(c.plan_id))).size,
        rated_count: g.counts.rated,
        unknown_rate_count: g.counts.unknown,
        minimum_monthly_cents: g.points.minimum?.monthly_cents ?? null,
        maximum_monthly_cents: g.points.maximum?.monthly_cents ?? null,
        evidence_refs: details
          .filter((c) => g.candidates.includes(c))
          .map((c) => remap.get(c.evidence_ref)!),
      }));
      if (
        (await dataGeneration(db)) !== distribution.data_generation ||
        (await handyManifest(db)) !== distribution.provenance.input_manifest
      )
        continue;
      const known = by_metal.every((g) => g.plan_count !== null);
      return {
        ...common,
        status:
          common.status === "calculated" &&
          by_metal.some((g) => g.status === "unknown")
            ? "partial"
            : common.status,
        plan_count: known
          ? by_metal.reduce((sum, g) => sum + g.plan_count!, 0)
          : null,
        carrier_count: known
          ? new Set(
              groups.flatMap((g) =>
                g.candidates.map((c) => issuers.get(c.plan_id)),
              ),
            ).size
          : null,
        by_metal,
      };
    }
    const page =
      "page" in input && typeof input.page === "number" ? input.page : 1;
    const minimum = group.points.minimum;
    return {
      ...common,
      lowest: {
        plan_id: minimum?.plan_id ?? null,
        monthly_cents: minimum?.monthly_cents ?? null,
        tied_plan_count: minimum?.tied_plan_count ?? null,
      },
      ties: minimum?.tied_plan_ids.slice((page - 1) * 50, page * 50) ?? [],
      candidate_count: group.counts.eligible,
      page,
      page_size: 50 as const,
      next_page:
        minimum && minimum.tied_plan_count > page * 50 ? page + 1 : null,
    };
  }
  throw new HandyDataChanged("DATA_CHANGED");
}
