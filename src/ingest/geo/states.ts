/** Census state ANSI/FIPS identifiers; geography identity only, never an exchange membership list. */
export const STATE_FIPS: Record<string, string> = {
  AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12',
  GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23',
  MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33',
  NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44',
  SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56',
};
export function countyKey(name: string): string {
  return name.toLowerCase().replace(/ (county|parish|borough|census area|municipality|city and borough)$/g, '')
    .replace(/\bsaint\b/g, 'st').replace(/[^a-z0-9]/g, '');
}

/** Literal spelling errors in current CMS county tables, cross-checked against Census 2020 names.
 * Sources: https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/<state>-gra
 * and Census tab20_zcta520_county20_natl.txt. These change spelling only, never county boundaries.
 * Unlisted names still fail closed; every corrected name must uniquely exist in that state's Census rows.
 */
export const CMS_COUNTY_SPELLINGS: Record<string, Record<string, string>> = {
  IN: { kosclusko: 'kosciusko', deleware: 'delaware', davless: 'daviess', dubols: 'dubois' },
  KS: { chautaugua: 'chautauqua' }, LA: { vermillion: 'vermilion' }, ND: { trail: 'traill' }, OH: { galia: 'gallia' },
  // ny-gra row 21 spells Delaware "Deleware".
  NY: { deleware: 'delaware' },
};
