import type { planView } from "../../api/repository.js";
import type { withSubsidy } from "../../api/subsidies.js";
import type {
  FEDERAL_PLAN_ATTRIBUTES,
  PublishedPlanAttributes,
} from "../../api/plan-view.js";

type View = Awaited<ReturnType<typeof planView>>;
type Estimate = ReturnType<typeof withSubsidy>;

/** Keep native evidence on native routes; the compatibility body has its own vocabulary. */
export function planResponse(
  plan: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...plan };
  for (const key of [
    "hios_match_reason",
    "hios_candidates",
    "hios_match_rule",
    "hios_match_provenance",
  ])
    delete result[key];
  for (const key of ["source", "premium_source"]) {
    // A state filing is neither a carrier feed nor a CMS feed.
    if (result[key] === "state_filed_tier") result[key] = null;
  }
  return result;
}

// Medical search/detail wire field names. Unknown
// evidence stays null; these are a wire vocabulary, never copied plan data.
const unknownPlanFields = `plan_type sbc_name adult_dental age29_rider benefits_summary_url buy_link
carrier_disclaimers customer_service_phone_number dp_rider drug_formulary_url effective_date expiration_date
fp_rider hsa_eligible imaging logo_url out_of_network_coverage preferred_brand_drugs prenatal_postnatal_care
ambulance child_eyewear child_eye_exam durable_medical_equipment diagnostic_test emergency_room
family_drug_deductible family_drug_moop family_medical_deductible family_medical_moop generic_drugs
habilitation_services home_health_care hospice_service individual_drug_deductible individual_drug_moop
individual_medical_deductible individual_medical_moop inpatient_birth inpatient_facility inpatient_mental_health
inpatient_physician inpatient_substance non_preferred_brand_drugs outpatient_facility outpatient_mental_health
outpatient_physician outpatient_substance preventative_care primary_care_physician rehabilitation_services
skilled_nursing specialist specialty_drugs urgent_care actuarial_value chiropractic_services coinsurance
embedded_deductible gated mail_order_rx plan_calendar skilled_nursing_facility_365 child_dental imaging_center
imaging_physician lab_test nonpreferred_generic_drug_share nonpreferred_specialty_drug_share
outpatient_ambulatory_care_center prenatal_care postnatal_care estimated_actuarial_value
essential_health_benefits_percentage abortion_rider plan_coinsurance inpatient_birth_physician
infertility_treatment_rider telemedicine standardized_plan quoted_via_carrier_api network_size updated_at type`;

/** Exact conversions from one published variant row; never borrow another plan's URL. */
export function mapPlanColumns(
  raw: PublishedPlanAttributes | undefined,
  variant: string | null,
  year: number,
  state: string,
): Record<string, unknown> {
  if (
    !raw ||
    !variant ||
    raw.PlanId !== variant ||
    raw.StandardComponentId !== variant.slice(0, 14) ||
    raw.BusinessYear !== String(year) ||
    raw.StateCode !== state
  )
    return {};
  const date = (value: string | undefined) => {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value?.trim() ?? "");
    if (!match) return null;
    const [, month, day, y] = match;
    const parsed = new Date(
      Date.UTC(Number(y), Number(month) - 1, Number(day)),
    );
    return parsed.getUTCFullYear() === Number(y) &&
      parsed.getUTCMonth() === Number(month) - 1 &&
      parsed.getUTCDate() === Number(day)
      ? parsed.toISOString()
      : null;
  };
  const url = (value: string | undefined) => {
    if (!value?.trim()) return null;
    try {
      const parsed = new URL(value.trim());
      return ["https:", "http:"].includes(parsed.protocol) &&
        !parsed.username &&
        !parsed.password
        ? value.trim()
        : null;
    } catch {
      return null;
    }
  };
  const hsa = raw.IsHSAEligible?.trim();
  return {
    plan_type: raw.PlanType?.trim() || null,
    hsa_eligible:
      ({ Yes: true, No: false } as Record<string, boolean>)[hsa ?? ""] ?? null,
    effective_date: date(raw.PlanEffectiveDate),
    expiration_date: date(raw.PlanExpirationDate),
    drug_formulary_url: url(raw.FormularyURL),
  };
}

