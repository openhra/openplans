/** Pure HIOS/QHP matching helpers. Syntax and fixture joins do not prove real coverage. */
export type HiosId = { base: string; variant: string | null; full: string };
export type JsonRecord = Record<string, unknown>;

const HIOS = /^([0-9]{5}[A-Z]{2}[0-9]{7})(?:-([0-9]{2}))?$/;

export function parse_hios(value: unknown): HiosId {
  if (typeof value !== "string") throw new Error("HIOS identifier must be a string");
  const match = HIOS.exec(value);
  if (!match) throw new Error("Expected a 14-character base HIOS ID or a 17-character variant ID");
  return { base: match[1]!, variant: match[2] ?? null, full: value };
}

export function validate_year(year: unknown): asserts year is number {
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error("An explicit integer plan year is required");
}

export function classify_index(value: JsonRecord): string {
  const keys = ["plan_urls", "provider_urls", "formulary_urls"];
  if (keys.every(k => Array.isArray(value[k]))) {
    if (!keys.every(k => (value[k] as unknown[]).every(url => typeof url === "string"))) return "unknown";
    return "qhp_index";
  }
  if (["reporting_structure", "in_network", "out_of_network"].some(k => k in value)) return "transparency_in_coverage";
  return "unknown";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(n => typeof n === "number" && Number.isInteger(n));
}
function applicable(record: JsonRecord, hios: HiosId, year: number): boolean {
  return record.plan_id_type === "HIOS-PLAN-ID" && record.plan_id === hios.base && integerArray(record.years) && record.years.includes(year);
}
function optional_bool(record: JsonRecord, key: string): boolean | null {
  const value = record[key];
  if (value == null) return null;
  if (typeof value !== "boolean") throw new Error(`${key} must be a JSON boolean or null, not a string or number`);
  return value;
}

export function build_plan_view(plan_id: unknown, year: unknown, plans: JsonRecord[], providers: JsonRecord[], drugs: JsonRecord[], options: { source_snapshot: string }): JsonRecord {
  const hios = parse_hios(plan_id);
  validate_year(year);
  if (!options.source_snapshot) throw new Error("A source_snapshot identifier is required");
  const matches = plans.filter(p => applicable(p, hios, year));
  if (matches.length !== 1) throw new Error(`Expected one plan definition for year/base ID; found ${matches.length}`);
  const plan = matches[0]!;
  const tierSet = (key: string) => new Set((Array.isArray(plan[key]) ? plan[key] as unknown[] : [])
    .filter(isRecord).map(x => x[key === "network" ? "network_tier" : "drug_tier"]).filter(x => x != null));
  const networkTiers = tierSet("network"), drugTiers = tierSet("formulary");
  const providerRows: JsonRecord[] = [], drugRows: JsonRecord[] = [], issues: JsonRecord[] = [];
  const eligibleEdges = function* (kind: string, index: number, record: JsonRecord): Generator<JsonRecord> {
    const edges = record.plans ?? [];
    if (!Array.isArray(edges)) { issues.push({ kind, record: index, code: "invalid_plans_array" }); return; }
    for (const edge of edges) {
      if (!isRecord(edge)) { issues.push({ kind, record: index, code: "invalid_plan_edge" }); continue; }
      if (edge.plan_id_type !== "HIOS-PLAN-ID" || edge.plan_id !== hios.base) continue;
      if (!integerArray(edge.years)) { issues.push({ kind, record: index, code: "missing_or_invalid_years" }); continue; }
      if (edge.years.includes(year)) yield edge;
    }
  };
  providers.forEach((provider, i) => {
    for (const edge of eligibleEdges("provider", i, provider)) {
      const tier = edge.network_tier;
      if (typeof tier !== "string" || !networkTiers.has(tier)) { issues.push({ kind: "provider", record: i, code: "unresolved_network_tier" }); continue; }
      const npi = provider.npi;
      if (npi != null && (typeof npi !== "string" || !/^[0-9]{10}$/.test(npi))) { issues.push({ kind: "provider", record: i, code: "invalid_npi_shape" }); continue; }
      providerRows.push({ npi: npi ?? null, source_record_key: `${options.source_snapshot}:provider:${i}`, name: provider.name ?? provider.facility_name,
        provider_type: provider.type, network_tier: tier, status: "listed_participating", participation_scope: "provider_record",
        addresses_from_record: provider.addresses ?? [], location_specific_participation_verified: false, source_updated_at: provider.last_updated_on });
    }
  });
  drugs.forEach((drug, i) => {
    for (const edge of eligibleEdges("drug", i, drug)) {
      const tier = edge.drug_tier;
      if (typeof tier !== "string" || !drugTiers.has(tier)) { issues.push({ kind: "drug", record: i, code: "unresolved_drug_tier" }); continue; }
      const rxcui = drug.rxnorm_id;
      if (typeof rxcui !== "string" || !/^[0-9]+$/.test(rxcui)) { issues.push({ kind: "drug", record: i, code: "invalid_rxcui_shape" }); continue; }
      let restrictions: Record<string, boolean | null>;
      try { restrictions = Object.fromEntries(["prior_authorization", "step_therapy", "quantity_limit"].map(k => [k, optional_bool(edge, k)])); }
      catch { issues.push({ kind: "drug", record: i, code: "invalid_restriction_boolean" }); continue; }
      drugRows.push({ rxcui, drug_name: drug.drug_name, drug_tier: tier, status: "listed_covered", ...restrictions,
        source_record_key: `${options.source_snapshot}:drug:${i}`, source_updated_at: drug.last_updated_on, patient_price: null });
    }
  });
  return { plan_year: year, base_hios_id: hios.base, requested_variant_hios_id: hios.variant === null ? null : hios.full,
    membership_evidence_scope: "base_plan", variant_cost_sharing_resolved: false, source_snapshot: options.source_snapshot,
    source_completeness: "not_asserted_by_reference_joiner", providers: providerRows, drugs: drugRows, issues };
}

export function lookup_evidence(rows: JsonRecord[], key: string, value: unknown): JsonRecord {
  const matches = rows.filter(row => row[key] === value).map(row => ({ ...row }));
  return { status: matches.length ? matches[0]!.status : "unknown", matches };
}
