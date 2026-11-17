type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const pick = (value: unknown, fields: readonly string[]) => {
  const source = row(value);
  return Object.fromEntries(
    fields
      .filter((field) => source[field] !== undefined)
      .map((field) => [field, source[field]]),
  );
};
const rows = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Source coordinates replace payloads; the manifest pins each snapshot's content hash. */
export function allowanceEvidence(value: unknown) {
  const source = row(value);
  const catalog = row(source.catalog);
  const references = new Map<string, Row>();
  const add = (reference: Row) =>
    references.set(JSON.stringify(reference), reference);
  const walk = (value: unknown, inherited?: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, inherited);
      return;
    }
    const item = row(value);
    const provenance = row(item.provenance);
    const snapshot =
      item.snapshot_id ??
      item.attribute_snapshot_id ??
      item.snapshotId ??
      item.publication_snapshot_id ??
      provenance.snapshot_id ??
      provenance.snapshotId ??
      inherited;
    const sourceRow = item.source_row ?? provenance.sourceRowNumber;
    if (typeof snapshot === "string") {
      add({
        snapshot_id: snapshot,
        ...(Number.isSafeInteger(sourceRow) ? { source_row: sourceRow } : {}),
      });
      for (const sourceRow of rows(item.source_rows))
        if (Number.isSafeInteger(sourceRow))
          add({
            snapshot_id:
              typeof item.attribute_snapshot_id === "string"
                ? item.attribute_snapshot_id
                : snapshot,
            source_row: sourceRow,
          });
    }
    if (
      typeof item.publication_snapshot_id === "string" &&
      item.source_record !== undefined
    )
      add(
        pick(item, [
          "publication_snapshot_id",
          "source_sha256",
          "source_record",
          "column",
        ]),
      );
    if (typeof provenance.sourceSha256 === "string")
      add(pick(provenance, ["sourceUrl", "sourceSha256", "sourceRecord"]));
    if (typeof item.source_sha256 === "string")
      add(
        pick(item, [
          "source_sha256",
          "source_record",
          "column",
          "reference",
          "source_locator",
          "citation",
          "reviewed_on",
        ]),
      );
    for (const [key, child] of Object.entries(item)) {
      if (key === "raw" || key === "raw_record") continue;
      if (item === source && key === "attributes") {
        // Filed catalogs identify detail rows through each entry's exchange evidence.
        if (!Array.isArray(source.filed_entries))
          walk(
            child,
            typeof catalog.snapshot_id === "string"
              ? catalog.snapshot_id
              : undefined,
          );
        continue;
      }
      if (key === "snapshot_ids") {
        for (const id of Object.values(row(child)))
          if (typeof id === "string") add({ snapshot_id: id });
      } else walk(child, typeof snapshot === "string" ? snapshot : inherited);
    }
  };
  walk(source);
  const rating = row(source.rating);
  const rule = row(rating.provenance).rating_rule;
  return {
    catalog: pick(catalog, ["plan_id", "snapshot_id", "source_row"]),
    source_refs: [...references.values()],
    exclusion: source.exclusion ?? null,
    refused: pick(source.refused, [
      "reason",
      "state",
      "plan_year",
      "plan_id",
      "region",
    ]),
    rating:
      source.rating === undefined
        ? null
        : {
            ...pick(rating, [
              "status",
              "reason",
              "total_cents",
              "rating_area_id",
              "quote_method",
              "coverage_start",
              "currency",
              "period",
            ]),
            rating_rule: pick(rule, ["snapshot_id", "method", "citation"]),
            members: rows(rating.members).map((member) =>
              pick(member, [
                "member_id",
                "age",
                "relationship",
                "tobacco",
                "charged",
                "status",
                "premium_cents",
              ]),
            ),
            issues: rows(rating.issues).map((issue) =>
              pick(issue, ["member_id", "status", "reason"]),
            ),
          },
  };
}

export function allowanceBenchmark(value: unknown) {
  const source = row(value);
  return {
    ...pick(source, [
      "status",
      "year",
      "coverage_start",
      "location",
      "rating_area_id",
      "slcsp_monthly_cents",
      "benchmark_plan_ids",
      "silver_plan_count",
      "issues",
      "quote_method",
      "bindable_quote",
    ]),
    lowest_silver_plans: rows(source.lowest_silver_plans).map((plan) =>
      pick(plan, [
        "plan_id",
        "gross_monthly_cents",
        "ehb_monthly_cents",
        "benchmark_monthly_cents",
        "pediatric_dental_adjustment_cents",
        "ehb_fraction",
      ]),
    ),
    pediatric_dental:
      source.pediatric_dental === null
        ? null
        : pick(source.pediatric_dental, ["monthlyCents", "planIds", "issues"]),
    source_refs: allowanceEvidence(value).source_refs,
  };
}
