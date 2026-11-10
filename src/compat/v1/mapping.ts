import type { HouseholdMember } from "../../domain/rating/types.js";
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
    if (result[key] === "cms_puf") result[key] = "cms";
    if (result[key] === "state_filed_tier") result[key] = "state";
  }
  if (result.plan_market === "both") result.plan_market = "both_markets";
  // Coverage is reported by its own envelope, never an empty plan-level extension.
  if (Array.isArray(result.providers) && !result.providers.length)
    delete result.providers;
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

const yesNo = (value: string | undefined) =>
  (({ Yes: true, No: false }) as Record<string, boolean>)[
    value?.trim() ?? ""
  ] ?? null;

/** Issuer-reported AV cells are published as percentages, e.g. "70.04%". */
const percent = (value: string | undefined) => {
  const match = /^(\d{1,3}(?:\.\d+)?)%$/.exec(value?.trim() ?? "");
  return match ? Number(match[1]) : null;
};

/** EHBPercentTotalPremium is a fraction ("0.9609"); shift the decimal point without float error. */
const fractionAsPercent = (value: string | undefined) => {
  // State publications print the same share as a percentage ("99%").
  if (value?.trim().endsWith("%")) {
    const share = percent(value);
    return share !== null && share <= 100 ? share : null;
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const result = Number(
    `${match[1]}${fraction.slice(0, 2)}.${fraction.slice(2) || "0"}`,
  );
  return result <= 100 ? result : null;
};

/** DesignType names a standardized plan option design ("Design 1"); "Not Applicable" means none. */
const standardizedDesign = (value: string | undefined) => {
  const design = value?.trim() ?? "";
  if (/^Design \d+$/.test(design)) return true;
  return design === "Not Applicable" ? false : null;
};

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
  return {
    plan_type: raw.PlanType?.trim() || null,
    hsa_eligible: yesNo(raw.IsHSAEligible),
    gated: yesNo(raw.IsReferralRequiredForSpecialist),
    sbc_name: raw.PlanVariantMarketingName?.trim() || null,
    actuarial_value: percent(raw.IssuerActuarialValue),
    effective_date: date(raw.PlanEffectiveDate),
    expiration_date: date(raw.PlanExpirationDate),
    drug_formulary_url: url(raw.FormularyURL),
    // The issuer's own published document links, never a re-hosted copy.
    benefits_summary_url: url(raw.URLForSummaryofBenefitsCoverage),
    plan_documents: [
      [
        "summary_of_benefits_and_coverage",
        url(raw.URLForSummaryofBenefitsCoverage),
      ],
      ["plan_brochure", url(raw.PlanBrochure)],
    ]
      .filter(([, link]) => link !== null)
      .map(([type, link]) => ({ type, url: link })),
    standardized_plan: standardizedDesign(raw.DesignType),
    essential_health_benefits_percentage: fractionAsPercent(
      raw.EHBPercentTotalPremium,
    ),
    plan_calendar: calendarYear(
      raw.PlanEffectiveDate,
      raw.PlanExpirationDate,
      year,
    ),
  };
}

/** A plan year that starts on January 1 and ends on December 31 of the business year. */
function calendarYear(
  effective: string | undefined,
  expiration: string | undefined,
  year: number,
) {
  return effective?.trim() === `1/1/${year}` &&
    expiration?.trim() === `12/31/${year}`
    ? "calendar_year"
    : null;
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
  // A state filing without metal or exchange cells uses the matched CMS state PUF row.
  const supplemental =
    "supplemental_plan" in view ? view.supplemental_plan : undefined;
  const metal =
    view.metal === "unknown" && supplemental ? supplemental.metal : view.metal;
  const on =
    typeof view.on_exchange === "boolean"
      ? view.on_exchange
      : (supplemental?.on_exchange ?? null);
  const off =
    typeof view.off_exchange === "boolean"
      ? view.off_exchange
      : (supplemental?.off_exchange ?? null);
  const columns = mapPlanColumns(
    view.cost_sharing[federalAttributes] ??
      view.cost_sharing.published_attributes,
    view.cost_sharing.selected_variant_id,
    view.plan_year,
    view.state,
  );
  function marketplaceAvailability() {
    if (on === null || off === null) {
      return null;
    } else if (on && off) {
      return "both";
    } else if (on) {
      return "on_market";
    } else if (off) {
      return "off_market";
    } else {
      return null;
    }
  }
  return {
    ...Object.fromEntries(
      unknownPlanFields.split(/\s+/).map((key) => [key, null]),
    ),
    ...columns,
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
    level: metal.toLowerCase().replaceAll(" ", "_"),
    on_market: on,
    off_market: off,
    plan_market: marketplaceAvailability(),
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
    plan_documents: columns.plan_documents ?? [],
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
    // A blank NetworkURL cell publishes no directory, so the key is omitted, not "".
    networks: view.network.records.map((n) => {
      const directory =
        typeof n.network_url === "string" ? n.network_url.trim() : "";
      return {
        id: cmsNetworkId(
          view.issuer.issuer_id,
          view.plan_year,
          n.network_id,
          view.market,
        ),
        name: n.network_name,
        ...(directory ? { provider_directory_url: directory } : {}),
      };
    }),
    network_ids: view.network.records.flatMap(
      (n) =>
        cmsNetworkId(
          view.issuer.issuer_id,
          view.plan_year,
          n.network_id,
          view.market,
        ) ?? [],
    ),
    plan_ancestors:
      "lineage" in view
        ? view.lineage.ancestors.map((a) => ({ id: a.id, year: a.year }))
        : [],
    ratings: [],
    providers: [],
  };
}

