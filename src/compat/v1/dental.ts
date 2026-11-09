import { premiumAttributeRows } from "../../api/repository.js";
import type { planView } from "../../api/repository.js";
import type { SqlSession } from "../../db/database.js";
import type { HouseholdMember } from "../../domain/rating/types.js";
import { ageOnDate } from "../../domain/rating/household.js";

/** Only unanimous public offering evidence can exclude an adult household. */
export async function dentalHouseholdOffering(
  db: SqlSession,
  plan: { snapshot_id: string; base_plan_id: string },
  members: readonly HouseholdMember[],
  coverage: string,
) {
  const { rows } = await premiumAttributeRows(
    db,
    plan.snapshot_id,
    plan.base_plan_id,
  );
  const provenance = rows.map((row) => ({
    snapshot_id: plan.snapshot_id,
    source_row: row.source_row,
    child_only_offering: row.raw.ChildOnlyOffering ?? null,
  }));
  const childOnly =
    rows.length > 0 &&
    rows.every(
      (row) => row.raw.ChildOnlyOffering?.trim() === "Allows Child-Only",
    );
  // SADP offering eligibility uses the under-21 age boundary, including minor subscribers.
  const hasChild = members.some(
    (member) => (member.age ?? ageOnDate(member.dateOfBirth!, coverage)) < 21,
  );
  return { offered: !childOnly || hasChild, provenance };
}

// Dental benefit wire vocabulary; no carrier-only values.
const benefitFields = `individual_deductible family_deductible individual_annual_max family_annual_max oral_exam
radiograph_bitewings radiograph_other fluoride_treatment space_maintainers prophylaxis_cleaning sealant
restoration_fillings emergency_treatment simple_extraction oral_surgery endodontics periodontics
periodontal_maintenance onlays inlays bridges implants crowns dentures denture_relines_rebases
denture_repair_and_adjustments orthodontics_adult orthodontics_child`;
export function mapDentalPlan(
  view: Awaited<ReturnType<typeof planView>>,
  id: string,
) {
  const names = view.issuer.marketing_names;
  const name = Array.isArray(names)
    ? (names.find((n) => typeof n === "string" && n) ?? null)
    : null;
  return {
    id,
    name: view.plan_name,
    identifiers: [{ type: "hios_id", value: id }],
    plan_type: null,
    source: "cms_puf",
    plan_documents: [],
    networks: view.network.records.map((n) => ({
      id: null,
      name: n.network_name,
    })),
    carrier: {
      issuer_id: view.issuer.issuer_id,
      id: view.issuer.issuer_id,
      name,
      logo_url: null,
    },
    issuer_name: name,
    audience: view.market,
    quoted_via_carrier_api: false,
    benefits_summary_url: null,
    logo_url: null,
    stand_alone: true,
    benefits: Object.fromEntries(
      benefitFields.split(/\s+/).map((key) => [key, null]),
    ),
    carrier_disclaimers: null,
    premium: null,
    provenance: view.provenance,
  };
}
