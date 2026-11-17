import { offerCohortInputSchema } from "@openplans/plugin-sdk";
import type { OfferCohort } from "@openplans/plugin-sdk";
import type { SqlSession } from "../db/database.js";
import { lowestInput } from "../api/handy.js";
import { dataGeneration } from "../api/cache/generation.js";
import { handyManifest } from "../db/handy-repository.js";
import { offerStatistics } from "../domain/comparison/statistics.js";
import {
  enumerateLowest as enumerateSilverOffers,
  householdDistributions,
} from "./handy.js";
export { enumerateSilverOffers };

/** Full cohort, guarded as one calculation even on autocommit database adapters. */
export async function enumerateHouseholdOffers(
  db: SqlSession,
  value: unknown,
  consumeOffer: () => void = () => {},
): Promise<OfferCohort> {
  const input = offerCohortInputSchema.parse(value);
  if (input.members) {
    const household = await householdDistributions(
      db,
      {
        ...(input.zip ? { zip: input.zip } : {}),
        ...(input.county ? { county: input.county } : {}),
        year: input.year,
        members: input.members.map((member) => ({ ...member, tobacco: false })),
        coverage_start: input.coverage_start,
      },
      { enabled: true },
    );
    const token = `${household.data_generation}:${household.provenance.input_manifest}`;
    if (input.data_generation && input.data_generation !== token)
      throw new Error("generation_changed");
    const profile = household.profiles[0];
    const group = profile?.metals.find((entry) => entry.metal === input.metal);
    if (!profile || !group)
      throw new Error("household_distribution_unavailable");
    const candidates = group.candidates as unknown as Record<string, unknown>[];
    const excluded = group.excluded.filter(
      (entry) => entry.reason !== "off_exchange",
    ) as unknown as Record<string, unknown>[];
    const rated = candidates.filter((entry) => entry.status === "rated");
    const complete =
      group.status === "calculated" || group.status === "no_plans";
    const reasons = new Map<string, number>();
    for (const entry of excluded) {
      const reason = String(entry.reason);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    for (const entry of candidates.filter((row) => row.status !== "rated")) {
      const reason = String(entry.reason ?? "premium_not_rated");
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const statistics = offerStatistics(
      rated.map((entry) => ({
        plan_id: String(entry.plan_id),
        monthly_cents: Number(entry.monthly_cents),
      })),
    );
    const evidencePage = input.evidence_page;
    const pageSize = 2;
    const start = (evidencePage - 1) * pageSize;
    const rows = household.provenance.evidence as unknown[];
    const snapshots = household.provenance.snapshots as Record<
      string,
      unknown
    >[];
    const cohort = {
      status: group.status,
      reason: group.reasons[0] ?? null,
      data_generation: token,
      year: input.year,
      location: household.location,
      basis: {
        ...household.basis,
        coverage_start: household.coverage_start,
        metal: input.metal,
        household: input.members,
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
        candidates: rated.slice(start, start + pageSize),
        excluded: excluded.slice(start, start + pageSize),
        unknown: candidates
          .filter((row) => row.status !== "rated")
          .slice(start, start + pageSize),
        sources: rows.slice(start, start + pageSize),
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
    return cohort as OfferCohort;
  }
  const { evidence_page, data_generation, ...scope } = input;
  const request = lowestInput({
    ...scope,
    age: input.age!,
    metal: input.metal,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const generation = await dataGeneration(db);
    const manifest = await handyManifest(db);
    const token = `${generation}:${manifest}`;
    if (data_generation && data_generation !== token)
      throw new Error("generation_changed");
    const unknown: Record<string, unknown>[] = [];
    const cell = await enumerateSilverOffers(db, request, manifest, {
      unknown,
      consumeOffer,
    });
    const snapshotIds = cell.provenance.snapshots.map((row) =>
      String(row.snapshot_id),
    );
    const snapshotDates = (
      await db.query<{
        snapshot_id: string;
        retrieved_at: string | null;
        publisher_updated_at: string | null;
      }>(
        "SELECT snapshot_id,retrieved_at::text,publisher_updated_at::text FROM snapshot WHERE snapshot_id=ANY($1::text[])",
        [snapshotIds],
      )
    ).rows;
    if (
      generation !== (await dataGeneration(db)) ||
      manifest !== (await handyManifest(db))
    )
      continue;
    const complete = cell.status === "calculated" || cell.status === "no_plans";
    const counted = complete || cell.reason === "incomplete_offer_cohort";
    const candidates = cell.provenance.candidates;
    const excluded = cell.provenance.excluded;
    const prices = candidates.map((candidate) => ({
      plan_id: String(candidate.plan_id),
      monthly_cents: Number(candidate.monthly_cents),
    }));
    // Validate identities even when an incomplete cohort cannot publish statistics.
    const statistics = offerStatistics(prices);
    const reasons = new Map<string, number>();
    for (const entry of excluded) {
      const reason = String(entry.reason);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const pageSize = 2;
    const start = (evidence_page - 1) * pageSize;
    const shown = candidates.slice(start, start + pageSize);
    const refs = [
      ...new Set(
        shown
          .flatMap((entry) => [entry.evidence_ref, entry.rating_area_ref])
          .filter((ref): ref is number => typeof ref === "number"),
      ),
    ].sort((a, b) => a - b);
    const remap = new Map(refs.map((ref, index) => [ref, index]));
    return {
      status: cell.status,
      reason: cell.reason,
      data_generation: token,
      year: cell.year,
      location: cell.location,
      basis: cell.basis,
      denominator: {
        unit: "distinct_base_plan",
        candidate_count: counted ? cell.provenance.offered_plan_count : null,
        rated_count: counted ? candidates.length : null,
        excluded_count: counted ? excluded.length : null,
        unknown_count: counted ? unknown.length : null,
      },
      exclusions: [...reasons]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([reason, count]) => ({ reason, count })),
      completeness: cell.completeness,
      statistics: complete
        ? { ...statistics, evidence_refs: snapshotIds }
        : null,
      evidence: {
        manifest,
        offer_set: cell.provenance.offer_set,
        snapshots: cell.provenance.snapshots.map((row) => {
          const dates = snapshotDates.find(
            (entry) => entry.snapshot_id === row.snapshot_id,
          );
          return {
            ...row,
            retrieved_at: dates?.retrieved_at
              ? new Date(dates.retrieved_at).toISOString()
              : null,
            publisher_updated_at: dates?.publisher_updated_at
              ? new Date(dates.publisher_updated_at).toISOString()
              : null,
          };
        }),
        candidates: shown.map((entry) => ({
          ...entry,
          evidence_ref: remap.get(Number(entry.evidence_ref)) ?? null,
          rating_area_ref: remap.get(Number(entry.rating_area_ref)) ?? null,
        })),
        excluded: excluded.slice(start, start + pageSize),
        unknown: unknown.slice(start, start + pageSize),
        sources: refs.map((ref) => cell.provenance.evidence[ref]),
        page: evidence_page,
        page_size: pageSize,
        next_page:
          start + pageSize <
          Math.max(candidates.length, excluded.length, unknown.length)
            ? evidence_page + 1
            : null,
      },
      bindable_quote: false,
      subsidy_status: "not_evaluated",
    };
  }
  throw new Error("generation_changed");
}
