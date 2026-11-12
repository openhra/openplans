import { z } from "zod";
import type { JsonSchemaType } from "@modelcontextprotocol/server";
import { normalizeNdc } from "../domain/drugs/concepts.js";
import { FAMILY_RATE_FIELDS } from "../domain/rating/types.js";
import { parseCents } from "../domain/rating/index.js";
import * as v from "../api/validation.js";
import type { estimatePremiums } from "../services/catalog.js";
import type { quotePlans } from "../services/quotes.js";

// No transport or registration here. Every exported JSON schema is self-contained 2020-12.
const text = z.string().min(1).max(200),
  label = z.string().max(1000);
const year = z.int().min(2014).max(2100),
  zip = z.string().regex(/^\d{5}$/);
const hios = z.string().regex(/^\d{5}[A-Z]{2}\d{7}(?:-0[0-6])?$/);
const planKey = z
  .string()
  .min(4)
  .max(217)
  // eslint-disable-next-line no-control-regex -- Control characters must be rejected at this boundary.
  .regex(/^[A-Z][A-Z0-9]{1,15}:[^\u0000-\u001f]{1,200}$/);
export const planRefSchema = z.union([hios, planKey]);
const npi = z.string().regex(/^[12]\d{9}$/),
  rxcui = z.string().regex(/^\d{1,20}$/);
const state = z.string().regex(/^[A-Z]{2}$/),
  csr = z.enum(["00", "01", "02", "03", "04", "05", "06"]);
const limit = z.int().min(1).max(25).default(10),
  cursor = z.string().min(1).max(2048);
const paging = { limit, cursor: cursor.optional() };
const location = z.strictObject({
  zip: zip.optional(),
  county: zip.optional(),
});
const member = z.strictObject({
  age: z.int().min(0).max(120),
  tobacco: z.boolean(),
  relationship: z.enum(["subscriber", "spouse", "child", "other"]),
});
/** Public tier: ages only; tobacco is optional and rated (owner, 2026-11-09). */
const quoteMember = z.strictObject({
  age: z.int().min(0).max(120),
  relationship: z.enum(["subscriber", "spouse", "child", "other"]).optional(),
  tobacco: z.boolean().optional(),
});
const household = z.strictObject({
  income_annual: z.number().nonnegative(),
  size: z.int().min(1).max(100),
  tax_filing: z.enum(v.TAX_FILINGS),
});
const ids = <S extends z.ZodType>(schema: S) => z.array(schema).min(1).max(10);
const ichraCents = z.int().min(0).max(10_000_000_000);
const ichraMonths = z.int().min(1).max(12);
const ichraIncome = z.discriminatedUnion("measure", [
  z.strictObject({ measure: z.literal("household"), annual_cents: ichraCents }),
  z.strictObject({
    measure: z.literal("w2"),
    annual_cents: ichraCents,
    w2_months_offered: ichraMonths.optional(),
    w2_months_employed: ichraMonths.optional(),
  }),
  z.strictObject({
    measure: z.literal("rate_of_pay_hourly"),
    hourly_cents: ichraCents,
    lowest_hourly_cents: ichraCents.min(1).optional(),
  }),
  z.strictObject({
    measure: z.literal("rate_of_pay_salary"),
    monthly_cents: ichraCents,
    salary_reduced: z.boolean().optional(),
  }),
  z.strictObject({ measure: z.literal("fpl") }),
]);
export const inputSchemas = {
  search: z.strictObject({
    query: text,
    entity: z
      .enum([
        "all",
        "plan",
        "provider",
        "drug",
        "geography",
        "carrier",
        "network",
        "dataset",
      ])
      .default("all"),
    location: location.optional(),
    year: year.optional(),
    ...paging,
  }),
  fetch: z.strictObject({
    id: z.string().min(1).max(1024),
    section: z
      .enum([
        "summary",
        "benefits",
        "addresses",
        "associations",
        "documents",
        "provenance",
      ])
      .default("summary"),
    ...paging,
  }),
  search_plans: z.strictObject({
    location,
    year,
    metal: z
      .enum([
        "bronze",
        "expanded bronze",
        "silver",
        "gold",
        "platinum",
        "catastrophic",
      ])
      .optional(),
    csr_variant: csr.optional(),
    ...paging,
  }),
  get_plan: z.strictObject({
    plan_ref: planRefSchema,
    year,
    csr_variant: csr.optional(),
    section: z
      .enum(["summary", "benefits", "documents", "provenance"])
      .default("summary"),
    ...paging,
  }),
  quote_premiums: z.strictObject({
    plan_refs: ids(planRefSchema),
    location,
    coverage_start: z.iso.date(),
    members: z.array(member).min(1).max(20),
    household: household.optional(),
    csr_variant: csr.optional(),
  }),
  check_ichra_affordability: z.strictObject({
    plan_start: z.iso.date(),
    months_available: z.int().min(1).max(12).optional(),
    employee: z.strictObject({
      date_of_birth: z.iso.date(),
      eligible_from: z.iso.date().nullable().optional(),
    }),
    residence: location,
    worksite: z
      .strictObject({
        zip: zip.optional(),
        county: zip.optional(),
        remote: z.boolean().optional(),
      })
      .optional(),
    hra: z.strictObject({ self_only_annual_cents: ichraCents }),
    income: z.array(ichraIncome).min(1).max(4),
    safe_harbors: z
      .strictObject({
        location: z.boolean().optional(),
        look_back: z.boolean().optional(),
      })
      .optional(),
    lcsp_premium_basis: z.enum(["gross", "ehb_portion"]).optional(),
  }),
  quote_plans: z.strictObject({
    year,
    location,
    members: z.array(quoteMember).min(1).max(v.PUBLIC_QUOTE_LIMITS.members),
    plan_refs: ids(planRefSchema).optional(),
    coverage: z.enum(["medical", "dental"]).optional(),
    metal: z
      .enum([
        "bronze",
        "expanded bronze",
        "silver",
        "gold",
        "platinum",
        "catastrophic",
      ])
      .optional(),
    csr_variant: csr.optional(),
    npis: z.array(npi).max(v.PUBLIC_QUOTE_LIMITS.providers).optional(),
    rxcuis: z.array(rxcui).max(v.PUBLIC_QUOTE_LIMITS.drugs).optional(),
    cursor: cursor.optional(),
  }),
  search_providers: z.strictObject({
    name: text.optional(),
    npi: npi.optional(),
    taxonomy: z
      .string()
      .regex(/^[A-Z0-9]{10}$/)
      .optional(),
    specialty: text.optional(),
    type: z.enum(["INDIVIDUAL", "FACILITY", "GROUP"]).optional(),
    plan_id: hios.optional(),
    year: year.optional(),
    zip: zip.optional(),
    radius_miles: z.number().min(0).max(500).optional(),
    ...paging,
  }),
  search_drugs: z.strictObject({
    query: text.optional(),
    ndc: z.string().min(11).max(13).optional(),
    ...paging,
  }),
  check_drug_coverage: z.strictObject({
    plan_ids: ids(hios),
    rxcuis: ids(rxcui),
    year,
  }),
  check_provider_network: z.strictObject({
    plan_ids: ids(hios),
    npis: ids(npi),
    year,
  }),
  lookup_geography: z.strictObject({ zip, county: zip.optional() }),
  search_medicare_plans: z.strictObject({
    location,
    year,
    type: z.enum(["ma", "ma_pd", "pdp", "snp", "cost"]).optional(),
    ...paging,
  }),
  get_data_status: z.strictObject({
    state: state.optional(),
    year: year.optional(),
    issuer_id: text.optional(),
    ...paging,
  }),
  list_carriers_networks: z.strictObject({
    state,
    year: year.optional(),
    kind: z.enum(["carriers", "networks"]).default("carriers"),
    ...paging,
  }),
} as const;
export type ToolName = keyof typeof inputSchemas;
export type ToolInput<T extends ToolName> = z.output<(typeof inputSchemas)[T]>;
export const toolNames = Object.keys(inputSchemas).sort() as ToolName[];

