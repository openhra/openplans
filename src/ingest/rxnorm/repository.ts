import type { SqlSession } from '../../db/database.js';

export interface DrugConcept extends Record<string, unknown> {
  rxcui: string; name: string; tty: string; suppress: string; snapshot_id: string; source_record: number;
}
export interface SearchOptions { includeSuppressed?: boolean; limit?: number; offset?: number }
const current = `(SELECT r.snapshot_id FROM rx_release r JOIN snapshot s USING(snapshot_id)
  WHERE s.validation_state='ACTIVE' ORDER BY r.source_version DESC LIMIT 1)`;
const select = 'rxcui,name,tty,suppress,snapshot_id,min(source_record)::int AS source_record';
const group = 'GROUP BY rxcui,name,tty,suppress,snapshot_id';
function identifier(value: string) { if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('RxCUI must be an exact numeric string'); }
function pagination(options: SearchOptions) {
  const limit = options.limit ?? 50, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid search pagination');
  return { limit, offset };
}
export function createRxnormRepository(db: SqlSession) {
  return {
    async activeRelease(): Promise<{ snapshot_id: string; source_version: string } | null> {
      return (await db.query<{ snapshot_id: string; source_version: string }>(`SELECT
        snapshot_id,source_version::text FROM rx_release WHERE snapshot_id=${current}`)).rows[0] ?? null;
    },
    /** Literal substring candidates with TTY; selection of a candidate is always explicit. */
    async searchDrugs(text: string, options: SearchOptions = {}): Promise<DrugConcept[]> {
      const { limit, offset } = pagination(options);
      const query = text.trim();
      if (!query) return [];
      return (await db.query<DrugConcept>(`SELECT * FROM (SELECT ${select} FROM rx_concept
        WHERE snapshot_id=${current} AND ($2::boolean OR suppress='N')
        AND strpos(lower(name),lower($1))>0 ${group}) c
        ORDER BY CASE WHEN tty IN ('SCD','SBD') THEN 0 ELSE 1 END,
        CASE WHEN starts_with(lower(name),lower($1)) THEN 0 ELSE 1 END,lower(name),rxcui,tty,suppress,name
        LIMIT $3 OFFSET $4`, [query, options.includeSuppressed ?? false, limit, offset])).rows;
    },
    /** Multiple published names/TTYs can share an RxCUI; never choose a fuzzy surrogate. */
    async conceptByRxcui(rxcui: string): Promise<DrugConcept[]> {
      identifier(rxcui);
      return (await db.query<DrugConcept>(`SELECT ${select} FROM rx_concept WHERE snapshot_id=${current}
        AND rxcui=$1 ${group} ORDER BY tty,name,suppress`, [rxcui])).rows;
    },
    async rxcuisForNdc(ndc: string): Promise<string[]> {
      if (typeof ndc !== 'string' || !/^\d{11}$/.test(ndc)) throw new Error('NDC must be an 11-digit string as published');
      return (await db.query<{ rxcui: string }>(`SELECT DISTINCT rxcui FROM rx_ndc WHERE snapshot_id=${current}
        AND ndc=$1 AND suppress='N' ORDER BY rxcui`, [ndc])).rows.map(row => row.rxcui);
    },
    async ndcsForRxcui(rxcui: string): Promise<string[]> {
      identifier(rxcui);
      return (await db.query<{ ndc: string }>(`SELECT DISTINCT ndc FROM rx_ndc WHERE snapshot_id=${current}
        AND rxcui=$1 AND suppress='N' ORDER BY ndc`, [rxcui])).rows.map(row => row.ndc);
    },
    async ingredientsOf(rxcui: string): Promise<DrugConcept[]> {
      identifier(rxcui);
      // UNION (not UNION ALL) bounds traversal even if publisher edges contain cycles.
      // Follow only drug→component→ingredient directions; inverse/brand expansion would mix drugs.
      return (await db.query<DrugConcept>(`WITH RECURSIVE reached(rxcui) AS (
        SELECT $1::text UNION SELECT r.target_rxcui FROM rx_relation r JOIN reached p ON r.source_rxcui=p.rxcui
        WHERE r.snapshot_id=${current} AND r.suppress IN ('','N') AND r.rela IN
        ('has_ingredient','has_precise_ingredient','tradename_of','consists_of','contains','has_part','form_of')
      ) SELECT c.rxcui,c.name,c.tty,c.suppress,c.snapshot_id,min(c.source_record)::int AS source_record FROM reached p JOIN rx_concept c USING(rxcui)
        WHERE c.snapshot_id=${current} AND c.tty IN ('IN','PIN','MIN') AND c.suppress='N' GROUP BY c.rxcui,c.name,c.tty,c.suppress,c.snapshot_id ORDER BY c.tty,c.name,c.rxcui`, [rxcui])).rows;
    },
  };
}
