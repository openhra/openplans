type Row = Record<string, unknown>;
export const object = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(object) : [];
export const pick = (value: unknown, keys: readonly string[]) => {
  const source = object(value);
  return Object.fromEntries(
    keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
};

export const EVIDENCE_PAGE_SIZE = 2;
export const MAX_ALLOWANCE_BYTES = 64 * 1024;

/** Build the response once, before the host's independent size and disclosure checks. */
export function allowanceJson(value: unknown) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > MAX_ALLOWANCE_BYTES)
    throw new Error("RESULT_TOO_LARGE");
  return text;
}

function point(value: unknown) {
  if (value === null || value === undefined) return null;
  const source = object(value);
  const refs = Array.isArray(source.evidence_refs) ? source.evidence_refs : [];
  return {
    ...pick(source, [
      "rank",
      "denominator",
      "monthly_cents",
      "plan_id",
      "tied_plan_count",
    ]),
    evidence_refs: refs.slice(0, 1),
    tied_evidence_count: refs.length,
  };
}

/** Absolute evidence indices stay valid across every page in one pinned manifest. */
export function distributionPage(raw: Row, page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000)
    throw new Error("INVALID_EVIDENCE_PAGE");
  const provenance = object(raw.provenance);
  const evidence: unknown[] = Array.isArray(provenance.evidence)
    ? provenance.evidence
    : [];
  const profiles = rows(raw.profiles);
  const snapshots = new Map(
    rows(provenance.snapshots).map((entry) => [
      entry.snapshot_id,
      entry.sha256,
    ]),
  );
  for (const source of evidence) {
    for (const ref of rows(object(source).source_refs)) {
      const id = ref.snapshot_id ?? ref.publication_snapshot_id;
      if (
        typeof id === "string" &&
        (typeof snapshots.get(id) !== "string" || !snapshots.get(id))
      )
        throw new Error("EVIDENCE_SNAPSHOT_MISSING");
    }
  }
  const requireRef = (ref: unknown) => {
    if (
      !Number.isSafeInteger(ref) ||
      Number(ref) < 0 ||
      Number(ref) >= evidence.length ||
      evidence[Number(ref)] === undefined
    )
      throw new Error("EVIDENCE_REFERENCE_MISSING");
  };
  const validatePoint = (value: unknown) => {
    const point = object(value);
    const refs = point.evidence_refs;
    if (
      raw.evidence_format === "source-references-v1" &&
      typeof point.monthly_cents === "number" &&
      (!Array.isArray(refs) || !refs.length)
    )
      throw new Error("EVIDENCE_REFERENCE_MISSING");
    if (Array.isArray(refs)) refs.forEach(requireRef);
    if (
      raw.evidence_format === "source-references-v1" &&
      typeof point.plan_id === "string" &&
      Array.isArray(refs) &&
      object(object(evidence[Number(refs[0])]).catalog).plan_id !==
        point.plan_id
    )
      throw new Error("EVIDENCE_PLAN_MISMATCH");
  };
  const start = (page - 1) * EVIDENCE_PAGE_SIZE;
  const shown = (value: unknown) =>
    rows(value)
      .filter(
        (entry) =>
          Number(entry.evidence_ref) >= start &&
          Number(entry.evidence_ref) < start + EVIDENCE_PAGE_SIZE,
      )
      .map((entry) =>
        pick(entry, [
          "plan_id",
          "monthly_cents",
          "status",
          "reason",
          "evidence_ref",
        ]),
      );
  for (const profile of profiles) {
    validatePoint(profile.lowest_silver);
    validatePoint(profile.median_gold);
    for (const group of rows(profile.metals)) {
      for (const entry of [...rows(group.candidates), ...rows(group.excluded)])
        requireRef(entry.evidence_ref);
      Object.values(object(group.points)).forEach(validatePoint);
    }
  }
  rows(provenance.excluded).forEach((entry) => requireRef(entry.evidence_ref));
  return {
    profiles: profiles.map((profile) => ({
      ...pick(profile, ["id", "status", "members"]),
      lowest_silver: point(profile.lowest_silver),
      median_gold: point(profile.median_gold),
      metals: rows(profile.metals).map((group) => ({
        ...pick(group, [
          "metal",
          "status",
          "reasons",
          "counts",
          "completeness",
        ]),
        points: Object.fromEntries(
          Object.entries(object(group.points)).map(([key, value]) => [
            key,
            point(value),
          ]),
        ),
        candidates: shown(group.candidates),
        excluded: shown(group.excluded),
      })),
    })),
    provenance: {
      ...pick(provenance, ["input_manifest", "manifest", "rules_version"]),
      snapshots: rows(provenance.snapshots).map((snapshot) =>
        pick(snapshot, [
          "snapshot_id",
          "publisher",
          "url",
          "sha256",
          "validation_state",
        ]),
      ),
      evidence: evidence
        .slice(start, start + EVIDENCE_PAGE_SIZE)
        .map((value, index) => ({
          evidence_ref: start + index,
          source: value,
        })),
      excluded: shown(provenance.excluded),
    },
    evidence_pagination: {
      page,
      page_size: EVIDENCE_PAGE_SIZE,
      total: evidence.length,
      next_page: start + EVIDENCE_PAGE_SIZE < evidence.length ? page + 1 : null,
      reference_scope: "absolute_index_in_generation_manifest",
    },
  };
}