const gaps = z.array(z.string().min(1).max(240)).max(100);
const evidenceFields = {
  evidence_refs: z.array(z.string().min(1).max(1024)).max(100),
  gaps,
};
const cents = z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  nullableCents = cents.nullable();
const nonnegative = z.int().nonnegative(),
  isoTime = z.iso.datetime({ offset: true }).nullable();
const publicUrl = z
  .string()
  .max(2048)
  .regex(/^(https:\/\/|openplans:)/);
export const sourceSchema = z.strictObject({
  id: z.string().min(1).max(1024),
  snapshot_id: z.string().min(1).max(1024).nullable(),
  publisher: label.nullable(),
  url: publicUrl.nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  retrieved_at: isoTime,
  publisher_updated_at: isoTime,
  record_ref: label.nullable(),
  status: z.enum(["available", "unknown"]),
});
export const freshnessSchema = z.strictObject({
  checked_at: z.iso.datetime({ offset: true }),
  status: z.enum(["current_local", "stale", "unknown"]),
});
export const pageSchema = z.strictObject({
  next_cursor: cursor.nullable(),
  returned: z.int().min(0).max(25),
  total: nonnegative.nullable(),
});
export const errorSchema = z.strictObject({
  code: z.string().min(1).max(80),
  field: z.string().max(80).nullable(),
  retryable: z.boolean(),
});
const sourceCompleteness = z.enum([
  "complete",
  "partial",
  "failed",
  "access_denied",
  "unknown",
]);
export const drugStatusSchema = z.enum([
  "listed_covered",
  "explicitly_not_covered",
  "not_listed",
  "unknown",
  "conflicting",
]);
export const participationStatusSchema = z.enum([
  "listed_participating",
  "explicitly_not_participating",
  "not_listed",
  "unknown",
  "conflicting",
]);
export const grossStatusSchema = z.enum([
  "rated",
  "missing",
  "ambiguous",
  "unknown",
  "unsupported_rating_method",
]);
export const subsidyStatusSchema = z.enum([
  "not_requested",
  "estimated",
  "requires_state_rules",
  "over_income_limit",
  "parameters_unconfirmed",
  "requires_tax_filing_review",
  "plan_ineligible_for_tax_credit",
  "requires_premium_adjustments",
  "unsupported_rating_method",
  "unknown",
  "ambiguous",
  "no_silver_plans",
  "location_requires_zip",
  "incomplete_benchmark",
  "ambiguous_benchmark",
  "requires_benchmark_adjustments",
  "premium_missing",
  "premium_ambiguous",
  "premium_unknown",
]);
const quoteMethod = z.enum([
  "puf_calculation",
  "state_filed_tier",
  "filed_dental_per_member",
  "filed_dental_family_option",
]);
export const planSchema = z.strictObject({
  kind: z.literal("plan"),
  plan_ref: planRefSchema,
  hios_id: hios.nullable(),
  plan_key: planKey.nullable(),
  year,
  name: label,
  metal: label.nullable(),
  on_exchange: z.union([z.boolean(), z.literal("unknown")]),
  selected_variant_id: hios.nullable(),
  cost_sharing_status: z.enum(["available", "unknown"]),
  enrollment_eligibility: z.literal("unknown"),
  ...evidenceFields,
});
const point = z.strictObject({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  method: label,
  ...evidenceFields,
});
export const addressSchema = z.strictObject({
  kind: z.literal("address"),
  line_1: label.nullable(),
  line_2: label.nullable(),
  city: label.nullable(),
  state: label.nullable(),
  zip: label.nullable(),
  distance_miles: z.number().nonnegative().nullable(),
  precision: z.enum(["exact", "non_exact", "approximate"]).nullable(),
  point: point.nullable(),
  ...evidenceFields,
});
export const providerSchema = z.strictObject({
  kind: z.literal("provider"),
  record_id: label,
  npi: npi.nullable(),
  name: label.nullable(),
  participation: z.union([
    participationStatusSchema,
    z.literal("not_evaluated"),
  ]),
  participation_scope: z.enum(["provider_record", "identity"]),
  nearest_address: addressSchema.nullable(),
  addresses_total: nonnegative.nullable(),
  ...evidenceFields,
});
export const drugSchema = z.strictObject({
  kind: z.literal("drug"),
  rxcui,
  name: label,
  tty: text,
  suppress: text,
  ...evidenceFields,
});
export const drugEvidenceSchema = z.strictObject({
  status: z.enum(["listed_covered", "explicitly_not_covered"]),
  tier: label.nullable(),
  tier_status: z.enum(["resolved", "unresolved"]).nullable(),
  prior_authorization: z.boolean().nullable(),
  step_therapy: z.boolean().nullable(),
  quantity_limit: z.boolean().nullable(),
  ...evidenceFields,
});
/** Present only when the answer came from the CMS Marketplace API fallback. */
const cmsApiSchema = z
  .strictObject({
    sourced_by: z.literal("cms-marketplace-api"),
    coverage: label,
    sourced_at: z.iso.datetime({ offset: true }),
    snapshot_id: z.string().min(1).max(1024),
    served_from: z.enum(["live", "absorbed", "absorbed_stale"]),
    source: label,
    limits: z.string().min(1).max(240),
  })
  .optional();