export function mapPlan(
  view: View,
  requestedId: string,
  serviceAreaId: string | null = null,
): Record<string, unknown> {
  const federalAttributes: typeof FEDERAL_PLAN_ATTRIBUTES = Symbol.for(
    "openplans.federal_plan_attributes",
  ) as typeof FEDERAL_PLAN_ATTRIBUTES;
  const names = view.issuer.marketing_names;
  const name = Array.isArray(names)
    ? (names.find((n) => typeof n === "string" && n.length > 0) ?? null)
    : null;
  const stateFiled = "plan_key" in view;
  const on = typeof view.on_exchange === "boolean" ? view.on_exchange : null;
  const off = typeof view.off_exchange === "boolean" ? view.off_exchange : null;
  return {
    ...Object.fromEntries(
      unknownPlanFields.split(/\s+/).map((key) => [key, null]),
    ),
    ...mapPlanColumns(
      view.cost_sharing[federalAttributes] ??
        view.cost_sharing.published_attributes,
      view.cost_sharing.selected_variant_id,
      view.plan_year,
      view.state,
    ),
    id: requestedId,
    name: view.plan_name,
    display_name: view.plan_name,
    source: stateFiled ? "state_filed_tier" : "cms_puf",
    hios_issuer_id: view.issuer.issuer_id,
    carrier_name: name,
    carrier: {
      id: view.issuer.issuer_id,
      issuer_id: view.issuer.issuer_id,
      name,
      logo_url: null,
    },
    level: view.metal.toLowerCase().replaceAll(" ", "_"),
    on_market: on,
    off_market: off,
    plan_market:
      on === null || off === null
        ? null
        : on && off
          ? "both"
          : on
            ? "on_market"
            : off
              ? "off_market"
              : null,
    service_area_id:
      serviceAreaId === null
        ? null
        : `${view.issuer.issuer_id}-${view.plan_year}-${serviceAreaId}-${view.market}`,
    identifiers:
      view.base_plan_id === null
        ? []
        : [
            {
              type: "hios_id",
              value: stateFiled ? view.base_plan_id : requestedId,
            },
          ],
    plan_documents: [],
    ...(stateFiled
      ? {
          plan_key: view.plan_key,
          hios_id: view.hios_id,
          ...(view.state === "VT"
            ? {
                hios_match: view.hios_match,
                hios_match_reason: view.hios_match_reason,
                hios_candidates: view.hios_candidates,
                hios_match_rule: view.hios_match_rule,
                hios_match_provenance: view.hios_match_provenance,
              }
            : {}),
        }
      : {}),
    networks: view.network.records.map((n) => ({
      id: null,
      name: n.network_name,
      provider_directory_url: n.network_url ?? null,
    })),
    network_ids: [],
    plan_ancestors: [],
    ratings: [],
    providers: [],
  };
}

export function mapQuote(estimate: Estimate): Record<string, unknown> {
  return {
    premium:
      "total_cents" in estimate ? Number(estimate.total_cents) / 100 : null,
    premium_subsidized:
      "estimated_net_monthly_cents" in estimate &&
      estimate.estimated_net_monthly_cents !== null
        ? estimate.estimated_net_monthly_cents / 100
        : null,
    premium_source:
      "quote_method" in estimate && estimate.quote_method === "state_filed_tier"
        ? "state_filed_tier"
        : "cms_puf",
    premiums_by_applicant: estimate.members.map((member) => ({
      age: member.age,
      child: member.relationship === "child",
      smoker: member.tobacco,
      premium:
        member.premium_cents === null ? null : member.premium_cents / 100,
      composite_rated: false,
      waived_for_total: !member.charged,
    })),
  };
}

export const emptySearch = () => ({
  meta: {
    total: 0,
    eligible_for_chip_medicaid: null,
    premium_tax_credit: null,
    state_subsidy: null,
  },
  coverages: [],
  plans: [],
});