/**
 * CMS network IDs (e.g. "TXN001") are unique only per issuer, year and market, so the
 * served ID carries that scope, like service_area_id.
 */
export function cmsNetworkId(
  issuerId: unknown,
  year: number,
  networkId: unknown,
  market: string,
): string | null {
  if (typeof networkId !== "string" || !networkId) return null;
  return `${String(issuerId)}-${year}-${networkId}-${market.toLowerCase().replaceAll(" ", "_")}`;
}

export function mapQuote(
  estimate: Estimate,
  requestedMembers: readonly HouseholdMember[] = [],
): Record<string, unknown> {
  // NY and VT filings publish contract-tier totals, not per-member prices.
  const unallocatedStateTier =
    "state" in estimate &&
    (estimate.state === "NY" || estimate.state === "VT") &&
    "quote_method" in estimate &&
    estimate.quote_method === "state_filed_tier" &&
    estimate.members.length === 0;
  const applicants = unallocatedStateTier
    ? requestedMembers.map((member) => ({
        age: member.age ?? null,
        child: member.relationship === "child",
        smoker: member.tobaccoUse,
        premium: null,
        composite_rated: false,
        waived_for_total: null,
      }))
    : estimate.members.map((member) => ({
        age: member.age,
        child: member.relationship === "child",
        smoker: member.tobacco,
        premium:
          member.premium_cents === null ? null : member.premium_cents / 100,
        composite_rated: false,
        waived_for_total: !member.charged,
      }));
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
    premiums_by_applicant: applicants,
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
  "network_ids_are_cms_network_ids",
];

export interface NativeBenefit {
  published_plan_id: string;
  benefit_name: string;
  cost_sharing_raw: Record<string, string>;
  raw: Record<string, string>;
}
// Each wire field reads the named Benefits and Cost Sharing PUF row(s) of the variant.
const benefitFields: Record<string, string | readonly string[]> = {
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
  outpatient_ambulatory_care_center:
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
  // One published row covers both prenatal and postnatal care.
  prenatal_care: "Prenatal and Postnatal Care",
  postnatal_care: "Prenatal and Postnatal Care",
  // Issuers spell these optional rows differently; conflicting rows stay unknown.
  nonpreferred_generic_drug_share: [
    "Non-Preferred Generic",
    "Non-Preferred Generic Drugs",
  ],
  nonpreferred_specialty_drug_share: [
    "Non-Preferred Specialty Drugs",
    "Non Preferred Specialty Drugs",
  ],
  child_eye_exam: "Routine Eye Exam for Children",
  child_eyewear: "Eye Glasses for Children",
  child_dental: "Dental Check-Up for Children",
};
const benefitConditionColumns = [
  ["Exclusions", "exclusions"],
  ["Explanation", "explanation"],
  ["EHBVarReason", "EHB variation"],
  ["IsExclFromInnMOOP", "excluded from in-network MOOP"],
  ["IsExclFromOonMOOP", "excluded from out-of-network MOOP"],
  ["MinimumStay", "minimum stay"],
  ["IsSubjectedToDedTier1", "subject to tier 1 deductible"],
  ["IsSubjectedToDedTier2", "subject to tier 2 deductible"],
] as const;
const compactHeader = (key: string) =>
  key.replace(/[^a-z0-9]/gi, "").toLowerCase();
