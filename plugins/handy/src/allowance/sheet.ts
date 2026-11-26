type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
const esc = (value: unknown) =>
  String(value ?? "Unknown").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
const money = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0
    ? `$${(Number(value) / 100).toFixed(2)}`
    : "Unknown";
const tobaccoLabel = (value: unknown) => {
  if (value === true) return "tobacco";
  if (value === false) return "non-tobacco";
  return "tobacco unknown";
};
const names: Record<string, string> = {
  employee_only: "Employee only",
  employee_spouse: "Employee + spouse",
  employee_spouse_child: "Employee + spouse + 1 child",
  employee_spouse_children: "Employee + spouse + 2 children",
};
const metals = ["bronze", "silver", "gold"] as const;

function point(profile: Row, metal: string, statistic: "minimum" | "median") {
  const group = (Array.isArray(profile.metals) ? profile.metals : [])
    .map(row)
    .find((item) => item.metal === metal);
  return row(row(group?.points)[statistic]).monthly_cents;
}

function targetHelp(answer: Row): string {
  if (answer.reason === "required_profile_missing")
    return "The allowance target is unknown because a required preset profile is missing. All four profiles are needed.";
  if (row(answer.target).status !== "calculated")
    return "The allowance target is unknown because at least one profile has no known lowest Silver price.";
  return "The allowance target uses gross premiums before subsidies.";
}