export const drugCoverageSchema = z.strictObject({
  kind: z.literal("drug_coverage"),
  plan_id: hios,
  rxcui,
  year,
  status: drugStatusSchema,
  tier: label.nullable(),
  tier_status: z.enum(["resolved", "unresolved"]).nullable(),
  prior_authorization: z.boolean().nullable(),
  step_therapy: z.boolean().nullable(),
  quantity_limit: z.boolean().nullable(),
  patient_price: z.null(),
  source_completeness: sourceCompleteness,
  cms_api: cmsApiSchema,
  evidence: z.array(drugEvidenceSchema).max(100),
  ...evidenceFields,
});
const participationEvidence = z.strictObject({
  status: z.enum(["listed_participating", "explicitly_not_participating"]),
  record_id: label,
  network_tier: label,
  tier_status: z.enum(["resolved", "unresolved"]),
  ...evidenceFields,
});
export const participationSchema = z.strictObject({
  kind: z.literal("participation"),
  plan_id: hios,
  npi,
  year,
  status: participationStatusSchema,
  scope: z.literal("provider_record"),
  address_participation: z.literal("not_evaluated"),
  source_completeness: sourceCompleteness,
  cms_api: cmsApiSchema,
  evidence: z.array(participationEvidence).max(100),
  ...evidenceFields,
});
export const geographySchema = z.strictObject({
  kind: z.literal("geography"),
  county_fips: zip,
  state,
  name: label.nullable(),
  source_method: label,
  centroid: point.nullable(),
  approximate: z.boolean(),
  ...evidenceFields,
});
export const medicarePlanSchema = z.strictObject({
  kind: z.literal("medicare_plan"),
  plan_key: z.string().regex(/^[EHRS]\d{4}-\d{3}-\d{1,3}$/),
  name: label.nullable(),
  plan_type: label.nullable(),
  contract_category: label.nullable(),
  organization: label.nullable(),
  parent_organization: label.nullable(),
  consolidated_premium_cents: z.int().nullable(),
  part_d_deductible_cents: z.int().nullable(),
  moop_in_network_cents: z.int().nullable(),
  overall_stars: z.number().min(1).max(5).nullable(),
  star_status: label,
  snp_type: label.nullable(),
  provider_network: z.literal("unknown"),
  ...evidenceFields,
});
export const directorySchema = z.strictObject({
  kind: z.enum(["carrier", "network"]),
  id: label,
  issuer_id: label,
  state,
  year,
  network_id: label.nullable(),
  name: label.nullable(),
  network_url: publicUrl.nullable(),
  dental_only: z.boolean().nullable(),
  ...evidenceFields,
});
export const datasetSchema = z.strictObject({
  kind: z.literal("dataset"),
  state: state.nullable(),
  year: year.nullable(),
  issuer_id: label.nullable(),
  capability: z.enum([
    "catalog",
    "premiums",
    "drugs",
    "providers",
    "geography",
    "terminology",
    "taxonomy",
  ]),
  status: z.enum([
    "available",
    "complete",
    "partial",
    "failed",
    "access_denied",
    "unknown",
    "unsupported",
  ]),
  active_snapshot_id: text.nullable(),
  latest_snapshot_id: text.nullable(),
  retrieved_at: isoTime,
  publisher_updated_at: isoTime,
  reason: label.nullable(),
  ichra_status: z
    .enum(["available", "incomplete_lcsp", "requires_state_rules", "unknown"])
    .optional(),
  ichra_reason: label.nullable().optional(),
  ichra_lookback_status: z.literal("unknown").optional(),
  ichra_lookback_reason: label.optional(),
  ichra_documentation: text.optional(),
  ...evidenceFields,
});
const amount = z.strictObject({
  field: text,
  raw: label,
  cents: nullableCents,
  parse_status: z.enum(["available", "unknown"]),
  ...evidenceFields,
});
export const benefitSchema = z.strictObject({
  kind: z.literal("benefit"),
  variant_id: hios,
  name: label,
  cost_sharing_text: z
    .array(
      z.strictObject({
        field: text,
        raw: label,
        parsed_cents: nullableCents,
        parse_status: z.enum(["available", "unknown"]),
      }),
    )
    .max(50),
  accumulators: z.array(amount).max(100),
  ...evidenceFields,
});
export const documentSchema = z.strictObject({
  kind: z.literal("document"),
  url: publicUrl,
  document_type: label,
  content_status: z.enum(["available", "unknown"]),
  ...evidenceFields,
});
export const snapshotSchema = z.strictObject({
  kind: z.literal("snapshot"),
  snapshot_id: z.string().min(1).max(1024),
  source_id: label,
  publisher: label,
  source_kind: label,
  url: publicUrl.nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  bytes: z.string().regex(/^\d+$/).nullable(),
  retrieved_at: isoTime,
  publisher_updated_at: isoTime,
  validation_state: z.enum([
    "DISCOVERED",
    "FETCHING",
    "PARSED",
    "VALIDATED",
    "RECONCILED",
    "ACTIVE",
    "QUARANTINED",
  ]),
  expected_children: nonnegative.nullable(),
  fetched_children: nonnegative,
  parent_snapshot_ids: z.array(label).max(100),
  child_snapshot_ids: z.array(label).max(100),
  ...evidenceFields,
});
const associationSchema = z.strictObject({
  kind: z.literal("association"),
  relation: label,
  target_id: label,
  ...evidenceFields,
});
export const detailRowSchema = z.union([
  benefitSchema,
  addressSchema,
  associationSchema,
  documentSchema,
  snapshotSchema,
]);
export const rateTraceSchema = z.strictObject({
  snapshot_id: z.string().min(1).max(1024),
  source_row: nonnegative.nullable(),
  source_record: label.nullable(),
  column: label.nullable(),
  tier: label.nullable(),
  value: label.nullable(),
  individual_rate_cents: nullableCents,
  individual_tobacco_rate_cents: nullableCents,
  family_rates_cents: z
    .strictObject({
      Couple: nullableCents,
      PrimarySubscriberAndOneDependent: nullableCents,
      PrimarySubscriberAndTwoDependents: nullableCents,
      PrimarySubscriberAndThreeOrMoreDependents: nullableCents,
      CoupleAndOneDependent: nullableCents,
      CoupleAndTwoDependents: nullableCents,
      CoupleAndThreeOrMoreDependents: nullableCents,
    })
    .nullable(),
  effective_date: z.iso.date().nullable(),
  expiration_date: z.iso.date().nullable(),
  age_band: z.union([z.int(), label]).nullable(),
  tobacco: label.nullable(),
  ...evidenceFields,
});
const memberTrace = z.strictObject({
  member_id: text,
  age: z.int().min(0).max(120),
  relationship: z.enum(["subscriber", "spouse", "child", "other"]),
  tobacco: z.boolean(),
  charged: z.boolean(),
  status: z.union([grossStatusSchema, z.literal("not_charged")]),
  premium_cents: nullableCents,
  rate_rows: z.array(rateTraceSchema).max(25),
});
const benchmarkPlan = z.strictObject({
  plan_id: hios,
  gross_monthly_cents: cents,
  ehb_monthly_cents: cents,
  benchmark_monthly_cents: cents,
  pediatric_dental_adjustment_cents: cents,
  ehb_fraction: label,
  ...evidenceFields,
});
const dentalOffer = z.strictObject({
  plan_id: hios,
  pediatric_gross_cents: cents,
  ehb_monthly_cents: cents,
  ...evidenceFields,
});
const benchmarkTrace = z.strictObject({
  status: z.enum([
    "calculated",
    "unknown",
    "ambiguous",
    "requires_state_rules",
    "unsupported_rating_method",
    "no_silver_plans",
    "location_requires_zip",
    "incomplete_benchmark",
    "ambiguous_benchmark",
    "requires_benchmark_adjustments",
  ]),
  slcsp_monthly_cents: nullableCents,
  benchmark_plan_ids: z.array(hios).max(100),
  silver_plan_count: nonnegative,
  lowest_silver_plans: z.array(benchmarkPlan).max(2),
  pediatric_dental_monthly_cents: nullableCents,
  pediatric_dental_offers: z.array(dentalOffer).max(100),
  issues: gaps,
  ...evidenceFields,
});
const subsidyTrace = z.strictObject({
  status: subsidyStatusSchema,
  reason: label,
  rounding_policy: z.literal("form_8962_lines_8a_8b_whole_dollars"),
  fpl_percent: z.number().nonnegative().nullable(),
  applicable_percentage: z.number().min(0).max(1).nullable(),
  expected_contribution_monthly_cents: nullableCents,
  expected_contribution_annual_cents: nullableCents,
  enrollment_ehb_monthly_cents: nullableCents,
  benchmark: benchmarkTrace,
});
export const estimateSchema = z.strictObject({
  kind: z.literal("estimate"),
  plan_ref: planRefSchema,
  coverage_start: z.iso.date(),
  coverage: z.enum(["medical", "dental"]),
  gross_status: grossStatusSchema,
  gross_monthly_cents: nullableCents,
  estimated_credit_cents: nullableCents,
  estimated_net_cents: nullableCents,
  benchmark_cents: nullableCents,
  subsidy_status: subsidyStatusSchema,
  quote_method: quoteMethod,
  bindable_quote: z.literal(false),
  csr_eligibility_status: z.literal("not_evaluated"),
  rating_area_id: label.nullable(),
  filed_column: z.enum(["IndividualRate", ...FAMILY_RATE_FIELDS]).nullable(),
  state_rule_trace: z
    .strictObject({
      state,
      tier: label,
      nominal_multiplier: z.strictObject({
        numerator: nonnegative,
        denominator: z.int().positive(),
      }),
      citation: label,
      references: z.array(publicUrl).max(25),
    })
    .nullable(),
  members: z.array(memberTrace).max(20),
  rate_trace: z.array(rateTraceSchema).max(100),
  dental_business_rules: z
    .array(
      z.strictObject({
        snapshot_id: label,
        source_row: nonnegative,
        fields: z.array(z.strictObject({ field: text, raw: label })).max(100),
        ...evidenceFields,
      }),
    )
    .max(25),
  pediatric_ehb: z
    .strictObject({
      status: z.enum(["available", "unknown"]),
      monthly_cents: nullableCents,
      pediatric_gross_cents: nullableCents,
      fraction: label.nullable(),
      field: z.literal("EHBPediatricDentalApportionmentQuantity"),
      reason: label.nullable(),
      citation: publicUrl,
      ...evidenceFields,
    })
    .nullable(),
  subsidy: subsidyTrace.nullable(),
  ...evidenceFields,
});
/** A public quote is an estimate plus per-plan provider and drug evidence; state plan keys allowed. */
export const quoteSchema = estimateSchema.extend({
  kind: z.literal("quote"),
  providers: z
    .array(participationSchema.extend({ plan_id: planRefSchema }))
    .max(v.PUBLIC_QUOTE_LIMITS.providers),
  drugs: z
    .array(drugCoverageSchema.extend({ plan_id: planRefSchema }))
    .max(v.PUBLIC_QUOTE_LIMITS.drugs),
});
const evidenceAvailability = z.enum(["available", "partial", "unknown"]);
const hit = z.strictObject({
  kind: z.enum([
    "plan",
    "provider",
    "drug",
    "geography",
    "carrier",
    "network",
    "dataset",
  ]),
  id: label,
  title: label,
  url: publicUrl,
  summary: z.string().max(500),
  ...evidenceFields,
});
const records = z
  .array(
    z.union([
      planSchema,
      providerSchema,
      drugSchema,
      geographySchema,
      directorySchema,
      datasetSchema,
      detailRowSchema,
    ]),
  )
  .max(25);