const benefitHeaders = new Map(
  [
    "IsCovered",
    "QuantLimitOnSvc",
    "LimitQty",
    "LimitUnit",
    ...benefitConditionColumns.map(([key]) => key),
  ].map((key) => [compactHeader(key), key]),
);
for (const [alias, key] of [
  ["QuantityLimitOnSvc", "QuantLimitOnSvc"],
  ["LimitQuantity", "LimitQty"],
  ["IsExcludedFromInnMOOP", "IsExclFromInnMOOP"],
  ["IsExcludedFromOonMOOP", "IsExclFromOonMOOP"],
] as const)
  benefitHeaders.set(compactHeader(alias), key);

/** Federal and state publications use different spellings for the same columns. */
function benefitCells(raw: NativeBenefit["raw"]): NativeBenefit["raw"] | null {
  const cells: NativeBenefit["raw"] = {};
  for (const [header, value] of Object.entries(raw)) {
    const key = benefitHeaders.get(compactHeader(header));
    if (!key) continue;
    if (cells[key] !== undefined && cells[key] !== value.trim()) return null;
    cells[key] = value.trim();
  }
  return cells;
}

function benefitConditions(raw: NativeBenefit["raw"]): string[] {
  const limit = [raw.LimitQty?.trim(), raw.LimitUnit?.trim()]
    .filter(Boolean)
    .join(" ");
  let quantityLimit: string | null = null;
  if (raw.QuantLimitOnSvc?.trim() === "Yes")
    quantityLimit = `limit: ${limit || "applies; quantity unknown"}`;
  else if (limit)
    quantityLimit = `published limit: ${limit}; applicability: ${raw.QuantLimitOnSvc?.trim() || "unknown"}`;
  return [
    quantityLimit,
    ...benefitConditionColumns.map(([key, label]) =>
      raw[key]?.trim() ? `${label}: ${raw[key]!.trim()}` : null,
    ),
  ].filter((condition): condition is string => condition !== null);
}

function benefitText(benefit: NativeBenefit): string | null {
  const raw = benefitCells(benefit.raw);
  if (!raw) return null;
  // Cost cells include their own deductible and payment basis. Keep them verbatim.
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
  const covered = raw.IsCovered;
  const conditions = benefitConditions(raw);
  if (
    !inside &&
    !outside &&
    !tier2 &&
    !["Yes", "No", "Covered", "Not Covered"].includes(covered ?? "") &&
    !conditions.length
  )
    return null;
  let summary = ["Yes", "Covered"].includes(covered ?? "")
    ? "Coverage: Covered"
    : "Coverage: unknown";
  if (["No", "Not Covered"].includes(covered ?? ""))
    summary = "Coverage: Not Covered";
  else if (inside || outside || tier2)
    summary =
      `In-Network: ${inside || "unknown"} / Out-of-Network: ${outside || "unknown"}` +
      (tier2 ? ` / In-Network Tier 2: ${tier2}` : "");
  return summary + (conditions.length ? ` | ${conditions.join(" | ")}` : "");
}
/** Map only the selected variant's published service rows. */
/** Opt-in compact rendering (owner policy pending); verbose text stays the default. */
export interface BenefitTextOptions {
  compact?: boolean;
}
export function mapVariantBenefits(
  benefits: NativeBenefit[],
  variant: string,
  options: BenefitTextOptions = {},
): Record<string, unknown> {
  const rows = benefits.filter((row) => row.published_plan_id === variant),
    mapped: Record<string, unknown> = {};
  for (const [field, name] of Object.entries(benefitFields)) {
    const names: readonly string[] = typeof name === "string" ? [name] : name;
    const values = rows
      .filter((row) => names.includes(row.benefit_name))
      .map(options.compact ? compactBenefitText : benefitText);
    if (values.length && new Set(values).size === 1) mapped[field] = values[0];
  }
  const outOfNetwork = outOfNetworkCoverage(rows);
  if (outOfNetwork) mapped.out_of_network_coverage = outOfNetwork;
  for (const [field, name] of Object.entries(coverageFlags)) {
    const covered = rows
      .filter((row) => row.benefit_name === name)
      .map((row) => benefitCells(row.raw)?.IsCovered);
    if (covered.length && new Set(covered).size === 1)
      mapped[field] = coveredFlag[covered[0] ?? ""] ?? null;
  }
  return mapped;
}

// Office visits show out-of-network network design; emergency rows do not, because
// emergency cost sharing follows in-network rules regardless of network.
const outOfNetworkVisitRows = [
  "Primary Care Visit to Treat an Injury or Illness",
  "Specialist Visit",
];
/**
 * True when a covered office-visit row publishes an out-of-network cost below 100%.
 * A 100% coinsurance or "Not Applicable" cell is not evidence that coverage is absent,
 * so the field is never set to false.
 */