/** Render the already-calculated allowance DTO. This function never calls a price reader. */
export function printAllowanceSheet(
  answer: Row,
  manifestHref: string,
  paper: "letter" | "A4" = "letter",
) {
  const profiles = (Array.isArray(answer.profiles) ? answer.profiles : []).map(
    row,
  );
  const rows = profiles
    .map((profile) => {
      const members = (Array.isArray(profile.members) ? profile.members : [])
        .map(row)
        .map(
          (member) =>
            `${esc(member.relationship)} ${esc(member.age)}, ${tobaccoLabel(member.tobacco)}`,
        )
        .join("; ");
      return `<tr><th scope="row">${esc(names[String(profile.id)] ?? profile.id)}<small>${members || "Members unknown"}</small></th>${metals.map((metal) => `<td>${money(point(profile, metal, metal === "gold" ? "median" : "minimum"))}</td>`).join("")}</tr>`;
    })
    .join("");
  const location = row(answer.location);
  const slcsp = new Map(
    (Array.isArray(answer.slcsp) ? answer.slcsp : []).map((item) => {
      const entry = row(item);
      return [entry.profile_id, row(entry.result)];
    }),
  );
  const expanded = profiles
    .map((profile) => {
      const bronze = (Array.isArray(profile.metals) ? profile.metals : [])
        .map(row)
        .find((item) =>
          ["expanded_bronze", "expanded bronze"].includes(
            String(item.metal).toLowerCase(),
          ),
        );
      return `<li>${esc(names[String(profile.id)] ?? profile.id)}: ${money(row(row(bronze?.points).minimum).monthly_cents)}</li>`;
    })
    .join("");
  const benchmarks = profiles
    .map((profile) => {
      const benchmark = slcsp.get(profile.id);
      return `<li>${esc(names[String(profile.id)] ?? profile.id)}: ${money(benchmark?.slcsp_monthly_cents)} (${esc(benchmark?.status)})</li>`;
    })
    .join("");
  const evidence = [
    ...(Array.isArray(row(answer.provenance).evidence)
      ? (row(answer.provenance).evidence as unknown[])
      : []
    ).map(row),
    ...profiles.flatMap((profile) =>
      (Array.isArray(profile.metals) ? profile.metals : [])
        .map(row)
        .flatMap((group) =>
          Array.isArray(group.evidence) ? group.evidence.map(row) : [],
        ),
    ),
  ];
  const counts = profiles.flatMap((profile) =>
    (Array.isArray(profile.metals) ? profile.metals : [])
      .map(row)
      .map((group) => {
        const groupCounts = row(group.counts);
        return `${String(profile.id)} ${String(group.metal)}: eligible ${String(groupCounts.eligible ?? "Unknown")}, excluded ${String(groupCounts.excluded ?? "Unknown")}, unknown ${String(groupCounts.unknown ?? "Unknown")}`;
      }),
  );
  const evidenceIds = [
    ...new Set(
      evidence
        .map((item) => item.source_file ?? item.snapshot_id ?? item.file_id)
        .filter((value) => typeof value === "string"),
    ),
  ];
  const provenance = row(answer.provenance);
  const snapshots = (
    Array.isArray(provenance.snapshots) ? provenance.snapshots : []
  ).map(row);
  const snapshotIds = snapshots.map((snapshot) => {
    const id = String(snapshot.snapshot_id ?? snapshot.sha256 ?? "");
    return `${String(snapshot.publisher ?? "source")}:${id ? id.slice(0, 12) : "Unknown"}`;
  });
  const unknownEvidenceIds = evidence
    .filter((item) => item.status === "unknown")
    .map((item) => item.source_file ?? item.snapshot_id ?? item.file_id)
    .filter((value): value is string => typeof value === "string");
  const sourceRefs = [
    ...new Set([
      ...snapshotIds.slice(0, 1),
      ...unknownEvidenceIds,
      ...snapshotIds.slice(1),
      ...evidenceIds,
    ]),
  ];
  const visibleSourceRefs = sourceRefs.slice(0, 2);
  const additionalSourceCount = sourceRefs.length - visibleSourceRefs.length;
  const groups = profiles.flatMap((profile) =>
    (Array.isArray(profile.metals) ? profile.metals : []).map(row),
  );
  const unknownPresent =
    evidence.some((item) => item.status === "unknown") ||
    row(answer.target).status !== "calculated" ||
    profiles.length !== 4 ||
    profiles.some((profile) => profile.status === "unknown") ||
    groups.some((group) => {
      const groupCounts = row(group.counts);
      const completeness = row(group.completeness);
      return (
        group.status === "unknown" ||
        (typeof groupCounts.unknown === "number" && groupCounts.unknown > 0) ||
        completeness.catalog === "incomplete" ||
        completeness.rates === "incomplete"
      );
    });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenPlans allowance range</title><style>
*{box-sizing:border-box}body{font:10pt/1.35 system-ui,sans-serif;color:#111;background:#fff;max-width:8.5in;margin:auto;padding:.25in}h1{font-size:18pt;margin:0 0 .15in}h2{font-size:11pt;margin:.12in 0 .04in}p{margin:.04in 0}.meta{font-size:9pt}table{border-collapse:collapse;width:100%;margin:.1in 0}th,td{text-align:left;border:1px solid #555;padding:.06in;vertical-align:top}thead{display:table-header-group}small{display:block;font-size:7.5pt;font-weight:normal}ul{margin:.03in 0;padding-left:.2in}.warning{border:1px solid #222;padding:.07in;font-weight:600;break-inside:avoid;page-break-inside:avoid}a{color:#111;overflow-wrap:anywhere}.sources{font-size:8pt}@page{size:${paper};margin:0.45in}@media print{body{max-width:none;margin:0;padding:0;font-size:9pt}tr{break-inside:avoid}h2{break-after:avoid}a{color:#111;text-decoration:none}}</style></head><body><h1>OpenPlans allowance range</h1><p class="meta">ZIP ${esc(location.zip)} · County ${esc(location.county)} · Plan year ${esc(answer.year)} · Coverage starts January 1</p><p class="meta">Gross monthly premiums · on-exchange individual medical · Generated ${esc(answer.generated_at ?? "Unknown")} UTC · Generation ${esc(answer.data_generation)}</p><p class="meta">Illustrative product profiles, not employee records. Preset ${esc(answer.preset)} (${esc(answer.preset_origin)}). Four displayed age profiles use the ages and tobacco assumptions shown in each row.</p><table><caption>Monthly premium targets by household profile</caption><thead><tr><th scope="col">Household and members</th><th scope="col">Lowest bronze</th><th scope="col">Lowest silver</th><th scope="col">Median gold</th></tr></thead><tbody>${rows || '<tr><td colspan="4">Unknown: profile rows unavailable</td></tr>'}</tbody></table><h2>Expanded bronze minimum</h2><ul>${expanded || "<li>Unknown</li>"}</ul><p>A null amount means the price is unknown. Only a filed zero is $0. Gross premiums are not the subsidy benchmark.</p><h2>Adjusted SLCSP context</h2><ul>${benchmarks || "<li>Unknown</li>"}</ul><p><strong>Allowance to fund all four lowest-silver targets:</strong> ${money(row(answer.target).monthly_cents)} (${esc(row(answer.target).status)}; ${esc(row(answer.target).profile_count)} profiles, denominator ${esc(row(answer.target).denominator)}).</p><p>${targetHelp(answer)}</p>${answer.funding ? `<p>Private scenario allowance ${money(row(answer.funding).allowance_cents)}: ${esc(row(answer.funding).status)}.</p>` : ""}<h2>Eligible-plan counts and exclusions</h2><p class="sources">${counts.map(esc).join(" · ") || "Unknown"}</p><h2>Sources and evidence</h2><p class="sources">Source files / snapshots: ${visibleSourceRefs.length ? visibleSourceRefs.map(esc).join(", ") : "Unknown"}${additionalSourceCount ? `, ${additionalSourceCount} more in the manifest` : ""}. Rules: ${esc(provenance.rules_version ?? "See source manifest")}. Manifest digest: ${esc(provenance.manifest_digest ?? provenance.input_manifest ?? provenance.manifest)}.</p><p><a href="${esc(manifestHref)}">Download source manifest (JSON)</a></p><p class="sources">If the source download returns data_changed, the source data has changed. Restart the sheet to use current prices and sources together.</p><p class="warning">${unknownPresent ? "Unknown evidence is present. No missing amount has been estimated." : "Premium funding only. Affordability and benefits are separate checks."}</p><p class="sources">Premium funding only. Affordability and benefits are separate checks.</p><p class="sources">A profile result describes only the ages printed here. It does not represent the employees in a workforce or establish affordability, benefits, or provider participation.</p></body></html>`;
}

/** A small, explicit projection for downloading the provenance attached to this result. */
export function allowanceSourceManifest(answer: Row) {
  return {
    schema_version: "1",
    plan_year: answer.year ?? null,
    location: answer.location ?? null,
    data_generation: answer.data_generation ?? null,
    preset: answer.preset ?? null,
    provenance: answer.provenance ?? null,
    benchmarks: answer.slcsp ?? [],
    ...(answer.evidence_pagination
      ? {
          evidence_pagination: answer.evidence_pagination,
          manifest_href: answer.manifest_href,
        }
      : {}),
    profile_evidence: (Array.isArray(answer.profiles)
      ? answer.profiles
      : []
    ).map((value) => {
      const profile = row(value);
      return {
        profile_id: profile.id ?? null,
        members: profile.members ?? [],
        evidence: (Array.isArray(profile.metals) ? profile.metals : [])
          .map(row)
          .map((group) => ({
            metal: group.metal ?? null,
            counts: group.counts ?? null,
            completeness: group.completeness ?? null,
            reasons: group.reasons ?? [],
            points: group.points ?? null,
            candidates: group.candidates ?? [],
            excluded: group.excluded ?? [],
            evidence: group.evidence ?? [],
          })),
      };
    }),
  };
}

/** Explain a stale browser result while preserving the machine-readable code. */
export function printAllowanceChanged(restartHref: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Restart the allowance sheet</title></head><body><h1>Restart the allowance sheet</h1><p>The source data has changed. Restart the sheet to use current prices and sources together.</p><p><a href="${esc(restartHref)}">Restart the sheet</a></p><p>Code: <code>data_changed</code></p></body></html>`;
}