const centsRatio = z.strictObject({
  numerator: cents,
  denominator: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  display: cents,
});
/** null when that basis could not be computed. */
const ichraBasisPick = z
  .strictObject({
    plan_ids: z.array(hios).max(100),
    monthly_cents: nullableCents,
  })
  .nullable();
/** Only a calculated LCSP is projected; it always carries rate-row evidence. */
const ichraLcspSchema = z.strictObject({
  use: z.enum(["premium_tax_credit", "employer"]),
  status: z.literal("calculated"),
  basis_used: z.enum(["gross", "ehb_portion"]),
  plan_ids: z.array(hios).max(100),
  monthly_cents: nullableCents,
  by_basis: z.strictObject({
    gross: ichraBasisPick,
    ehb_portion: ichraBasisPick,
  }),
  location_source: z.enum(["residence", "worksite"]),
  county_fips: zip.nullable(),
  zip: zip.nullable(),
  rating_area_id: label.nullable(),
  coverage_month: z.iso.date(),
  identified_at_age: z.int().min(0).max(120),
  priced_at_age: z.int().min(0).max(120),
  silver_plan_count: nonnegative,
  ...evidenceFields,
});
const ichraVerdictSchema = z.strictObject({
  measure: z.enum([
    "household",
    "w2",
    "rate_of_pay_hourly",
    "rate_of_pay_salary",
    "fpl",
  ]),
  purpose: z.enum(["premium_tax_credit", "employer_4980H"]),
  lcsp: z.enum(["premium_tax_credit", "employer"]),
  status: z.enum(["calculated", "unknown", "ambiguous_lcsp"]),
  reason: label.nullable(),
  required_hra_contribution_cents: centsRatio.nullable(),
  threshold_cents: centsRatio.nullable(),
  affordable: z.boolean().nullable(),
  affordable_by_basis: z.strictObject({
    gross: z.boolean().nullable(),
    ehb_portion: z.boolean().nullable(),
  }),
  rule_ids: z.array(text).max(10),
  fpl_guideline_year: year.optional(),
});
const ichraRuleSchema = z.strictObject({
  id: text,
  status: z.enum(["final", "proposed_reliance_permitted"]),
  citations: z.array(publicUrl).min(1).max(5),
});
const payloadSchemas = {
  search: z.strictObject({ results: z.array(hit).max(25), scope_gaps: gaps }),
  fetch: z.strictObject({
    id: label,
    title: label,
    url: publicUrl,
    text: z.string().max(12000),
    entity: z.enum([
      "plan",
      "provider",
      "drug",
      "geography",
      "carrier",
      "network",
      "dataset",
      "snapshot",
    ]),
    section: z.enum([
      "summary",
      "benefits",
      "addresses",
      "associations",
      "documents",
      "provenance",
    ]),
    records,
  }),
  search_plans: z.strictObject({
    plans: z.array(planSchema).max(25),
    location_status: z.enum(["available", "ambiguous", "unknown"]),
    counties: z.array(geographySchema).max(25),
  }),
  get_plan: z.strictObject({
    plan: planSchema,
    section: z.enum(["summary", "benefits", "documents", "provenance"]),
    records,
  }),
  quote_premiums: z.strictObject({
    quotes: z.array(estimateSchema).max(10),
    bindable_quote: z.literal(false),
  }),
  check_ichra_affordability: z.strictObject({
    status: text,
    reason: label.nullable(),
    plan_start: z.iso.date(),
    applicable_age: z.int().min(0).max(120).nullable(),
    basis_sensitive: z.boolean().nullable(),
    lcsps: z.array(ichraLcspSchema).max(2),
    monthly_hra_cents: centsRatio.nullable(),
    required_contribution_percentage_bp: z.int().min(1).max(10_000).nullable(),
    verdicts: z.array(ichraVerdictSchema).max(4),
    safe_harbors_applied: z.array(text).max(10),
    rules: z.array(ichraRuleSchema).max(20),
    bindable_quote: z.literal(false),
  }),
  quote_plans: z.strictObject({
    quotes: z.array(quoteSchema).max(v.PUBLIC_QUOTE_LIMITS.plans),
    bindable_quote: z.literal(false),
    tier: z.literal("public_quote"),
    location_status: z.enum(["available", "ambiguous", "unknown"]),
    tobacco_rating: z.literal("requested_flags"),
    subsidy_status: z.literal("not_evaluated"),
    data_availability: z.strictObject({
      catalog: evidenceAvailability,
      providers: evidenceAvailability,
      drugs: evidenceAvailability,
    }),
  }),
  search_providers: z.strictObject({
    providers: z.array(providerSchema).max(25),
    unlocated: nonnegative.nullable(),
  }),
  search_drugs: z.strictObject({
    candidates: z.array(drugSchema).max(25),
    exact_concept_required: z.literal(true),
    terminology_status: z.enum(["available", "unknown"]),
  }),
  check_drug_coverage: z.strictObject({
    results: z.array(drugCoverageSchema).max(100),
  }),
  check_provider_network: z.strictObject({
    results: z.array(participationSchema).max(100),
  }),
  lookup_geography: z.strictObject({
    zip,
    resolution: z.enum(["available", "ambiguous", "unknown"]),
    counties: z.array(geographySchema).max(25),
  }),
  search_medicare_plans: z.strictObject({
    location_status: z.enum(["available", "unknown", "multiple_counties"]),
    county_fips: zip.nullable(),
    contract_year: year,
    as_of: label.nullable(),
    plans: z.array(medicarePlanSchema).max(25),
    part_d_drug_data: label,
  }),
  get_data_status: z.strictObject({
    datasets: z.array(datasetSchema).max(25),
    personalized_access: z.enum([
      "authorized",
      "authentication_required",
      "disabled",
    ]),
    public_quoting: z.enum(["enabled", "disabled"]),
    loaded: z.boolean(),
  }),
  list_carriers_networks: z.strictObject({
    rows: z.array(directorySchema).max(25),
  }),
} as const;
export const envelopeShape = {
  schema_version: z.literal("1"),
  status: z.enum(["ok", "unknown", "ambiguous", "unsupported", "error"]),
  data_generation: z.string().min(1).max(200),
  provenance: z.array(sourceSchema).max(100),
  notes: gaps,
  truncated: z.boolean(),
  freshness: freshnessSchema,
  page: pageSchema.nullable(),
  error: errorSchema.nullable(),
};
function output<P extends z.ZodType>(payload: P) {
  return z.strictObject({ ...envelopeShape, data: payload.nullable() });
}
export const outputSchemas = {
  search: output(payloadSchemas.search),
  fetch: output(payloadSchemas.fetch),
  search_plans: output(payloadSchemas.search_plans),
  get_plan: output(payloadSchemas.get_plan),
  quote_premiums: output(payloadSchemas.quote_premiums),
  check_ichra_affordability: output(payloadSchemas.check_ichra_affordability),
  quote_plans: output(payloadSchemas.quote_plans),
  search_providers: output(payloadSchemas.search_providers),
  search_drugs: output(payloadSchemas.search_drugs),
  check_drug_coverage: output(payloadSchemas.check_drug_coverage),
  check_provider_network: output(payloadSchemas.check_provider_network),
  lookup_geography: output(payloadSchemas.lookup_geography),
  search_medicare_plans: output(payloadSchemas.search_medicare_plans),
  get_data_status: output(payloadSchemas.get_data_status),
  list_carriers_networks: output(payloadSchemas.list_carriers_networks),
} as const;
export type ToolOutput<T extends ToolName> = z.output<
  (typeof outputSchemas)[T]
