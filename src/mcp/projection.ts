import type { SqlSession } from "../db/database.js";
import { getSnapshot } from "../services/provenance.js";
import type { HonestyContext } from "./schemas.js";
import { ToolError } from "./cursor.js";
import { countyState } from "../api/repository.js";
import { entityId } from "../services/discovery.js";

export type Row = Record<string, unknown>;
export const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
export const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(row) : [];
export const nullable = (value: unknown) => value ?? null;
export const date = (value: unknown): string | null =>
  value ? new Date(String(value)).toISOString() : null;
const url = (value: unknown) =>
  typeof value === "string" && /^(https:\/\/|openplans:)/.test(value)
    ? value
    : null;

function snapshotIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((child) => snapshotIds(child, ids));
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "snapshot_id" || key.endsWith("_snapshot_id")) &&
        typeof child === "string"
      )
        ids.add(child);
      else if (key === "snapshot_ids" && child && typeof child === "object") {
        for (const id of Object.values(child))
          if (typeof id === "string") ids.add(id);
      } else if (key.endsWith("_snapshot_ids") && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string") ids.add(id);
      } else snapshotIds(child, ids);
    }
  return ids;
}

/** A request-local projection: only columns already published by the read services can enter a DTO. */
export async function projector(db: SqlSession, native: unknown) {
  const ids = [...snapshotIds(native)];
  if (ids.length > 100) throw new ToolError("RESULT_TOO_LARGE");
  const metadata = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof getSnapshot>>>
  >();
  for (const id of ids) {
    const snapshot = await getSnapshot(db, id);
    if (snapshot) metadata.set(id, snapshot);
  }
  const sources = new Map<string, Row>();
  function evidence(value: unknown, fallback: unknown = null) {
    const r = row(value),
      references = [...snapshotIds(value)];
    if (!references.length) references.push(...snapshotIds(fallback));
    const refs: string[] = [];
    for (const snapshot_id of references) {
      const source = metadata.get(snapshot_id);
      if (!source) continue;
      let pointer;
      if (r.source_record !== undefined) {
        pointer = `record:${r.source_record}${r.source_plan_index === undefined ? "" : `:plan:${r.source_plan_index}`}`;
      } else if (r.source_row !== undefined) {
        pointer = `row:${r.source_row}`;
      } else {
        pointer = null;
      }
      const id = pointer ? `${snapshot_id}#${pointer}` : snapshot_id;
      sources.set(id, {
        id,
        snapshot_id,
        publisher: source.publisher,
        url: url(source.url),
        sha256: source.sha256,
        retrieved_at: date(source.retrieved_at),
        publisher_updated_at: date(source.publisher_updated_at),
        record_ref: pointer,
        status: "available",
      });
      refs.push(id);
    }
    return {
      evidence_refs: refs,
      gaps: refs.length ? [] : ["SOURCE_METADATA_UNAVAILABLE"],
    };
  }
  function plan(value: unknown) {
    const r = row(value),
      sharing = row(r.cost_sharing);
    const key =
      r.plan_key ??
      (String(r.base_plan_id).includes(":") ? r.base_plan_id : null);
    return {
      kind: "plan",
      plan_ref: key ?? r.base_plan_id,
      hios_id: key ? nullable(r.hios_id) : r.base_plan_id,
      plan_key: key,
      year: r.plan_year,
      name: r.plan_name,
      metal: nullable(r.metal),
      on_exchange:
        typeof r.on_exchange === "boolean" ? r.on_exchange : "unknown",
      selected_variant_id: nullable(sharing.selected_variant_id),
      cost_sharing_status: sharing.status ?? "unknown",
      enrollment_eligibility: "unknown",
      ...evidence(value),
    };
  }
  function address(value: unknown, parent: unknown) {
    const r = row(value);
    return {
      kind: "address",
      line_1: nullable(r.line_1 ?? r.address ?? r.street_address),
      line_2: nullable(r.line_2 ?? r.address_2 ?? r.street_address2),
      city: nullable(r.city),
      state: nullable(r.state),
      zip: nullable(r.zip ?? r.zip5),
      distance_miles: nullable(r.distance_miles),
      precision: nullable(r.precision),
      point:
        r.latitude !== null &&
        r.latitude !== undefined &&
        r.longitude !== null &&
        r.longitude !== undefined
          ? {
              latitude: Number(r.latitude),
              longitude: Number(r.longitude),
              method: r.method,
              ...evidence(value, parent),
            }
          : null,
      ...evidence(value, parent),
    };
  }
  function provider(value: unknown, identity = false) {
    const r = row(value),
      addresses = rows(r.addresses);
    const publishedName = row(r.name);
    return {
      kind: "provider",
      record_id: r.record_id ?? r.npi,
      npi: nullable(r.npi),
      name:
        r.organization_name ??
        r.facility_name ??
        r.group_name ??
        (typeof r.name === "string" ? r.name : null) ??
        ([
          publishedName.first ?? publishedName.first_name ?? r.first_name,
          publishedName.last ?? publishedName.last_name ?? r.last_name,
        ]
          .filter(Boolean)
          .join(" ") ||
          null),
      participation: r.participation ?? "not_evaluated",
      participation_scope:
        identity || !(r.participation_scope || r.source_set_id)
          ? "identity"
          : "provider_record",
      nearest_address: addresses.length ? address(addresses[0], value) : null,
      addresses_total: addresses.length,
      ...evidence(value),
    };
  }
  const drugs: Row[] = [];
  function drug(value: unknown) {
    const r = row(value);
    drugs.push(r);
    return {
      kind: "drug",
      rxcui: r.rxcui,
      name: r.name,
      tty: r.tty,
      suppress: r.suppress,
      ...evidence(value),
    };
  }
  function geography(value: unknown) {
    const r = row(value);
    return {
      kind: "geography",
      county_fips: r.county_fips,
      state: countyState(String(r.county_fips)),
      name: nullable(r.county_name),
      source_method: r.source ?? "zcta",
      centroid: null,
      approximate: r.source === "geonames",
      ...evidence(value),
    };
  }
  function directory(value: unknown, kind: "carriers" | "networks") {
    const r = row(value),
      entity = kind === "carriers" ? "carrier" : "network";
    return {
      kind: entity,
      id: entityId(
        entity,
        String(r.state),
        Number(r.plan_year),
        String(r.issuer_id),
        kind === "networks" ? String(r.network_id) : "_",
        Number(r.source_row),
      ),
      issuer_id: r.issuer_id,
      state: r.state,
      year: r.plan_year,
      network_id: nullable(r.network_id),
      name:
        r.network_name ??
        (Array.isArray(r.marketing_names)
          ? r.marketing_names.join("; ")
          : r.marketing_names) ??
        null,
      network_url: url(r.network_url),
      dental_only: nullable(r.dental_only),
      ...evidence(value),
    };
  }
  function dataset(value: unknown, capability: string) {
    function coverageForCapability() {
      if (capability === "drugs") {
        return r.drug_coverage;
      } else if (capability === "providers") {
        return r.provider_coverage;
      } else {
        return null;
      }
    }
    const r = row(value),
      detail = row(coverageForCapability());
    function capabilityStatusPrefix() {
      if (capability === "catalog") {
        return "catalog";
      } else if (capability === "premiums") {
        return "premium";
      } else {
        return capability;
      }
    }
    const status =
      detail.status ?? r[`${capabilityStatusPrefix()}_status`] ?? "unknown";
    const snapshot =
      detail.active_snapshot_id ??
      detail.snapshot_id ??
      (capability === "premiums" ? r.rate_snapshot_id : null) ??
      r.snapshot_id;
    const source = metadata.get(String(snapshot));
    return {
      kind: "dataset",
      state: nullable(r.state),
      year: nullable(r.plan_year),
      issuer_id: nullable(r.issuer_id),
      capability,
      status,
      active_snapshot_id: nullable(snapshot),
      latest_snapshot_id: detail.snapshot_id ?? snapshot ?? null,
      retrieved_at: date(source?.retrieved_at),
      publisher_updated_at: date(source?.publisher_updated_at),
      reason: detail.reason ?? r.premium_reason ?? null,
      ...evidence({ ...r, ...detail }),
    };
  }
  function coverage(value: unknown, completeness: unknown) {
    const r = row(value);
    return {
      kind: "drug_coverage",
      plan_id: r.requested_plan_id,
      rxcui: r.rxcui,
      year: r.plan_year,
      status: r.status,
      tier: nullable(r.drug_tier),
      tier_status: nullable(r.tier_status),
      prior_authorization: nullable(r.prior_authorization),
      step_therapy: nullable(r.step_therapy),
      quantity_limit: nullable(r.quantity_limit),
      patient_price: null,
      source_completeness: completeness ?? "unknown",
      evidence: rows(r.evidence).map((e) => ({
        status: e.evidence_status,
        tier: nullable(e.drug_tier),
        tier_status: nullable(e.tier_status),
        prior_authorization: nullable(e.prior_authorization),
        step_therapy: nullable(e.step_therapy),
        quantity_limit: nullable(e.quantity_limit),
        ...evidence(e),
      })),
      ...evidence(value),
    };
  }
  function participation(value: unknown, completeness: unknown) {
    const r = row(value);
    return {
      kind: "participation",
      plan_id: r.requested_plan_id,
      npi: r.identity,
      year: r.plan_year,
      status: r.status,
      scope: "provider_record",
      address_participation: "not_evaluated",
      source_completeness: completeness ?? "unknown",
      evidence: rows(r.evidence).map((e) => ({
        status: e.evidence_status,
        record_id: e.record_id,
        network_tier: e.network_tier,
        tier_status: e.tier_status,
        ...evidence(e),
      })),
      ...evidence(value),
    };
  }
  /** A public quote: the estimate view plus the shared coverage and participation views. */
  function quote(
    value: unknown,
    completeness: (
      planId: string,
      kind: "drug_coverage" | "provider_coverage",
    ) => unknown,
  ) {
    const q = row(value);
    return {
      ...estimate(value),
      kind: "quote",
      providers: rows(q.providers).map((r) =>
        participation(
          r,
          completeness(String(r.requested_plan_id), "provider_coverage"),
        ),
      ),
      drugs: rows(q.drugs).map((r) =>
        coverage(r, completeness(String(r.requested_plan_id), "drug_coverage")),
      ),
    };
  }
  function snapshot(id: string) {
    const s = metadata.get(id);
    if (!s) throw new ToolError("SNAPSHOT_NOT_FOUND");
    return {
      kind: "snapshot",
      ...s,
      url: url(s.url),
      bytes: s.bytes === null ? null : String(s.bytes),
      retrieved_at: date(s.retrieved_at),
      publisher_updated_at: date(s.publisher_updated_at),
      ...evidence({ snapshot_id: id }),
    };
  }
  function benefit(value: unknown, parent: unknown) {
    const r = row(value);
    const variant =
      rows(row(parent).variants).find(
        (v) => v.variant_plan_id === r.published_plan_id,
      ) ?? {};
    return {
      kind: "benefit",
      variant_id: r.published_plan_id,
      name: r.benefit_name,
      cost_sharing_text: Object.entries(row(r.cost_sharing_raw)).map(
        ([field, raw]) => {
          const parsed = row(row(r.cost_sharing_parsed)[field]);
          return {
            field,
            raw,
            parsed_cents: parsed.cents ?? null,
            parse_status:
              typeof parsed.cents === "number" ? "available" : "unknown",
          };
        },
      ),
      accumulators: Object.entries({
        ...row(variant.deductibles),
        ...row(variant.moop),
      }).map(([field, amount]) => {
        const published = row(amount);
        return {
          field,
          raw: published.raw,
          cents: published.cents,
          parse_status: published.status,
          ...evidence(variant, parent),
        };
      }),
      ...evidence(value, parent),
    };
  }
  function rate(value: unknown) {
    const r = row(value),
      p = row(r.provenance);
    return {
      snapshot_id: p.snapshot_id ?? r.publication_snapshot_id,
      source_row: p.source_row ?? null,
      source_record: nullable(r.source_record),
      column: nullable(r.column),
      tier: nullable(r.tier),
      value: nullable(r.value),
      individual_rate_cents: nullable(r.individual_rate_cents),
      individual_tobacco_rate_cents: nullable(r.individual_tobacco_rate_cents),
      family_rates_cents: nullable(r.family_rates_cents),
      effective_date: nullable(r.effective_date),
      expiration_date: nullable(r.expiration_date),
      age_band: nullable(r.age_band),
      tobacco: nullable(r.tobacco),
      ...evidence(value),
    };
  }
  function estimate(value: unknown) {
    const q = row(value),
      subsidy = q.subsidy ? row(q.subsidy) : null,
      b = subsidy ? row(subsidy.benchmark) : null;
    const dental = row(b?.pediatric_dental),
      rule = q.rule_trace ? row(q.rule_trace) : null,
      pediatric = q.pediatric_ehb ? row(q.pediatric_ehb) : null;
    const refs = evidence(value);
    return {
      kind: "estimate",
      plan_ref: q.plan_id,
      coverage_start: q.coverage_start,
      coverage: q.coverage,
      gross_status: q.status,
      gross_monthly_cents: nullable(q.total_cents),
      estimated_credit_cents: nullable(q.estimated_monthly_tax_credit_cents),
      estimated_net_cents: nullable(q.estimated_net_monthly_cents),
      benchmark_cents: nullable(q.slcsp_monthly_cents),
      subsidy_status: q.subsidy_status ?? "not_requested",
      quote_method: q.quote_method ?? "puf_calculation",
      bindable_quote: false,
      csr_eligibility_status: "not_evaluated",
      rating_area_id: nullable(q.rating_area_id),
      filed_column: nullable(q.filed_column),
      state_rule_trace: rule
        ? {
            state: rule.state,
            tier: rule.tier,
            nominal_multiplier: rule.nominal_multiplier,
            citation: rule.citation,
            references: rule.references,
          }
        : null,
      members: rows(q.members).map((m) => ({
        member_id: m.member_id,
        age: m.age,
        relationship: m.relationship,
        tobacco: m.tobacco,
        charged: m.charged,
        status: m.status,
        premium_cents: m.premium_cents,
        rate_rows: rows(m.rate_rows).map(rate),
      })),
      rate_trace: rows(q.rate_rows_used).map(rate),
      dental_business_rules: rows(q.dental_business_rules).map((d) => ({
        snapshot_id: d.snapshot_id,
        source_row: d.source_row,
        fields: Object.entries(row(d.raw)).map(([field, raw]) => ({
          field,
          raw,
        })),
        ...evidence(d),
      })),
      pediatric_ehb: pediatric
        ? {
            status: pediatric.status,
            monthly_cents: pediatric.monthly_cents,
            pediatric_gross_cents: pediatric.pediatric_gross_cents,
            fraction: pediatric.fraction,
            field: pediatric.field,
            reason: nullable(pediatric.reason),
            citation: pediatric.citation,
            ...refs,
          }
        : null,
      subsidy:
        subsidy && b
          ? {
              status: subsidy.status,
              reason: subsidy.reason,
              rounding_policy: subsidy.rounding_policy,
              fpl_percent: subsidy.fpl_percent,
              applicable_percentage: subsidy.applicable_percentage,
              expected_contribution_monthly_cents:
                subsidy.expected_contribution_monthly_cents,
              expected_contribution_annual_cents:
                subsidy.expected_contribution_annual_cents,
              enrollment_ehb_monthly_cents:
                subsidy.enrollment_ehb_monthly_cents,
              benchmark: {
                status: b.status,
                slcsp_monthly_cents: b.slcsp_monthly_cents,
                benchmark_plan_ids: b.benchmark_plan_ids,
                silver_plan_count: b.silver_plan_count,
                lowest_silver_plans: rows(b.lowest_silver_plans).map((p) => ({
                  plan_id: p.plan_id,
                  gross_monthly_cents: p.gross_monthly_cents,
                  ehb_monthly_cents: p.ehb_monthly_cents,
                  benchmark_monthly_cents: p.benchmark_monthly_cents,
                  pediatric_dental_adjustment_cents:
                    p.pediatric_dental_adjustment_cents,
                  ehb_fraction: p.ehb_fraction,
                  ...refs,
                })),
                pediatric_dental_monthly_cents: dental.monthlyCents ?? null,
                pediatric_dental_offers: rows(dental.offers).map((p) => ({
                  plan_id: p.planId,
                  pediatric_gross_cents: p.pediatricGrossCents,
                  ehb_monthly_cents: p.ehbCents,
                  ...refs,
                })),
                issues: b.issues,
                ...refs,
              },
            }
          : null,
      ...refs,
    };
  }
  return {
    plan,
    address,
    provider,
    drug,
    geography,
    directory,
    dataset,
    coverage,
    participation,
    snapshot,
    benefit,
    estimate,
    quote,
    evidence,
    metadata,
    sources,
    context: { snapshotIds: new Set(metadata.keys()), drugs } as HonestyContext,
  };
}