export const PLAN_GAPS = [
  "off_exchange_catalog_incomplete",
  "subsidies_unavailable",
  "plan_metadata_and_benefit_summaries_unmapped",
  "vendor_network_ids_unavailable",
  "carrier_ids_are_cms_issuer_ids",
];

export interface NativeBenefit {
  published_plan_id: string;
  benefit_name: string;
  cost_sharing_raw: Record<string, string>;
  raw: Record<string, string>;
}
const benefitFields: Record<string, string> = {
  primary_care_physician: "Primary Care Visit to Treat an Injury or Illness",
  specialist: "Specialist Visit",
  emergency_room: "Emergency Room Services",
  urgent_care: "Urgent Care Centers or Facilities",
  preventative_care: "Preventive Care/Screening/Immunization",
  generic_drugs: "Generic Drugs",
  preferred_brand_drugs: "Preferred Brand Drugs",
  non_preferred_brand_drugs: "Non-Preferred Brand Drugs",
  specialty_drugs: "Specialty Drugs",
  ambulance: "Emergency Transportation/Ambulance",
  imaging: "Imaging (CT/PET Scans, MRIs)",
  lab_test: "Laboratory Outpatient and Professional Services",
  diagnostic_test: "X-rays and Diagnostic Imaging",
  inpatient_facility: "Inpatient Hospital Services (e.g., Hospital Stay)",
  inpatient_physician: "Inpatient Physician and Surgical Services",
  inpatient_birth: "Delivery and All Inpatient Services for Maternity Care",
  inpatient_mental_health: "Mental/Behavioral Health Inpatient Services",
  inpatient_substance: "Substance Abuse Disorder Inpatient Services",
  outpatient_facility:
    "Outpatient Facility Fee (e.g., Ambulatory Surgery Center)",
  outpatient_physician: "Outpatient Surgery Physician/Surgical Services",
  outpatient_mental_health: "Mental/Behavioral Health Outpatient Services",
  outpatient_substance: "Substance Abuse Disorder Outpatient Services",
  rehabilitation_services: "Outpatient Rehabilitation Services",
  habilitation_services: "Habilitation Services",
  skilled_nursing: "Skilled Nursing Facility",
  home_health_care: "Home Health Care Services",
  hospice_service: "Hospice Services",
  durable_medical_equipment: "Durable Medical Equipment",
  prenatal_postnatal_care: "Prenatal and Postnatal Care",
  child_eye_exam: "Routine Eye Exam for Children",
  child_eyewear: "Eye Glasses for Children",
  child_dental: "Dental Check-Up for Children",
};
function benefitText(benefit: NativeBenefit): string | null {
  // Retain publisher conditions verbatim. Never infer zero cost from a blank,
  // Not Applicable, or a missing coinsurance cell. Tier 2 is labelled separately.
  const tier = (copay: string, coins: string) =>
    [
      benefit.cost_sharing_raw[copay]?.trim()
        ? `Copay: ${benefit.cost_sharing_raw[copay]!.trim()}`
        : null,
      benefit.cost_sharing_raw[coins]?.trim()
        ? `Coinsurance: ${benefit.cost_sharing_raw[coins]!.trim()}`
        : null,
    ]
      .filter(Boolean)
      .join("; ");
  const inside = tier("CopayInnTier1", "CoinsInnTier1"),
    outside = tier("CopayOutofNet", "CoinsOutofNet");
  const tier2 = tier("CopayInnTier2", "CoinsInnTier2");
  const covered = benefit.raw.IsCovered;
  if (
    !inside &&
    !outside &&
    !tier2 &&
    !["Yes", "No", "Covered", "Not Covered"].includes(covered ?? "")
  )
    return null;
  const conditions = [
    benefit.raw.QuantLimitOnSvc === "Yes"
      ? `limit: ${[benefit.raw.LimitQty, benefit.raw.LimitUnit].filter(Boolean).join(" ") || "applies; quantity unknown"}`
      : null,
    ...(
      [
        ["Exclusions", "exclusions"],
        ["Explanation", "explanation"],
        ["EHBVarReason", "EHB variation"],
        ["IsExclFromInnMOOP", "excluded from in-network MOOP"],
        ["IsExclFromOonMOOP", "excluded from out-of-network MOOP"],
        ["MinimumStay", "minimum stay"],
        ["IsSubjectedToDedTier1", "subject to tier 1 deductible"],
        ["IsSubjectedToDedTier2", "subject to tier 2 deductible"],
      ] as const
    ).map(([key, label]) =>
      benefit.raw[key]?.trim() ? `${label}: ${benefit.raw[key]!.trim()}` : null,
    ),
  ].filter(Boolean);
  let summary = "Coverage: Covered";
  if (["No", "Not Covered"].includes(covered ?? ""))
    summary = "Coverage: Not Covered";
  else if (inside || outside || tier2)
    summary =
      `In-Network: ${inside || "unknown"} / Out-of-Network: ${outside || "unknown"}` +
      (tier2 ? ` / In-Network Tier 2: ${tier2}` : "");
  return summary + (conditions.length ? ` | ${conditions.join(" | ")}` : "");
}
/** Map only the selected variant's published service rows. */
export function mapVariantBenefits(
  benefits: NativeBenefit[],
  variant: string,
): Record<string, unknown> {
  const rows = benefits.filter((row) => row.published_plan_id === variant),
    mapped: Record<string, unknown> = {};
  for (const [field, name] of Object.entries(benefitFields)) {
    const values = rows
      .filter((row) => row.benefit_name === name)
      .map(benefitText);
    if (values.length && new Set(values).size === 1) mapped[field] = values[0];
  }
  const chiro = rows
    .filter((row) => row.benefit_name === "Chiropractic Care")
    .map((row) => row.raw.IsCovered);
  if (chiro.length && new Set(chiro).size === 1)
    mapped.chiropractic_services =
      (
        { Yes: true, Covered: true, No: false, "Not Covered": false } as Record<
          string,
          boolean
        >
      )[chiro[0] ?? ""] ?? null;
  return mapped;
}