>;
export const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
export const evidenceCaution =
  "Uses imported public evidence. Missing or incomplete evidence is unknown; not_listed is not a coverage denial. Inspect provenance and freshness.";

/** Structural JSON validation plus existing semantic parsers; JSON numbers never feed string-only native parsers. */
export function parseToolInput<T extends ToolName>(
  tool: T,
  value: unknown,
): ToolInput<T> {
  const parsed = inputSchemas[tool].parse(value);
  const input = parsed as Record<string, unknown>;
  if (input.location) v.location(input.location as Record<string, unknown>);
  if (typeof input.state === "string") v.state(input.state);
  if (typeof input.query === "string" && !input.query.trim()) v.fail("query");
  if (tool === "search_drugs") {
    if ((input.query === undefined) === (input.ndc === undefined))
      v.fail("query", "QUERY_OR_NDC_REQUIRED");
    if (typeof input.ndc === "string" && !normalizeNdc(input.ndc))
      v.fail("ndc", "INVALID_NDC");
  }
  if (tool === "search_providers") {
    if (
      !["name", "npi", "taxonomy", "specialty", "plan_id", "zip"].some(
        (field) => input[field] !== undefined,
      )
    )
      v.fail("query", "FILTER_REQUIRED");
    for (const field of ["name", "specialty"])
      if (typeof input[field] === "string" && !(input[field] as string).trim())
        v.fail(field);
    if (input.plan_id !== undefined && input.year === undefined)
      v.fail("year", "YEAR_REQUIRED");
    if (input.radius_miles !== undefined && input.zip === undefined)
      v.fail("zip", "LOCATION_REQUIRED");
    if (input.taxonomy !== undefined && input.specialty !== undefined)
      v.fail("taxonomy", "TAXONOMY_OR_SPECIALTY_REQUIRED");
    // Exact NPI uses detail, including its year. Reject intersections until the indexed repository supports them.
    if (
      input.npi !== undefined &&
      [
        "name",
        "taxonomy",
        "specialty",
        "type",
        "plan_id",
        "zip",
        "radius_miles",
      ].some((field) => input[field] !== undefined)
    ) {
      v.fail("npi", "UNSUPPORTED_NPI_FILTER_COMBINATION");
    }
  }
  for (const field of ["plan_ids", "plan_refs", "rxcuis", "npis"]) {
    const values = input[field];
    if (Array.isArray(values) && new Set(values).size !== values.length)
      v.fail(field, "DUPLICATE_IDENTIFIER");
  }
  if (tool === "quote_plans") v.publicQuoteRequest(quoteBody(input, 1));
  if (tool === "check_ichra_affordability") v.ichraRequest(input);
  if (tool === "quote_premiums") {
    const refs = input.plan_refs as string[],
      scope = input.location as Record<string, unknown>;
    const tax = input.household as
      { income_annual: number; size: number; tax_filing: string } | undefined;
    if (tax) {
      try {
        parseCents(String(tax.income_annual));
      } catch {
        v.fail("household.income_annual");
      }
    }
    v.premiumRequest({
      plan_ids: refs.filter((id) => !id.includes(":")),
      plan_keys: refs.filter((id) => id.includes(":")),
      ...scope,
      coverage_start: input.coverage_start,
      members: input.members,
      csr_variant: input.csr_variant,
      ...(tax
        ? {
            household_income_annual: tax.income_annual,
            household_size: tax.size,
            tax_filing: tax.tax_filing,
          }
        : {}),
    });
  }
  if (
    tool === "get_plan" &&
    typeof input.plan_ref === "string" &&
    !input.plan_ref.includes(":")
  ) {
    const id = v.planId(input.plan_ref);
    v.checkVariant(
      id.base,
      input.csr_variant as string | undefined,
      id.variant,
    );
  }
  return parsed as ToolInput<T>;
}