function outOfNetworkCoverage(rows: NativeBenefit[]) {
  const pays = (row: NativeBenefit) => {
    const copay = row.cost_sharing_raw.CopayOutofNet?.trim() ?? "",
      coins = row.cost_sharing_raw.CoinsOutofNet?.trim() ?? "";
    const share = /^(\d{1,3}(?:\.\d+)?)%/.exec(coins);
    if (share !== null && Number(share[1]) >= 100) return false;
    return (
      /^(?:\$\d|No Charge)/.test(copay) ||
      share !== null ||
      /^No Charge/.test(coins)
    );
  };
  return rows.some(
    (row) =>
      outOfNetworkVisitRows.includes(row.benefit_name) &&
      ["Yes", "Covered"].includes(benefitCells(row.raw)?.IsCovered ?? "") &&
      pays(row),
  )
    ? true
    : null;
}

// Boolean wire fields read the IsCovered cell of one named Benefits PUF row.
const coverageFlags: Record<string, string> = {
  chiropractic_services: "Chiropractic Care",
  adult_dental: "Routine Dental Services (Adult)",
  infertility_treatment_rider: "Infertility Treatment",
};
const coveredFlag: Record<string, boolean> = {
  Yes: true,
  Covered: true,
  No: false,
  "Not Covered": false,
};

/** Medical and drug accumulator column prefixes; an integrated design files both under TEHB. */
const accumulatorScopes = (integrated: boolean) =>
  [
    ["medical", integrated ? "TEHB" : "MEHB"],
    ["drug", integrated ? "TEHB" : "DEHB"],
  ] as const;
