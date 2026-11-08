import type { planView } from '../../api/repository.js';

// Vocabulary observed in the reference-capture mock's dental captures; no carrier-only values.
const benefitFields = `individual_deductible family_deductible individual_annual_max family_annual_max oral_exam
radiograph_bitewings radiograph_other fluoride_treatment space_maintainers prophylaxis_cleaning sealant
restoration_fillings emergency_treatment simple_extraction oral_surgery endodontics periodontics
periodontal_maintenance onlays inlays bridges implants crowns dentures denture_relines_rebases
denture_repair_and_adjustments orthodontics_adult orthodontics_child`;
export function mapDentalPlan(view: Awaited<ReturnType<typeof planView>>, id: string) {
  const names = view.issuer.marketing_names;
  const name = Array.isArray(names) ? names.find(n => typeof n === 'string' && n) ?? null : null;
  return { id, name: view.plan_name, identifiers: [{ type: 'hios_id', value: id }], plan_type: null,
    source: 'cms_puf', plan_documents: [], networks: view.network.records.map(n => ({ id: null, name: n.network_name })),
    carrier: { issuer_id: view.issuer.issuer_id, id: view.issuer.issuer_id, name, logo_url: null },
    issuer_name: name, audience: view.market, quoted_via_carrier_api: false, benefits_summary_url: null,
    logo_url: null, stand_alone: true, benefits: Object.fromEntries(benefitFields.split(/\s+/).map(key => [key, null])),
    carrier_disclaimers: null, premium: null, provenance: view.provenance };
}
