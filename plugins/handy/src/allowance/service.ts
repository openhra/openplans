import type { CalculationHost, CalculationScope } from "@openplans/plugin-sdk";
import type { AllowancePrivateInput } from "./contract.js";
import { distributionPage, object, rows } from "./evidence.js";

type LocationYear = { zip: string; county?: string; year: number };
type Host = {
  householdDistributions: NonNullable<
    CalculationHost["householdDistributions"]
  >;
  slcsp: NonNullable<CalculationHost["slcsp"]>;
};

export async function allowanceScenario(
  host: Host,
  scope: CalculationScope,
  input:
    | (LocationYear & {
        preset: "family-40-40-10-8-v1";
        members?: never;
      })
    | AllowancePrivateInput,
  evidencePage = 1,
) {
  scope.signal.throwIfAborted();
  const request =
    "allowance_cents" in input
      ? {
          zip: input.zip,
          county: input.county,
          year: input.year,
          members: input.members,
        }
      : {
          zip: input.zip,
          county: input.county,
          year: input.year,
          preset: "family-40-40-10-8-v1" as const,
        };
  const raw = object(
    await host.householdDistributions(request, scope, { fourProfiles: true }),
  );
  const profiles = Array.isArray(raw.profiles) ? raw.profiles : [];
  const generation = raw.data_generation;
  if (typeof generation !== "string" || !generation)
    throw new Error("DATA_CHANGED");
  const expected = [
    "employee_only",
    "employee_spouse",
    "employee_spouse_child",
    "employee_spouse_children",
  ];
  const completeProfiles =
    profiles.length === 4 &&
    expected.every((id, index) => object(profiles[index]).id === id);
  const benchmarks = [];
  const evidence = Array.isArray(object(raw.provenance).evidence)
    ? [...(object(raw.provenance).evidence as unknown[])]
    : [];
  const snapshots = new Map(
    rows(object(raw.provenance).snapshots).map((item) => [
      item.snapshot_id,
      item,
    ]),
  );
  for (const entry of profiles) {
    scope.signal.throwIfAborted();
    const profile = object(entry);
    const members = Array.isArray(profile.members)
      ? profile.members.map((item) => {
          const member = object(item);
          return {
            age: member.age as number,
            relationship: member.relationship as
              "subscriber" | "spouse" | "child",
            tobacco: false as const,
          };
        })
      : [];
    const silver = await host.slcsp(
      { zip: input.zip, county: input.county, year: input.year, members },
      scope,
    );
    scope.signal.throwIfAborted();
    if (silver.data_generation !== generation) throw new Error("DATA_CHANGED");
    const { source_refs, snapshots: pins, ...summary } = silver;
    const start = evidence.length;
    evidence.push(...rows(source_refs).map((ref) => ({ source_refs: [ref] })));
    rows(pins).forEach((pin) => snapshots.set(pin.snapshot_id, pin));
    benchmarks.push(
      source_refs === undefined
        ? { profile_id: profile.id, result: silver }
        : {
            profile_id: profile.id,
            result: summary,
            evidence_range: { start, count: evidence.length - start },
          },
    );
  }
  const targetKnown =
    completeProfiles &&
    profiles.every((item) => {
      const cents = object(object(item).lowest_silver).monthly_cents;
      return Number.isSafeInteger(cents) && Number(cents) >= 0;
    });
  const projected = distributionPage(
    {
      ...raw,
      provenance: {
        ...object(raw.provenance),
        evidence,
        snapshots: [...snapshots.values()],
      },
    },
    evidencePage,
  );
  // Older calculation hosts retain their small DTO contract. Both formats share the response cap.
  const compact = raw.evidence_format === "source-references-v1";
  const answer: Record<string, unknown> = {
    schema_version: "1",
    status: raw.status ?? "unknown",
    year: input.year,
    location: raw.location ?? { zip: input.zip, county: input.county ?? null },
    preset: "members" in input ? null : "family-40-40-10-8-v1",
    preset_origin: "members" in input ? "operator_input" : "product_preset",
    reason: completeProfiles
      ? (raw.reason ?? null)
      : "required_profile_missing",
    profiles: compact ? projected.profiles : profiles,
    slcsp: benchmarks,
    target: {
      basis: "full_gross_lowest_silver_premium",
      profile_count: profiles.length,
      denominator: 4,
      monthly_cents: targetKnown
        ? Math.max(
            ...profiles.map((item) =>
              Number(object(object(item).lowest_silver).monthly_cents),
            ),
          )
        : null,
      status: targetKnown ? "calculated" : "unknown",
    },
    data_generation: raw.data_generation ?? null,
    provenance: compact ? projected.provenance : (raw.provenance ?? null),
  };
  if (compact) answer.evidence_pagination = projected.evidence_pagination;
  if (compact && !("members" in input)) {
    const query = new URLSearchParams({
      zip: input.zip,
      ...(input.county ? { county: input.county } : {}),
      year: String(input.year),
      preset: input.preset,
      data_generation: generation,
    });
    answer.manifest_href = `/handy/allowance/manifest?${query}`;
    const pagination = object(answer.evidence_pagination);
    pagination.next_href =
      pagination.next_page === null
        ? null
        : `${answer.manifest_href}&evidence_page=${pagination.next_page}`;
  }
  if ("allowance_cents" in input && typeof input.allowance_cents === "number") {
    const target = object(answer.target);
    let fundingStatus = "unknown";
    if (target.status === "calculated")
      fundingStatus =
        input.allowance_cents >= Number(target.monthly_cents)
          ? "funded"
          : "unfunded";
    answer.funding = {
      allowance_cents: input.allowance_cents,
      status: fundingStatus,
    };
  }
  return answer;
}