/** The public quote body for one native page; the MCP location object flattens to zip/county. */
export function quoteBody(input: Record<string, unknown>, page: number) {
  const body: Record<string, unknown> = {
    ...input,
    ...(input.location as Record<string, unknown>),
  };
  delete body.location;
  delete body.cursor;
  delete body.plan_refs;
  if (input.plan_refs === undefined) body.page = page;
  else body.plan_ids = input.plan_refs;
  return body;
}

type JsonSchema = z.core.JSONSchema.BaseSchema;
function inputJson(tool: ToolName): JsonSchema {
  const schema = z.toJSONSchema(inputSchemas[tool], {
    target: "draft-2020-12",
    io: "input",
  });
  const properties = schema.properties as Record<string, JsonSchema>;
  if (properties.location)
    properties.location.anyOf = [
      { required: ["zip"] },
      { required: ["county"] },
    ];
  for (const field of ["plan_ids", "plan_refs", "rxcuis", "npis"])
    if (properties[field]) properties[field]!.uniqueItems = true;
  if (tool === "search_drugs")
    schema.oneOf = [
      { required: ["query"], not: { required: ["ndc"] } },
      { required: ["ndc"], not: { required: ["query"] } },
    ];
  if (tool === "search_providers") {
    schema.anyOf = [
      "name",
      "npi",
      "taxonomy",
      "specialty",
      "plan_id",
      "zip",
    ].map((field) => ({ required: [field] }));
    schema.dependentRequired = { plan_id: ["year"], radius_miles: ["zip"] };
    schema.not = {
      anyOf: [
        { required: ["taxonomy", "specialty"] },
        ...[
          "name",
          "taxonomy",
          "specialty",
          "type",
          "plan_id",
          "zip",
          "radius_miles",
        ].map((field) => ({ required: ["npi", field] })),
      ],
    };
  }
  return schema;
}
export const inputJsonSchemas = Object.fromEntries(
  toolNames.map((tool) => [tool, inputJson(tool)]),
) as unknown as Record<ToolName, JsonSchemaType>;
export const outputJsonSchemas = Object.fromEntries(
  toolNames.map((tool) => {
    const schema = z.toJSONSchema(outputSchemas[tool], {
      target: "draft-2020-12",
    });
    schema.allOf = [
      {
        if: { properties: { status: { const: "error" } } },
        then: {
          properties: { data: { type: "null" }, error: { type: "object" } },
        },
        else: {
          properties: { data: { type: "object" }, error: { type: "null" } },
        },
      },
    ];
    return [tool, schema];
  }),
) as unknown as Record<ToolName, JsonSchemaType>;

/** Tools that compute premiums; none is cached and all reject personal identifiers. */
export const QUOTING_TOOLS: ReadonlySet<ToolName> = new Set([
  "check_ichra_affordability",
  "quote_premiums",
  "quote_plans",
]);
/** Personalized names; transports require a grant before dispatch. */
export const PERSONALIZED_TOOLS: ReadonlySet<ToolName> = new Set([
  "check_ichra_affordability",
  "quote_premiums",
]);

