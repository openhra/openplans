import type { CsvRow } from '../csv/index.js';
import { FAMILY_RATE_FIELDS } from '../../domain/rating/types.js';
import type { ImportKind } from '../puf/import-source.js';

// Canonical spelling matters to the existing rating and benefit adapters. Unmapped
// publication fields remain verbatim; none are discarded from raw evidence.
const fields = `BusinessYear StateCode IssuerId StandardComponentId PlanId MarketCoverage DentalOnlyPlan MetalLevel NetworkId ServiceAreaId PlanMarketingName IssuerMarketPlaceMarketingName QHPNonQHPTypeId ServiceAreaName CoverEntireState County PartialCounty ZipCodes NetworkName NetworkURL ProductId RatingAreaId Tobacco Age RateEffectiveDate RateExpirationDate IndividualRate IndividualTobaccoRate BenefitName CopayInnTier1 CopayInnTier2 CopayOutofNet CoinsInnTier1 CoinsInnTier2 CoinsOutofNet CSRVariationType PlanVariantMarketingName ChildOnlyOffering EHBPediatricDentalApportionmentQuantity EHBPercentPremium AgeDeterminationRule MinimumTobaccoFreeMonthsRule DependentMaxAgeRule MaxChildrenInPolicy MedicalOrDentalRule MEHBDedInnTier1Individual MEHBDedInnTier1Family MEHBInnTier1IndividualMOOP MEHBInnTier1FamilyMOOP DEHBDedInnTier1Individual DEHBDedInnTier1Family DEHBInnTier1IndividualMOOP DEHBInnTier1FamilyMOOP TEHBDedInnTier1Individual TEHBDedInnTier1Family TEHBInnTier1IndividualMOOP TEHBInnTier1FamilyMOOP`.split(' ');
const compact = (value: string) => value.replace(/[^a-z0-9]/gi, '').toLowerCase();
const names = new Map([...fields, ...FAMILY_RATE_FIELDS].map(field => [compact(field), field]));
const aliases: Record<string, string> = { rateexpiration: 'RateExpirationDate', dentalplanonly: 'DentalOnlyPlan', zipcode: 'ZipCodes', hiosproductid: 'ProductId', issuername: 'IssuerMarketPlaceMarketingName' };
const costs = ['CopayInnTier1', 'CopayInnTier2', 'CopayOutofNet', 'CoinsInnTier1', 'CoinsInnTier2', 'CoinsOutofNet'];

export function normalizeSbeRow(kind: ImportKind, row: CsvRow): CsvRow {
  const values: Record<string, string> = { ...row.values };
  for (const [key, value] of Object.entries(row.values)) {
    const name = aliases[compact(key)] ?? names.get(compact(key));
    if (name) {
      if (Object.hasOwn(values, name) && values[name] !== value && name !== key) throw new Error('Conflicting SBE headers');
      values[name] = value.trim();
    }
  }
  if (kind === 'benefits-and-cost-sharing') for (const key of costs) values[key] ??= '';
  if (kind === 'service-area') {
    for (const key of ['CoverEntireState', 'PartialCounty']) {
      if (values[key]?.toLowerCase() === 'true') values[key] = 'Yes';
      if (values[key]?.toLowerCase() === 'false') values[key] = 'No';
    }
    if (values.County) {
      const fips = /(?:^| - )(\d{5})$/.exec(values.County);
      if (!fips) throw new Error('Invalid SBE county label');
      values.County = fips[1]!;
    }
  }
  if (kind === 'business-rules') {
    // The publication leaves Market Coverage blank. Do not invent a market or
    // infer a product/plan from the issuer-level rule.
    if (Object.hasOwn(values, 'MarketCoverage')) values.MarketCoverage ||= 'unknown';
    if (Object.hasOwn(values, 'DentalOnlyPlan') && !values.DentalOnlyPlan && ['Medical', 'Dental'].includes(values.MedicalOrDentalRule!)) values.DentalOnlyPlan = values.MedicalOrDentalRule === 'Dental' ? 'Yes' : 'No';
  }
  if (kind === 'rate') for (const field of ['RateEffectiveDate', 'RateExpirationDate']) {
    const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(values[field] ?? '');
    if (date) values[field] = `${date[3]}-${date[1]!.padStart(2, '0')}-${date[2]!.padStart(2, '0')}`;
  }
  if (kind === 'rate' && values.Age === '' && FAMILY_RATE_FIELDS.some(key => values[key] !== '' && values[key] !== undefined)) values.Age = 'Family Option';
  return { ...row, values };
}
