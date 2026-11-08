import type { RunBudget } from './formulary-acquire.js';
import { checkRunBudget, childFailureCodes } from './formulary-acquire.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Database } from '../../db/database.js';
import { readJsonArray, JsonStreamError } from '../json/index.js';
import { beginShard, beginSourceSet, catalogPlans, insertEdges, publishSet, saveIssues, sourceSet } from './formulary-repository.js';
import type { CachedChild, FormularyScope } from './formulary-repository.js';

export const restrictionFlags = ['prior_authorization', 'step_therapy', 'quantity_limit'] as const;
export function nullableRestriction(value: unknown): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') throw new Error('invalid_restriction_boolean');
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function* cachedRecords(child: CachedChild): AsyncGenerator<unknown> {
  if (child.status !== 'downloaded' && childFailureCodes.has(child.status)) throw new Error(child.status);
  if (!child.raw_path || !child.sha256 || child.status !== 'downloaded') throw new Error('child_not_cached');
  const hash = createHash('sha256');
  async function* bytes() {
    for await (const chunk of createReadStream(child.raw_path!)) { hash.update(chunk); yield chunk as Buffer; }
  }
  yield* readJsonArray(bytes());
  if (hash.digest('hex') !== child.sha256) throw new Error('cache_hash_mismatch');
}
export interface FormularyReport {
  snapshot_id: string; issuer: string; year: number; state: string;
  status: 'ACTIVE' | 'QUARANTINED'; completeness: 'complete' | 'partial' | 'failed' | 'access_denied' | 'unknown'; reason: string;
  expected_children: number; complete_children: number; records: number; edges: number;
  distinct_rxcuis: number; plans_covered: number; issues: Record<string, number>; elapsed_ms: number;
}