export class HonestyError extends Error {
  readonly code = "INTERNAL_HONESTY_CHECK";
  constructor(reason: string) {
    super(`INTERNAL_HONESTY_CHECK: ${reason}`);
  }
}
export interface HonestyContext {
  /** Canonical service output captured before projection; required for every estimate or quote, including failures. */
  estimates?:
    | Awaited<ReturnType<typeof estimatePremiums>>["estimates"]
    | Awaited<ReturnType<typeof quotePlans>>["quotes"];
  /** If supplied, reject references to snapshots absent from the repository lookup. */
  snapshotIds?: ReadonlySet<string>;
  /** Unprojected terminology rows; plausible invented identifiers/names must fail too. */
  drugs?: readonly Record<string, unknown>[];
  /** Service output for check_ichra_affordability; projected figures must match it. */
  ichra?: Record<string, unknown>;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function reject(reason: string): never {
  throw new HonestyError(reason);
}

/** Schema validation cannot identify a plausible invented cent: compare against independent service evidence. */
export function assertHonest<T extends ToolName>(
  tool: T,
  value: unknown,
  context: HonestyContext = {},
): asserts value is ToolOutput<T> {
  const checked = outputSchemas[tool].safeParse(value);
  if (!checked.success) reject("invalid output contract");
  const result = checked.data;
  if (!result) reject("invalid output contract");
  if (result.status === "error") {
    if (result.data !== null || result.error === null) reject("error envelope");
  } else if (result.error !== null || result.data === null)
    reject("missing result");
  const sources = new Map(
    result.provenance.map((source) => [source.id, source]),
  );
  if (sources.size !== result.provenance.length) reject("duplicate source IDs");
  for (const source of sources.values()) {
    if (source.status === "available" && !source.snapshot_id)
      reject("missing snapshot");
    if (
      source.snapshot_id &&
      context.snapshotIds &&
      !context.snapshotIds.has(source.snapshot_id)
    )
      reject("nonexistent snapshot");
  }
  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = object(node);
    if (!record) return;
    if ("evidence_refs" in record) {
      const refs = record.evidence_refs as string[],
        missing = record.gaps as string[];
      for (const ref of refs) {
        const source = sources.get(ref);
        if (!source?.snapshot_id || source.status !== "available")
          reject("unresolvable provenance");
      }
      if (!refs.length && !missing.length) reject("missing provenance");
      // A missing-source gap permits only absence/unknown records, never factual positive or negative claims.
      if (
        !refs.length &&
        !["unknown", "not_evaluated"].includes(
          String(record.status ?? record.gross_status ?? ""),
        )
      )
        reject("unsourced factual record");
    }
    if (
      record.status === "not_listed" &&
      record.source_completeness !== "complete"
    )
      reject("not_listed requires complete source set");
    if (
      record.status === "explicitly_not_covered" ||
      record.status === "explicitly_not_participating" ||
      record.status === "listed_covered" ||
      record.status === "listed_participating"
    ) {
      if (record.kind === "drug_coverage" || record.kind === "participation") {
        const evidence = record.evidence as Record<string, unknown>[];
        const cms = object(record.cms_api);
        const cmsStatuses =
          record.kind === "drug_coverage"
            ? {
                Covered: "listed_covered",
                GenericCovered: "listed_covered",
                NotCovered: "explicitly_not_covered",
              }
            : {
                Covered: "listed_participating",
                NotCovered: "explicitly_not_participating",
              };
        const cmsStatus = (cmsStatuses as Record<string, string>)[
          String(cms?.coverage)
        ];
        const cmsReceipt =
          cmsStatus === record.status &&
          (record.evidence_refs as string[]).some((ref) => {
            const source = sources.get(ref);
            return (
              source?.snapshot_id === cms?.snapshot_id &&
              source?.retrieved_at === cms?.sourced_at
            );
          });
        if (
          !cmsReceipt &&
          !evidence.some(
            (row) =>
              row.status === record.status &&
              Array.isArray(row.evidence_refs) &&
              row.evidence_refs.length,
          )
        )
          reject("claim without explicit source record");
      }
    }
    if (
      typeof record.status === "string" &&
      /^(not[ _]covered|out[ _]of[ _]network|denied)$/i.test(record.status)
    )
      reject("unsupported negative vocabulary");
    if (record.kind === "drug") {
      const matched = context.drugs?.some((native) =>
        "rxcui" in record
          ? ["rxcui", "name", "tty", "suppress"].every(
              (field) => native[field] === record[field],
            )
          : record.id === `drug:${native.rxcui}` &&
            record.title === native.name,
      );
      if (!matched) reject("fabricated drug concept");
    }
    if (record.kind === "estimate" || record.kind === "quote") {
      if (
        (record.gross_status === "rated") !==
        (record.gross_monthly_cents !== null)
      )
        reject("unrated numeric premium");
      if (
        record.gross_status === "rated" &&
        !(record.rate_trace as unknown[]).length
      )
        reject("rated without rate evidence");
      const canonical = context.estimates?.find(
        (quote) => quote.plan_id === record.plan_ref,
      );
      if (!canonical) reject("missing canonical estimate");
      const raw = canonical as unknown as Record<string, unknown>;
      const pairs = [
        ["gross_monthly_cents", "total_cents"],
        ["estimated_credit_cents", "estimated_monthly_tax_credit_cents"],
        ["estimated_net_cents", "estimated_net_monthly_cents"],
        ["benchmark_cents", "slcsp_monthly_cents"],
      ] as const;
      if (
        record.gross_status !== raw.status ||
        record.coverage_start !== raw.coverage_start ||
        record.coverage !== raw.coverage
      )
        reject("changed estimate identity/status");
      for (const [projected, native] of pairs)
        if (record[projected] !== (raw[native] ?? null))
          reject("fabricated cents");
      if (record.subsidy_status !== (raw.subsidy_status ?? "not_requested"))
        reject("changed subsidy status");
      if (record.quote_method !== (raw.quote_method ?? "puf_calculation"))
        reject("changed quote method");
      if (
        record.rating_area_id !== (raw.rating_area_id ?? null) ||
        record.filed_column !== (raw.filed_column ?? null)
      )
        reject("changed filed rating scope");
      const rule = object(raw.rule_trace),
        projectedRule = object(record.state_rule_trace);
      if (Boolean(rule) !== Boolean(projectedRule))
        reject("lost filed rule trace");
      if (rule && projectedRule)
        for (const field of [
          "state",
          "tier",
          "nominal_multiplier",
          "citation",
          "references",
        ]) {
          if (
            JSON.stringify(rule[field]) !== JSON.stringify(projectedRule[field])
          )
            reject("changed filed rule trace");
        }
      const rateRows = raw.rate_rows_used as unknown[];
      const rateTrace = record.rate_trace as Record<string, unknown>[];
      if (rateTrace.length !== rateRows.length) reject("lost rate trace");
      rateTrace.forEach((row, i) => {
        const native = object(rateRows[i])!;
        const provenance = object(native.provenance);
        const expected = {
          snapshot_id:
            provenance?.snapshot_id ?? native.publication_snapshot_id,
          source_row: provenance?.source_row ?? null,
          source_record: native.source_record ?? null,
          column: native.column ?? null,
          tier: native.tier ?? null,
          value: native.value ?? null,
          individual_rate_cents: native.individual_rate_cents ?? null,
          individual_tobacco_rate_cents:
            native.individual_tobacco_rate_cents ?? null,
          effective_date: native.effective_date ?? null,
          expiration_date: native.expiration_date ?? null,
          age_band: native.age_band ?? null,
          tobacco: native.tobacco ?? null,
        };
        for (const [key, value] of Object.entries(expected))
          if (row[key] !== value) reject("changed rate evidence");
        const family = object(native.family_rates_cents),
          projectedFamily = object(row.family_rates_cents);
        if (Boolean(family) !== Boolean(projectedFamily))
          reject("lost family rate cells");
        if (family && projectedFamily)
          for (const field of FAMILY_RATE_FIELDS)
            if (family[field] !== projectedFamily[field])
              reject("changed family rate cells");
        if (
          !(row.evidence_refs as string[]).some(
            (ref) => sources.get(ref)?.snapshot_id === expected.snapshot_id,
          )
        )
          reject("lost rate provenance");
      });
      const members = record.members as Record<string, unknown>[],
        nativeMembers = raw.members as Record<string, unknown>[];
      if (members.length !== nativeMembers.length) reject("lost member trace");
      members.forEach((member, i) => {
        for (const field of [
          "member_id",
          "age",
          "relationship",
          "tobacco",
          "charged",
          "status",
          "premium_cents",
        ]) {
          if (member[field] !== nativeMembers[i]![field])
            reject("changed member trace");
        }
      });
      const dental = record.dental_business_rules as Record<string, unknown>[],
        nativeDental = (raw.dental_business_rules ?? []) as Record<
          string,
          unknown
        >[];
      if (dental.length !== nativeDental.length)
        reject("lost dental business rules");
      dental.forEach((row, i) => {
        const native = nativeDental[i]!;
        if (
          row.snapshot_id !== native.snapshot_id ||
          row.source_row !== native.source_row
        )
          reject("changed dental business provenance");
        const fields = row.fields as { field: string; raw: string }[],
          nativeFields = object(native.raw)!;
        if (
          fields.length !== Object.keys(nativeFields).length ||
          new Set(fields.map((f) => f.field)).size !== fields.length
        )
          reject("lost dental fields");
        for (const field of fields)
          if (field.raw !== nativeFields[field.field])
            reject("changed dental fields");
      });
      const pediatric = object(record.pediatric_ehb),
        nativePediatric = object(raw.pediatric_ehb);
      if (Boolean(pediatric) !== Boolean(nativePediatric))
        reject("lost pediatric trace");
      if (pediatric && nativePediatric)
        for (const field of [
          "status",
          "monthly_cents",
          "pediatric_gross_cents",
          "fraction",
          "field",
          "reason",
          "citation",
        ]) {
          if (pediatric[field] !== (nativePediatric[field] ?? null))
            reject("changed pediatric allocation");
        }
      const subsidy = object(record.subsidy),
        nativeSubsidy = object(raw.subsidy);
      if (Boolean(subsidy) !== Boolean(nativeSubsidy))
        reject("lost subsidy trace");
      if (subsidy && nativeSubsidy) {
        for (const field of [
          "status",
          "reason",
          "rounding_policy",
          "fpl_percent",
          "applicable_percentage",
          "expected_contribution_monthly_cents",
          "expected_contribution_annual_cents",
          "enrollment_ehb_monthly_cents",
        ]) {
          if (subsidy[field] !== nativeSubsidy[field])
            reject("changed subsidy trace");
        }
        const benchmark = object(subsidy.benchmark)!,
          nativeBenchmark = object(nativeSubsidy.benchmark)!;
        for (const field of [
          "status",
          "slcsp_monthly_cents",
          "silver_plan_count",
        ])
          if (benchmark[field] !== nativeBenchmark[field])
            reject("changed benchmark trace");
        if (
          JSON.stringify(benchmark.benchmark_plan_ids) !==
          JSON.stringify(nativeBenchmark.benchmark_plan_ids)
        )
          reject("changed benchmark plans");
        const ranked = benchmark.lowest_silver_plans as Record<
            string,
            unknown
          >[],
          nativeRanked = nativeBenchmark.lowest_silver_plans as Record<
            string,
            unknown
          >[];
        if (ranked.length !== nativeRanked.length)
          reject("lost benchmark ranking");
        ranked.forEach((plan, i) => {
          for (const field of [
            "plan_id",
            "gross_monthly_cents",
            "ehb_monthly_cents",
            "benchmark_monthly_cents",
            "pediatric_dental_adjustment_cents",
            "ehb_fraction",
          ]) {
            if (plan[field] !== nativeRanked[i]![field])
              reject("changed benchmark ranking");
          }
        });
      }
    }
    if (
      QUOTING_TOOLS.has(tool) &&
      ["email", "phone", "ssn", "dob", "dateOfBirth"].some(
        (field) => field in record,
      )
    )
      reject("personal data in estimate");
    if (
      tool === "quote_plans" &&
      Object.keys(record).some((key) =>
        /^(household|income|tax_filing)/.test(key),
      )
    )
      reject("household data in public quote");
    for (const child of Object.values(record)) walk(child);
  }
  walk(result.data);
  if (tool === "check_ichra_affordability" && context.ichra)
    assertIchraHonest(object(result.data)!, context.ichra);
}

