import type { ResponseCache } from "../api/cache/index.js";
import type { SqlSession } from "../db/database.js";
import type { LowestInput } from "../api/handy.js";
import { lowestInput } from "../api/handy.js";
import {
  activeCatalog,
  countyState,
  resolveLocation,
  snapshots as planSnapshots,
} from "../api/repository.js";
import { premiumRequest } from "../api/validation.js";
import { requestReads } from "./request-reads.js";
import { familyOffer } from "./coverage-family.js";
import { ratePremium } from "./premiums.js";
import { dataGeneration } from "../api/cache/generation.js";
import {
  handyManifest,
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
  if (!(await activeCatalog(db, input.year, state)).rows.length)
    return refuse("unknown", "catalog_not_loaded");
  base.completeness.catalog = "available";
  const scopeSnapshots = await handyScopeSnapshotIds(db, state, input.year);
  base.provenance.snapshots = await handySnapshots(db, scopeSnapshots);
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
      if (!metals.has("silver")) continue;
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
  const silver = (p: {
    metal: string;
    on_exchange: boolean;
    base_plan_id: string;
  }) =>
    p.metal.toLowerCase() === "silver" &&
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
    ).some((p) => !p.dental_only && silver(p) && p.zip_restricted);
    if (restricted)
      return refuse("location_requires_zip", "zip_limited_service_area");
    if (
      all
        .filter(silver)
        .some(
          (p) =>
            (p.premium_availability as { reason?: string } | undefined)
              ?.reason === "UNRESOLVED_RATING_AREA",
        )
    )
      return refuse("location_requires_zip", "sub_county_rating_area");
  }
  const offered = all.filter(silver).sort((a, b) => {
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
    members: [{ age: input.age, tobacco: false, relationship: "subscriber" }],
  });
  const rated: { id: string; cents: number }[] = [];
  const snapshots = new Set<string>(scopeSnapshots);
  reads.plan(offered);
  for (const plan of offered) {
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
  base.provenance.snapshots = await handySnapshots(db, [...snapshots].sort());
  base.candidate_count = rated.length;
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
    const generation = await dataGeneration(db),
      manifest = await handyManifest(db);
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
    if (
      (await dataGeneration(db)) !== generation ||
      (await handyManifest(db)) !== manifest
    )
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