export async function importFormulary(db: Database, scope: FormularyScope, options: RunBudget = {}): Promise<FormularyReport> {
  if (!/^\d{5}$/.test(scope.issuer) || !/^[A-Z]{2}$/.test(scope.state)
    || !Number.isInteger(scope.year) || scope.year < 2014 || scope.year > 2100) throw new Error('Invalid formulary scope');
  const started = Date.now();
  return db.transaction(async tx => {
    // Serialize publication for the same issuer/year/state, including the manifest update.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`formulary:${scope.issuer}:${scope.year}:${scope.state}`]);
    const set = await sourceSet(tx, scope), plans = await catalogPlans(tx, scope);
    const planIds = new Set(plans.map(plan => plan.base_plan_id));
    const children = set.children.filter(child => child.kind === 'formulary_urls');
    const id = `formulary:${scope.issuer}:${scope.year}:${scope.state}:${randomUUID()}`;
    const hash = createHash('sha256').update(JSON.stringify(children.map(c => [c.child_id, c.snapshot_id, c.sha256]))).digest('hex');
    await beginSourceSet(tx, scope, id, set.discovery, hash, children.length, plans[0]?.snapshot_id ?? null);
    const totals: Record<string, number> = {};
    const reasons = new Set<string>();
    if (!set.indexesOk) {
      reasons.add('index_not_complete');
      for (const status of set.indexStatuses.filter(s => s !== 'ok')) reasons.add(`index_${status}`);
    }
    if (!children.length) reasons.add('no_formulary_children');
    if (!plans.length) reasons.add('catalog_not_available');
    const rootReasons = new Set(reasons);
    const tiers = new Map<string, Set<string>>();
    const unresolved = new Map<string, { plan: string; tier: string; count: number; first: number }>();
    const definitions = set.children.filter(child => child.kind === 'plan_urls');
    if (!definitions.length) { reasons.add('plan_definitions_incomplete'); rootReasons.add('plan_definitions_incomplete'); }
    try {
      for (const child of definitions) {
        for await (const value of cachedRecords(child)) {
          checkRunBudget(options);
          if (!record(value) || typeof value.plan_id_type !== 'string' || typeof value.plan_id !== 'string') {
            throw new Error('invalid_plan_definition');
          }
          if (value.plan_id_type !== 'HIOS-PLAN-ID') continue;
          if (!/^\d{5}[A-Z]{2}\d{7}$/.test(value.plan_id)) throw new Error('invalid_plan_definition');
          if (!planIds.has(value.plan_id)) continue;
          if (!Array.isArray(value.years) || !value.years.length || !value.years.every(y => Number.isInteger(y))) {
            throw new Error('missing_or_invalid_plan_years');
          }
          if (!value.years.includes(scope.year)) continue;
          const published = tiers.get(value.plan_id) ?? new Set<string>();
          if (value.formulary !== undefined && !Array.isArray(value.formulary)) throw new Error('invalid_plan_tiers');
          if (Array.isArray(value.formulary)) for (const tier of value.formulary) {
            if (!record(tier) || typeof tier.drug_tier !== 'string' || !tier.drug_tier.trim()) throw new Error('invalid_plan_tier');
            published.add(tier.drug_tier);
          }
          tiers.set(value.plan_id, published);
        }
      }
    } catch (error) {
      reasons.add('plan_definitions_incomplete'); rootReasons.add('plan_definitions_incomplete');
      if (error instanceof JsonStreamError) { reasons.add(`plan_definitions_${error.code}`); rootReasons.add(`plan_definitions_${error.code}`); }
      if (error instanceof Error && childFailureCodes.has(error.message)) { reasons.add(error.message); rootReasons.add(error.message); }
    }
    if (!reasons.has('plan_definitions_incomplete') && plans.some(p => !tiers.has(p.base_plan_id))) {
      reasons.add('catalog_plan_year_not_in_definitions'); rootReasons.add('catalog_plan_year_not_in_definitions');
    }
    let complete = 0, records = 0, edges = 0;
    for (const child of children) {
      const shardId = `${id}:${child.child_id}`;
      await beginShard(tx, shardId, id, child);
      let count = 0, stored = 0, invalid = false, failure: string | null = null;
      let batch: unknown[][] = [];
      const issues = new Map<string, { count: number; first: number | null }>();
      const issue = (code: string, row: number | null, blocks = false) => {
        const previous = issues.get(code);
        issues.set(code, { count: (previous?.count ?? 0) + 1, first: previous?.first ?? row });
        totals[code] = (totals[code] ?? 0) + 1;
        if (blocks) invalid = true;
      };
      try {
        checkRunBudget(options);
        for await (const drug of cachedRecords(child)) {
          checkRunBudget(options);
          const row = count++;
          if (!record(drug) || !Array.isArray(drug.plans)) { issue('invalid_drug_record', row, true); continue; }
          for (const [index, association] of drug.plans.entries()) {
            if (!record(association)) { issue('invalid_plan_association', row, true); continue; }
            const plan = association.plan_id;
            if (association.plan_id_type !== 'HIOS-PLAN-ID') { issue('unsupported_plan_id_type', row, true); continue; }
            if (typeof plan !== 'string' || !/^\d{5}[A-Z]{2}\d{7}$/.test(plan)) { issue('invalid_plan_id', row, true); continue; }
            // Other states/issuers in a national feed are outside the requested source scope.
            if (plan.slice(5, 7) !== scope.state || plan.slice(0, 5) !== scope.issuer) continue;
            if (!Array.isArray(association.years) || !association.years.length || !association.years.every(y => Number.isInteger(y))) {
              issue('missing_or_invalid_years', row, true); continue;
            }
            if (!association.years.includes(scope.year)) continue;
            if (!planIds.has(plan)) { issue('plan_not_in_catalog', row); continue; }
            if (typeof drug.rxnorm_id !== 'string' || !/^\d+$/.test(drug.rxnorm_id)) { issue('invalid_rxcui', row, true); continue; }
            const tier = association.drug_tier;
            if (typeof tier !== 'string' || !tier.trim()) { issue('invalid_drug_tier', row, true); continue; }
            // An unrecognised label is evidence, not a structural failure. Never guess synonyms.
            const tierStatus = tiers.get(plan)?.has(tier) ? 'resolved' : 'unresolved';
            let flags: (boolean | null)[];
            try { flags = restrictionFlags.map(key => nullableRestriction(association[key])); }
            catch { issue('invalid_restriction_boolean', row, true); continue; }
            if (tierStatus === 'unresolved') {
              const key = JSON.stringify([plan, tier]), previous = unresolved.get(key);
              unresolved.set(key, { plan, tier, count: (previous?.count ?? 0) + 1, first: previous?.first ?? row });
            }
            batch.push([shardId, row, index, drug.rxnorm_id, plan, scope.year, tier, ...flags,
              typeof drug.last_updated_on === 'string' ? drug.last_updated_on : null, tierStatus]);
            stored++;
            if (batch.length >= 1000) { await insertEdges(tx, batch); batch = []; }
          }
        }
      } catch (error) {
        failure = error instanceof JsonStreamError ? error.code
          : error instanceof Error && (['child_not_cached', 'cache_hash_mismatch'].includes(error.message) || childFailureCodes.has(error.message)) ? error.message : 'child_read_failed';
        issue(failure, count, true);
      }
      await insertEdges(tx, batch);
      await saveIssues(tx, shardId, issues);
      const status = failure ? (count ? 'partial' : 'failed') : invalid ? 'partial' : 'complete';
      const reason = failure ?? (invalid ? 'invalid_source_records' : null);
      if (status === 'complete') complete++; else reasons.add(reason!);
      await tx.query(`UPDATE formulary_shard SET status=$2,reason=$3,record_count=$4,edge_count=$5 WHERE snapshot_id=$1`,
        [shardId, status, reason, count, stored]);
      records += count; edges += stored;
    }
    // Exactly one warning per published label × plan across the entire source set.
    if (unresolved.size) totals.unresolved_drug_tier = unresolved.size;
    for (const warning of unresolved.values()) await tx.query(`INSERT INTO quality_issue
      (snapshot_id,source_record,severity,issue_code,explanation) VALUES ($1,$2,'warning','unresolved_drug_tier',$3)`,
      [id, String(warning.first), JSON.stringify({ base_hios_id: warning.plan, drug_tier: warning.tier, count: warning.count })]);
    const completeness = !reasons.size && complete === children.length ? 'complete' : complete || records || totals.too_large || totals.run_budget_exceeded ? 'partial' : !children.length ? set.indexStatuses.includes('access_denied') ? 'access_denied' : 'unknown' : totals.access_denied ? 'access_denied' : 'failed';
    const reason = completeness === 'complete' ? 'all_advertised_formulary_children_validated' : [...reasons].sort().join(',');
    for (const code of rootReasons) totals[code] = (totals[code] ?? 0)+1;
    if (rootReasons.size) await saveIssues(tx, id, new Map([...rootReasons].map(code => [code, { count: 1, first: null }])));
    // A definition-year gap limits absence evidence; it does not invalidate explicitly dated
    // positive associations. Structural/fetch/hash failures still preserve the prior pointer.
    const publishPositive = completeness === 'complete' || edges > 0 && complete === children.length
      && reasons.size === 1 && reasons.has('catalog_plan_year_not_in_definitions');
    await publishSet(tx, scope, id, completeness, reason, children.length, complete, [...new Set(plans.map(p => p.market))],publishPositive);
    const stats = (await tx.query<{ drugs: number; plans: number }>(`SELECT count(DISTINCT rxcui)::int AS drugs,
      count(DISTINCT base_hios_id)::int AS plans FROM formulary_edge e JOIN formulary_shard s USING(snapshot_id)
      WHERE s.source_set_id=$1`, [id])).rows[0]!;
    return { snapshot_id: id, ...scope, status: publishPositive ? 'ACTIVE' : 'QUARANTINED',
      completeness, reason, expected_children: children.length, complete_children: complete, records, edges,
      distinct_rxcuis: stats.drugs, plans_covered: stats.plans, issues: totals, elapsed_ms: Date.now() - started };
  });
}