/** Every projected LCSP figure and verdict must equal the service output it came from. */
function assertIchraHonest(
  data: Record<string, unknown>,
  native: Record<string, unknown>,
) {
  if (data.status !== native.status) reject("changed ICHRA status");
  for (const projected of (data.lcsps as Record<string, unknown>[]) ?? []) {
    const source = object(
      native[projected.use === "employer" ? "employer_lcsp" : "lcsp"],
    );
    if (
      !source ||
      projected.monthly_cents !== source.monthly_cents ||
      JSON.stringify(projected.plan_ids) !== JSON.stringify(source.plan_ids)
    )
      reject("changed ICHRA LCSP");
  }
  const verdicts = (data.verdicts as Record<string, unknown>[]) ?? [],
    sources = (native.verdicts as Record<string, unknown>[] | undefined) ?? [];
  if (verdicts.length !== sources.length) reject("changed ICHRA verdicts");
  verdicts.forEach((verdict, i) => {
    const source = sources[i]!;
    if (
      verdict.measure !== source.measure ||
      verdict.affordable !== source.affordable ||
      JSON.stringify(verdict.required_hra_contribution_cents) !==
        JSON.stringify(source.required_hra_contribution_cents) ||
      JSON.stringify(verdict.threshold_cents) !==
        JSON.stringify(source.threshold_cents)
    )
      reject("changed ICHRA verdict");
  });
}
