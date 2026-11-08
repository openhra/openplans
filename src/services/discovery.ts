import type { SqlSession } from '../db/database.js';
import { searchPlans, parsePlanRef } from './catalog.js';
import { normalizeNdc } from '../domain/drugs/concepts.js';
import { createRxnormRepository } from '../ingest/rxnorm/repository.js';
import type { DrugConcept } from '../ingest/rxnorm/repository.js';
import { ReadError } from './errors.js';

/** Compose native pages without discarding their remainder at the adapter's smaller page boundary. */
export async function nativeWindow<T>(offset: number, limit: number,
  read: (page: number) => Promise<{ items: T[]; total: number }>) {
  const page = Math.floor(offset / 50) + 1, within = offset % 50;
  const first = await read(page);
  const items = first.items.slice(within, within + limit);
  if (items.length < limit && page * 50 < first.total) items.push(...(await read(page + 1)).items.slice(0, limit - items.length));
  return { items, total: first.total, more: offset + items.length < first.total };
}

/** Filter the complete scoped catalog before paging; broad requests fail instead of hiding matches. */
export async function discoverPlans(db: SqlSession, params: Record<string, string>, query: string) {
  const rows: Array<Awaited<ReturnType<typeof searchPlans>>['plans'][number]> = [];
  let page = 1;
  do {
    const result = await searchPlans(db, { ...params, page: String(page) });
    if (result.total > 1000) throw new ReadError({ code: 'SEARCH_TOO_BROAD' });
    rows.push(...result.plans);
    if (!result.next_page) break;
    page = result.next_page;
  } while (page <= 20);
  const literal = query.toLowerCase();
  return rows.filter(row => row.plan_name.toLowerCase().includes(literal)
    || String(row.plan_key ?? row.base_plan_id).toLowerCase() === literal);
}

/** Unique RxCUIs in deterministic native rank order, with a bounded scan and no guessed total. */
export async function discoverDrugs(db: SqlSession, input: { query?: string; ndc?: string }, offset: number, limit: number) {
  const rx = createRxnormRepository(db), seen = new Set<string>(), candidates: DrugConcept[] = [];
  if (input.ndc !== undefined) {
    const ndc = normalizeNdc(input.ndc);
    if (!ndc) throw new ReadError({ code: 'INVALID_NDC', field: 'ndc' });
    for (const id of await rx.rxcuisForNdc(ndc)) {
      const concept = (await rx.conceptByRxcui(id)).find(c => c.suppress === 'N');
      if (concept) candidates.push(concept);
    }
    return { items: candidates.slice(offset, offset + limit), total: candidates.length, more: offset + limit < candidates.length };
  }
  for (let at = 0; at < 5000; at += 1000) {
    const atoms = await rx.searchDrugs(input.query!, { limit: 1000, offset: at });
    for (const atom of atoms) if (!seen.has(atom.rxcui)) { seen.add(atom.rxcui); candidates.push(atom); }
    if (candidates.length > offset + limit || atoms.length < 1000) return {
      items: candidates.slice(offset, offset + limit), total: atoms.length < 1000 ? candidates.length : null,
      more: candidates.length > offset + limit,
    };
  }
  throw new ReadError({ code: 'SEARCH_TOO_BROAD' });
}

export type EntityId = { kind: string; parts: string[] };
export function entityId(kind: string, ...parts: (string | number)[]) {
  return [kind, ...parts.map(value => encodeURIComponent(String(value)))].join(':');
}
/** A strict typed identifier grammar, never an outbound URL/path or an arbitrary repository key. */
export function parseEntityId(id: string): EntityId {
  try {
    const [kind, ...encoded] = id.split(':'), parts = encoded.map(decodeURIComponent);
    if (!kind || entityId(kind, ...parts) !== id || parts.some(part => !part || /[\u0000-\u001f]/.test(part))) throw 0;
    const yr = (s: string | undefined) => s !== undefined && /^\d{4}$/.test(s) && Number(s) >= 2014 && Number(s) <= 2100;
    const identity = (s: string | undefined) => s !== undefined && /^[12]\d{9}$/.test(s);
    const valid = kind === 'plan' ? parts.length === 2 && yr(parts[0]) && Boolean(parsePlanRef(parts[1]))
      : kind === 'drug' ? parts.length === 1 && /^\d{1,20}$/.test(parts[0]!)
      : kind === 'provider' ? parts.length === 1 && identity(parts[0]) || parts.length === 4 && yr(parts[0]) && identity(parts[1])
      : kind === 'geography' ? parts.length === 2 && parts.every(part => /^\d{5}$/.test(part))
      : kind === 'carrier' || kind === 'network' ? parts.length === 5 && /^[A-Z]{2}$/.test(parts[0]!) && yr(parts[1]) && /^\d+$/.test(parts[4]!)
      : kind === 'dataset' ? parts.length === 4 && /^(?:[A-Z]{2}|_)$/.test(parts[0]!) && (parts[1] === '_' || yr(parts[1]))
        && ['catalog','premiums','drugs','providers','geography','terminology','taxonomy'].includes(parts[3]!)
      : kind === 'snapshot' ? parts.length === 1 && !/^(?:https?:|\.\.)|[\\/]/.test(parts[0]!)
      : false;
    if (!valid) throw 0;
    return { kind, parts };
  } catch { throw new ReadError({ code: 'INVALID_FETCH_ID', field: 'id' }); }
}
