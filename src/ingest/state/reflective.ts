// Exact state-hosted publications reviewed for the explicit prior-year approved
// cells. These allow no inferred HIOS ID and no proposed 2027 premium.
const host = 'https://ratereview.vermont.gov/sites/dfr/files/documents/';
export const reflectivePublications = [
  { issuer: 'BCBSVT', url: `${host}BCBSVT-Ind-Actuarial%20Memo-COMBINED.pdf`,
    sha256: '0c6e85368bf739e620eb84bc3ddae4e7b111d1e18ae5de217067d69a781192a9' },
  { issuer: 'MVP', url: `${host}MVP%20Ind%20Actuarial%20Memo-COMBINED.pdf`,
    sha256: 'b0eefb0470e5e84519ea14ad2a2d38680eaa6f8a01467b59c2b50fe74faec595' },
] as const;
const bcbsNames = ['Vermont Preferred Silver - Reflective', 'Vermont Select Silver CDHP - Reflective',
  'Standard Silver - Reflective', 'Standard Silver CDHP - Reflective'];
const mvpColumns = new Map([
  ['Non-Standard Silver Reflective Non-HDHP', 4], ['Non-Standard Silver Reflective HDHP', 6],
  ['Standard Silver Reflective Non-HDHP', 12], ['Standard Silver Reflective HDHP', 14],
]);
const tiers = ['single', 'couple', 'adult_children', 'family'] as const;

export function reflectivePublication(url: string, sha256: string) {
  return reflectivePublications.find(source => source.url === url && source.sha256 === sha256);
}

export function validateReflectiveRecord(source: { url: string; sha256: string }, record: {
  issuer: string; plan_id: string | null; plan_name?: string; metal: string | null;
  exchange: string; source_record: string; prices: Record<string, string>; raw: Record<string, string>;
}) {
  const publication = reflectivePublication(source.url, source.sha256);
  if (!publication || record.issuer !== publication.issuer || record.plan_id !== null
    || record.metal !== 'Silver' || record.exchange !== 'Off'
    || record.raw.rate_year !== '2026' || record.raw.rate_status !== 'Approved') {
    throw new Error('Invalid reflective identity or approved-year evidence');
  }
  const money = (line: string) => [...line.matchAll(/\$([0-9,]+\.[0-9]{2})/g)].map(match => match[1]!.replaceAll(',', ''));
  let cells: string[];
  if (publication.issuer === 'BCBSVT') {
    if (!bcbsNames.includes(record.plan_name ?? '') || record.raw.name_kind !== 'published_plan_name'
      || record.source_record !== `page=82;exhibit=9-IND;table=2;year=2026;row=${record.plan_name}`
      || !record.raw.source_line?.startsWith(`${record.plan_name} `)) throw new Error('Invalid reflective source row');
    const values = money(record.raw.source_line);
    if (values.length !== 8) throw new Error('Invalid reflective approved tier cells');
    cells = values.slice(4, 8);
  } else {
    const column = mvpColumns.get(record.plan_name ?? '');
    if (!column || record.raw.name_kind !== 'published_column_labels' || record.raw.design_label !== record.plan_name
      || record.raw.column !== String(column)
      || record.source_record !== `page=51;table=contract-rate-increases;year=2026;column=${column}`) {
      throw new Error('Invalid reflective source column');
    }
    const lines = record.raw.source_lines?.split('\n') ?? [];
    const labels = ['Single Rate ', 'Couple Rate ', 'Adult and Child(ren) Rate ', 'Family Rate '];
    if (lines.length !== 4 || lines.some((line, index) => !line.startsWith(labels[index]!))) {
      throw new Error('Invalid reflective approved tier rows');
    }
    cells = lines.map((line, index) => {
      const values = money(line);
      if (values.length !== (index === 3 ? 20 : 18)) throw new Error('Invalid reflective approved tier cells');
      return values[column - 1]!;
    });
  }
  if (tiers.some((tier, index) => cells[index] !== record.prices[tier])) {
    throw new Error('Reflective tier differs from approved source cells');
  }
}