/** Existing wire summary fields retain publisher text, including accumulator scope. */
export function mapVariantAccumulators(
  sharing: View["cost_sharing"],
): Record<string, unknown> {
  if (sharing.status !== "available") return {};
  const text = (group: "deductibles" | "moop", key: string) =>
    sharing[group][key]?.raw.trim() || null;
  const summary = (
    group: "deductibles" | "moop",
    prefix: string,
    network: string,
    family: boolean,
  ) => {
    const suffix = group === "moop" ? "MOOP" : "";
    const key = `${prefix}${group === "deductibles" ? "Ded" : ""}${network}`;
    if (!family) return text(group, `${key}Individual${suffix}`);
    const person = text(group, `${key}FamilyPerPerson${suffix}`),
      total = text(group, `${key}FamilyPerGroup${suffix}`);
    return person || total
      ? `Per person: ${person ?? "unknown"}; per group: ${total ?? "unknown"}`
      : text(group, `${key}Family${suffix}`);
  };
  const result: Record<string, unknown> = {};
  for (const group of ["deductibles", "moop"] as const) {
    const integrated =
      (group === "deductibles"
        ? sharing.medical_drug_deductibles_integrated
        : sharing.medical_drug_moop_integrated) === "Yes";
    for (const [scope, prefix] of [
      ["medical", integrated ? "TEHB" : "MEHB"],
      ["drug", integrated ? "TEHB" : "DEHB"],
    ] as const) {
      for (const family of [false, true]) {
        const values = (
          [
            ["In-Network Tier 1", "InnTier1"],
            ["Out-of-Network", "OutOfNet"],
            ["In-Network Tier 2", "InnTier2"],
            ["Combined in/out of network", "CombInnOon"],
          ] as const
        )
          .map(([label, network]) => {
            const value = summary(group, prefix, network, family);
            return value ? `${label}: ${value}` : null;
          })
          .filter(Boolean);
        result[
          `${family ? "family" : "individual"}_${scope}_${group === "deductibles" ? "deductible" : "moop"}`
        ] = values.length
          ? (integrated ? "Medical and drug combined | " : "") +
            values.join(" / ")
          : null;
      }
    }
  }
  return result;
}
