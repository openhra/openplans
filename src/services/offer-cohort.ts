import { offerCohortInputSchema } from "@openplans/plugin-sdk";
import type { OfferCohort } from "@openplans/plugin-sdk";
import type { SqlSession } from "../db/database.js";
import { offerStatistics } from "../domain/comparison/statistics.js";
import {
  HandyDataChanged,
  householdDistributions,
  householdEvidence,
} from "./handy.js";

/** Full cohort, guarded as one calculation even on autocommit database adapters. */
export async function enumerateHouseholdOffers(
  db: SqlSession,
  value: unknown,
  consumeOffer: () => void = () => {},
): Promise<OfferCohort> {
  const input = offerCohortInputSchema.parse(value);
  const members = input.members ?? [
    { age: input.age!, relationship: "subscriber" as const },
  ];
  const household = await householdDistributions(
    db,
    {
      ...(input.zip ? { zip: input.zip } : {}),
      ...(input.county ? { county: input.county } : {}),
      year: input.year,
      members: members.map((member) => ({ ...member, tobacco: false })),
      coverage_start: input.coverage_start,
    },
    {
      enabled: true,
      metals: [input.metal],
      consumeOffer,
      expectedGeneration: input.data_generation,
    },
  ).catch((error: unknown) => {
    if (error instanceof HandyDataChanged)
      throw new Error("generation_changed");
    throw error;
  });
  const token = `${household.data_generation}:${household.provenance.input_manifest}`;
  const profile = household.profiles[0];
  const group = profile?.metals.find((entry) => entry.metal === input.metal);
  if (!profile || !group) throw new Error("household_distribution_unavailable");
  const candidates = group.candidates;
  const excluded = group.excluded.filter(
    (entry) => entry.reason !== "off_exchange",
  );
  const rated = candidates.filter((entry) => entry.status === "rated");
  const unknown = candidates.filter((entry) => entry.status !== "rated");
  const complete = group.status === "calculated" || group.status === "no_plans";
  const reasons = new Map<string, number>();
  for (const entry of [...excluded, ...unknown]) {
    const reason = entry.reason ?? "premium_not_rated";
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const prices = rated.map((entry) => ({
    plan_id: entry.plan_id,
    monthly_cents: entry.monthly_cents!,
  }));
  const statistics = offerStatistics(prices);
  const evidencePage = input.evidence_page;
  const pageSize = 2;
  const start = (evidencePage - 1) * pageSize;
  const shown = {
    candidates: rated.slice(start, start + pageSize),
    excluded: excluded.slice(start, start + pageSize),
    unknown: unknown.slice(start, start + pageSize),
  };
  const refs = [
    ...new Set(
      Object.values(shown).flatMap((entries) =>
        entries.map((entry) => Number(entry.evidence_ref)),
      ),
    ),
  ].sort((a, b) => a - b);
  const rows = household.provenance.evidence;
  if (refs.some((ref) => !Number.isInteger(ref) || !rows[ref]))
    throw new Error("household_evidence_unavailable");
  const remap = new Map(refs.map((ref, index) => [ref, index]));
  const pageRows = (entries: readonly { evidence_ref: number }[]) =>
    entries.map((entry) => ({
      ...entry,
      evidence_ref: remap.get(Number(entry.evidence_ref))!,
    }));
  const snapshots = household.provenance.snapshots;
  let status: string = group.status;
  if (
    group.reasons.some((reason) =>
      ["zip_limited_service_area", "sub_county_rating_area"].includes(reason),
    )
  )
    status = "location_requires_zip";
  if (household.location.status === "ambiguous") status = "ambiguous";
  return {
    status,
    reason: household.reason ?? group.reasons[0] ?? null,
    data_generation: token,
    year: input.year,
    location: household.location,
    basis: {
      ...household.basis,
      coverage_start: household.coverage_start,
      metal: input.metal,
      household: members,
    },
    denominator: {
      unit: "distinct_base_plan",
      candidate_count:
        group.counts.catalog === null
          ? null
          : candidates.length + excluded.length,
      rated_count: group.counts.rated,
      excluded_count: group.counts.excluded === null ? null : excluded.length,
      unknown_count: group.counts.unknown,
    },
    exclusions: [...reasons]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => ({ reason, count })),
    completeness: group.completeness,
    statistics: complete
      ? {
          ...statistics,
          evidence_refs: snapshots.map((row) => String(row.snapshot_id)),
        }
      : null,
    evidence: {
      manifest: String(household.provenance.input_manifest),
      offer_set: null,
      snapshots,
      candidates: pageRows(shown.candidates),
      excluded: pageRows(shown.excluded),
      unknown: pageRows(shown.unknown),
      sources: refs.map((ref) => householdEvidence(rows[ref])),
      page: evidencePage,
      page_size: pageSize,
      next_page:
        start + pageSize <
        Math.max(
          rated.length,
          excluded.length,
          candidates.length - rated.length,
        )
          ? evidencePage + 1
          : null,
    },
    bindable_quote: false,
    subsidy_status: "not_evaluated",
  };
}