/** Existing wire summary fields retain publisher text, including accumulator scope. */
export function mapVariantAccumulators(
  sharing: View["cost_sharing"],
  options: BenefitTextOptions = {},
): Record<string, unknown> {
  if (sharing.status !== "available") return {};
  if (options.compact)
    return { ...deductibleDesign(sharing), ...compactAccumulators(sharing) };
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
  const result: Record<string, unknown> = deductibleDesign(sharing);
  for (const group of ["deductibles", "moop"] as const) {
    const integrated =
      (group === "deductibles"
        ? sharing.medical_drug_deductibles_integrated
        : sharing.medical_drug_moop_integrated) === "Yes";
    for (const [scope, prefix] of accumulatorScopes(integrated)) {
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

/** Whole-dollar or cent amounts such as "$1,500" or "$7500.00"; anything else is unknown. */
function dollarCents(value: string | undefined) {
  const match = /^\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(
    value?.trim() ?? "",
  );
  return match
    ? Number(match[1]!.replaceAll(",", "")) * 100 +
        Number((match[2] ?? "").padEnd(2, "0"))
    : null;
}

/**
 * Family per-person and per-group amounts. Federal rows publish two cells; state
 * publications combine them as "$1500 per person | $3000 per group".
 */
function familyAmounts(sharing: View["cost_sharing"], key: string) {
  const combined =
    /^(.+?) per person \| (.+?) per group$/.exec(
      sharing.deductibles[`${key}Family`]?.raw.trim() ?? "",
    ) ?? [];
  const cell = (scope: string) =>
    sharing.deductibles[`${key}Family${scope}`]?.raw
      .trim()
      .replace(/ per (?:person|group)$/, "");
  return {
    person: dollarCents(cell("PerPerson") ?? combined[1]),
    group: dollarCents(cell("PerGroup") ?? combined[2]),
  };
}

/**
 * Tier 1 deductible design of the scope that applies (combined when the row says medical
 * and drug deductibles are integrated). The family deductible is embedded when the row
 * publishes a positive per-person amount below the per-group amount; a zero, missing or
 * equal amount is not evidence either way. `plan_coinsurance` repeats the published
 * in-network tier cells; the PUFs publish no out-of-network deductible coinsurance.
 */
function deductibleDesign(sharing: View["cost_sharing"]) {
  const integrated = sharing.medical_drug_deductibles_integrated?.trim();
  if (integrated !== "Yes" && integrated !== "No") return {};
  const prefix = integrated === "Yes" ? "TEHB" : "MEHB";
  const { person, group } = familyAmounts(sharing, `${prefix}DedInnTier1`);
  const tier = (network: string) =>
    sharing.coinsurance_raw[`${prefix}Ded${network}Coinsurance`]?.trim() ||
    null;
  const tier1 = tier("InnTier1"),
    tier2 = tier("InnTier2");
  return {
    coinsurance: percent(tier1 ?? undefined),
    plan_coinsurance: tier1
      ? `In-Network: ${tier1}` + (tier2 ? ` / In-Network-Tier-2: ${tier2}` : "")
      : null,
    embedded_deductible:
      person !== null && group !== null && person > 0 && person < group
        ? "embedded"
        : null,
  };
}

/**
 * Compact phrase for one published cost cell: "$50.00 Copay after deductible" becomes
 * "$50 after deductible", "40.00% Coinsurance after deductible" becomes "40% after
 * deductible", "No Charge" becomes "$0". "Not Applicable" and blank cells are absent.
 * Words the publisher wrote stay; nothing is inferred.
 */
function compactCell(value: string | undefined) {
  const cell = value?.trim() ?? "";
  if (!cell || /^(?:per (?:person|group) )?not applicable$/i.test(cell))
    return null;
  return cell
    .replace(/^No Charge\b/, "$0")
    .replace(
      /\$(\d+(?:,\d{3})*)(?:\.(\d{2}))?/g,
      (_, whole: string, cents) =>
        `$${Number(whole.replaceAll(",", "")).toLocaleString("en-US")}` +
        (cents && cents !== "00" ? `.${cents}` : ""),
    )
    .replace(/(\d+)\.(\d*?)0*%/g, (_, whole: string, fraction: string) =>
      fraction ? `${whole}.${fraction}%` : `${whole}%`,
    )
    .replace(/ (?:Copay|Coinsurance)\b/g, "");
}

/** Tier 1 in-network or out-of-network phrase; tier 2 never stands in for tier 1. */
function compactTier(
  benefit: NativeBenefit,
  copayKey: string,
  coinsKey: string,
) {
  const parts = [
    compactCell(benefit.cost_sharing_raw[copayKey]),
    compactCell(benefit.cost_sharing_raw[coinsKey]),
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(" plus ") : "Not Applicable";
}

/**
 * "In-Network: $30 / Out-of-Network: 50% after deductible". An explicit "Not Covered"
 * IsCovered cell is the only source of "Not Covered"; a 100% coinsurance cell renders
 * as "100%". Only the quantity limit is kept from the row conditions.
 */
function compactBenefitText(benefit: NativeBenefit): string | null {
  const raw = benefitCells(benefit.raw);
  if (!raw) return null;
  const limit = benefitConditions(raw).find((condition) =>
    condition.startsWith("limit: "),
  );
  const suffix = limit ? ` | ${limit}` : "";
  if (["No", "Not Covered"].includes(raw.IsCovered ?? ""))
    return `In-Network: Not Covered / Out-of-Network: Not Covered${suffix}`;
  const inside = compactTier(benefit, "CopayInnTier1", "CoinsInnTier1"),
    outside = compactTier(benefit, "CopayOutofNet", "CoinsOutofNet");
  if (inside === "Not Applicable" && outside === "Not Applicable") return null;
  return `In-Network: ${inside} / Out-of-Network: ${outside}${suffix}`;
}

/** Individual cells, or the per-group family amount, of the tier 1 and out-of-network columns. */
function compactAccumulators(sharing: View["cost_sharing"]) {
  const result: Record<string, string | null> = {};
  for (const group of ["deductibles", "moop"] as const) {
    const integrated =
      (group === "deductibles"
        ? sharing.medical_drug_deductibles_integrated
        : sharing.medical_drug_moop_integrated) === "Yes";
    const suffix = group === "moop" ? "MOOP" : "";
    for (const [scope, prefix] of accumulatorScopes(integrated))
      for (const family of [false, true]) {
        const cell = (network: string) => {
          const key = `${prefix}${group === "deductibles" ? "Ded" : ""}${network}`;
          const text = (name: string) =>
            sharing[group][`${key}${name}${suffix}`]?.raw.trim() || undefined;
          if (!family) return compactCell(text("Individual"));
          const perGroup =
            text("FamilyPerGroup") ??
            /\| (.+) per group$/.exec(text("Family") ?? "")?.[1];
          return compactCell(perGroup?.replace(/ per group$/, ""));
        };
        const inside = cell("InnTier1"),
          outside = cell("OutOfNet");
        result[
          `${family ? "family" : "individual"}_${scope}_${group === "deductibles" ? "deductible" : "moop"}`
        ] =
          inside || outside
            ? `In-Network: ${inside ?? "Not Applicable"} / Out-of-Network: ${outside ?? "Not Applicable"}`
            : null;
      }
  }
  return result;
}
