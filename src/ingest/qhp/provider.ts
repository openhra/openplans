import type { RunBudget } from './formulary-acquire.js';
import { checkRunBudget, childFailureCodes } from './formulary-acquire.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Database, SqlSession } from '../../db/database.js';
import { readJsonArray, JsonStreamError } from '../json/index.js';
import { beginShard, beginSourceSet, catalogPlans, insertRows, insertPlanGroups, publishSet, saveIssues, sourceSet } from './provider-repository.js';
import type { CachedChild, ProviderScope } from './provider-repository.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const text = (value: unknown) => typeof value === 'string' ? value : null;
const json = (value: unknown) => value === undefined ? null : JSON.stringify(value);
async function analyzeProviderRows(tx: SqlSession) {
  const previous = (await tx.query<{ lock_timeout: string }>('SHOW lock_timeout')).rows[0]?.lock_timeout ?? '0';
  await tx.exec('SAVEPOINT provider_analyze');
  try {
    await tx.query("SELECT set_config('lock_timeout','1s',true)");
    await tx.exec('ANALYZE qhp_provider_record; ANALYZE qhp_provider_address; ANALYZE qhp_provider_plan_legacy; ANALYZE provider_record_plan_group; ANALYZE provider_plan_group_edge');
  } catch (error) {
    await tx.exec('ROLLBACK TO SAVEPOINT provider_analyze');
    // Statistics are advisory. Another issuer's priming ANALYZE must not block
    // validated evidence or cancel its transaction. Refresh after the bulk run.
    if ((error as { code?: string }).code !== '55P03') throw error;
  } finally {
    await tx.exec('RELEASE SAVEPOINT provider_analyze');
    await tx.query("SELECT set_config('lock_timeout',$1,true)",[previous]);
  }
}
export async function* providerCachedRecords(child: CachedChild): AsyncGenerator<unknown> {
  if (child.status !== 'downloaded' && childFailureCodes.has(child.status)) throw new Error(child.status);
  if (!child.raw_path || !child.sha256 || child.status !== 'downloaded') throw new Error('child_not_cached');
  const hash = createHash('sha256');
  async function* bytes() {
    for await (const chunk of createReadStream(child.raw_path!)) { hash.update(chunk); yield chunk as Buffer; }
  }
  yield* readJsonArray(bytes());
  if (hash.digest('hex') !== child.sha256) throw new Error('cache_hash_mismatch');
}
export interface ProviderReport {
  snapshot_id: string; issuer: string; year: number; state: string;
  status: 'ACTIVE' | 'QUARANTINED'; completeness: 'complete' | 'partial' | 'failed' | 'access_denied' | 'unknown'; reason: string;
  expected_children: number; complete_children: number; records: number; addresses: number; edges: number;
  distinct_npis: number; nppes_matches: number; nppes_match_rate: number | null;
  issues: Record<string, number>; elapsed_ms: number;
}

export interface ProviderOptions extends RunBudget {
  prepareChild?: (child: CachedChild, session: SqlSession) => Promise<CachedChild>;
  onShard?: (progress: { issuer: string; child_id: string; status: string; reason: string | null; records: number; edges: number; elapsed_ms: number }) => void;
}
export async function importProviders(db: Database, scope: ProviderScope, options: ProviderOptions = {}): Promise<ProviderReport> {
  if (!/^\d{5}$/.test(scope.issuer) || !/^[A-Z]{2}$/.test(scope.state)
    || !Number.isInteger(scope.year) || scope.year < 2014 || scope.year > 2100) throw new Error('Invalid provider scope');
  const started = Date.now();
  return db.transaction(async tx => {
    // New shard IDs are absent from the MCV stats. Custom FK plans can mistake
    // them for empty snapshots and scan the snapshot-only index for every row.
    // Generic plans use both primary-key columns; LOCAL preserves API defaults.
    await tx.exec("SET LOCAL plan_cache_mode='force_generic_plan'");
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`provider:${scope.issuer}:${scope.year}:${scope.state}`]);
    const set = await sourceSet(tx, scope), plans = await catalogPlans(tx, scope);
    const planIds = new Set(plans.map(plan => plan.base_plan_id));
    const children = set.children.filter(child => child.kind === 'provider_urls');
    const id = `provider:${scope.issuer}:${scope.year}:${scope.state}:${randomUUID()}`;
    const hash = createHash('sha256').update(JSON.stringify(children.map(c => [c.child_id, c.snapshot_id, c.sha256]))).digest('hex');
    await beginSourceSet(tx, scope, id, set.discovery, hash, children.length, plans[0]?.snapshot_id ?? null);
    const totals: Record<string, number> = {}, reasons = new Set<string>();
    if (!set.indexesOk) {
      reasons.add('index_not_complete');
      for (const status of set.indexStatuses.filter(s => s !== 'ok')) reasons.add(`index_${status}`);
    }
    if (!children.length) reasons.add('no_provider_children');
    if (!plans.length) reasons.add('catalog_not_available');
    const tiers = new Map<string, Set<string>>();
    const tierWarnings = new Map<string, { plan: string; tier: string; count: number; first: number; snapshot: string }>();
    const definitions = set.children.filter(child => child.kind === 'plan_urls');
    if (!definitions.length) reasons.add('plan_definitions_incomplete');
    try {
      for (const child of definitions) for await (const value of providerCachedRecords(child)) {
        checkRunBudget(options);
        if (!object(value) || typeof value.plan_id_type !== 'string' || typeof value.plan_id !== 'string') {
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
        if (value.network !== undefined && !Array.isArray(value.network)) throw new Error('invalid_plan_tiers');
        if (Array.isArray(value.network)) for (const tier of value.network) {
          if (!object(tier) || typeof tier.network_tier !== 'string' || !tier.network_tier.trim()) throw new Error('invalid_plan_tier');
          published.add(tier.network_tier);
        }
        tiers.set(value.plan_id, published);
      }
    } catch (error) {
      reasons.add('plan_definitions_incomplete');
      if (error instanceof JsonStreamError) reasons.add(`plan_definitions_${error.code}`);
      if (error instanceof Error && childFailureCodes.has(error.message)) reasons.add(error.message);
    }
    if (!reasons.has('plan_definitions_incomplete') && plans.some(p => !tiers.has(p.base_plan_id))) reasons.add('catalog_plan_year_not_in_definitions');
    const rootReasons = new Set(reasons);
    const definitionsIncomplete = rootReasons.has('plan_definitions_incomplete');
    // ANALYZE keeps its table lock until this issuer commits. Only prime a near-empty
    // table; populated-table estimates already prevent the quadratic FK lookup plan.
    // Otherwise this early lock serializes independent issuer imports for their full run.
    const estimate = (await tx.query<{ estimated: number }>(`SELECT reltuples::float8 AS estimated
      FROM pg_class WHERE oid='qhp_provider_record'::regclass`)).rows[0]?.estimated ?? 0;
    let complete = 0, records = 0, addresses = 0, edges = 0, statsPrimed = estimate >= 10_000, partial = false;
    const parsedChildren: CachedChild[] = [];
    for (let child of children) {
      const shardStarted = Date.now();
      // A failed required definition makes publication impossible. Record every
      // advertised shard, but do not download/parse national feeds for that attempt.
      if (options.prepareChild && !definitionsIncomplete) child = await options.prepareChild(child,tx);
      parsedChildren.push(child);
      const shardId = `${id}:${child.child_id}`;
      await beginShard(tx, shardId, id, child);
      await tx.exec('SAVEPOINT provider_child');
      const before = { records,addresses,edges,warnings: new Map(tierWarnings) };
      let firstOutsidePlan: string | null = null;
      let firstOutsideStatePlan: string | null = null;
      let count = 0, stored = 0, invalid = false, failure: string | null = null;
      let recordBatch: unknown[][] = [], addressBatch: unknown[][] = [], edgeBatch: unknown[][] = [];
      let planGroups = new Map<string,unknown[][]>(), planLinks: unknown[][] = [], groupEdges = 0;
      const flush = async () => {
        await insertRows(tx, 'qhp_provider_record', ['snapshot_id','record_id','source_record','npi','type','name',
          'facility_name','facility_type','group_name','speciality','specialty','languages','accepting','source_updated_at'], recordBatch);
        if (!statsPrimed && recordBatch.length) {
          // Without stats, FK plans can cache a snapshot-only index scan and become quadratic.
          await tx.exec('ANALYZE qhp_provider_record');
          statsPrimed = true;
        }
        await insertRows(tx, 'qhp_provider_address', ['snapshot_id','record_id','address_index','address','address_2','city','state','zip','phone','raw'], addressBatch);
        await insertRows(tx, 'qhp_provider_plan_legacy', ['snapshot_id','record_id','source_plan_index','base_hios_id','plan_year','network_tier','tier_status'], edgeBatch);
        await insertPlanGroups(tx,planGroups,planLinks);
        recordBatch = []; addressBatch = []; edgeBatch = [];
        planGroups = new Map(); planLinks = []; groupEdges = 0;
      };
      const issues = new Map<string, { count: number; first: number | null }>();
      const issue = (code: string, row: number | null, blocks = false) => {
        const previous = issues.get(code);
        issues.set(code, { count: (previous?.count ?? 0) + 1, first: previous?.first ?? row });
        totals[code] = (totals[code] ?? 0) + 1;
        if (blocks) invalid = true;
      };
      try {
        if (definitionsIncomplete) throw new Error('plan_definitions_incomplete');
        checkRunBudget(options);
        for await (const provider of providerCachedRecords(child)) {
          checkRunBudget(options);
          const row = count++;
          if (!object(provider) || !['INDIVIDUAL','FACILITY','GROUP'].includes(String(provider.type))
            || !(object(provider.name) || typeof provider.name === 'string' || typeof provider.facility_name === 'string'
              || typeof provider.group_name === 'string') || !Array.isArray(provider.plans)
            || !Array.isArray(provider.addresses)) { issue('invalid_provider_record', row, true); continue; }
          const recordId = `${child.sha256}:${row}`;
          let npi = text(provider.npi);
          if (npi === '') npi = null;
          if (npi !== null && !/^[12][0-9]{9}$/.test(npi)) { issue('invalid_npi', row, true); npi = null; }
          if (provider.npi !== undefined && provider.npi !== null && typeof provider.npi !== 'string') issue('invalid_npi', row, true);
          recordBatch.push([shardId,recordId,row,npi,provider.type,json(provider.name),text(provider.facility_name),json(provider.facility_type),
            text(provider.group_name),json(provider.speciality),
            json(provider.specialty),json(provider.languages),json(provider.accepting),text(provider.last_updated_on)]);
          records++;
          for (const [index, address] of provider.addresses.entries()) {
            if (!object(address)) { issue('invalid_provider_address', row, true); continue; }
            addressBatch.push([shardId,recordId,index,...['address','address_2','city','state','zip','phone'].map(k => text(address[k])),json(address)]);
            addresses++;
          }
          const providerEdges: unknown[][] = [];
          for (const [index, association] of provider.plans.entries()) {
            if (!object(association)) { issue('invalid_plan_association', row, true); continue; }
            if (association.plan_id_type !== 'HIOS-PLAN-ID') { issue('unsupported_plan_id_type', row, true); continue; }
            const plan = association.plan_id;
            if (typeof plan !== 'string' || !/^\d{5}[A-Z]{2}\d{7}$/.test(plan)) { issue('invalid_plan_id', row, true); continue; }
            if (plan.slice(5,7) !== scope.state) {
              firstOutsideStatePlan ??= plan; issue('plan_outside_state_scope',row); continue;
            }
            if (plan.slice(0,5) !== scope.issuer) {
              firstOutsidePlan ??= plan; issue('plan_outside_issuer_scope',row); continue;
            }
            if (!Array.isArray(association.years) || !association.years.length || !association.years.every(y => Number.isInteger(y))) {
              issue('missing_or_invalid_years', row, true); continue;
            }
            if (!association.years.includes(scope.year)) continue;
            if (!planIds.has(plan)) { issue('plan_not_in_catalog', row); continue; }
            const tier = association.network_tier;
            if (typeof tier !== 'string' || !tier.trim()) { issue('invalid_network_tier', row, true); continue; }
            const resolved = tiers.get(plan)?.has(tier) ?? false;
            if (!resolved) {
              const key = JSON.stringify([plan,tier]), previous = tierWarnings.get(key);
              tierWarnings.set(key, { plan,tier,count: (previous?.count ?? 0)+1,
                first: previous?.first ?? row,snapshot: previous?.snapshot ?? shardId });
              totals.unresolved_network_tier = (totals.unresolved_network_tier ?? 0)+1;
            }
            providerEdges.push([shardId,recordId,index,plan,scope.year,tier,resolved ? 'resolved' : 'unresolved']);
            stored++; edges++;
          }
          // Smaller state catalogs also publish identical lists repeatedly (e.g. FL's
          // 27/34-entry lists). Factor their exact ordinals and facts before SQL expansion.
          if (providerEdges.length >= 8) {
            const values = providerEdges.map(row => row.slice(2));
            const group = createHash('sha256').update('qhp-provider-plan-group-v1:').update(JSON.stringify(values)).digest('hex');
            if (!planGroups.has(group)) { planGroups.set(group,values); groupEdges += values.length; }
            planLinks.push([shardId,recordId,group]);
          } else edgeBatch.push(...providerEdges);
          // Bound unique association lists as well as records, addresses and sparse edges.
          if (recordBatch.length >= 1000 || addressBatch.length >= 2000 || edgeBatch.length >= 2000 || groupEdges >= 2000) await flush();
        }
      } catch (error) {
        failure = error instanceof JsonStreamError ? error.code
          : error instanceof Error && (['child_not_cached', 'cache_hash_mismatch', 'plan_definitions_incomplete'].includes(error.message) || childFailureCodes.has(error.message)) ? error.message : 'child_read_failed';
        // The root issue already records the failed definitions once per source set.
        if (failure !== 'plan_definitions_incomplete') issue(failure, count, true);
      }
      if (failure || invalid) {
        // A child is indivisible evidence: even complete rows preceding a bad EOF are private
        // and discarded. Publication of an older ACTIVE source set is never touched here.
        await tx.exec('ROLLBACK TO SAVEPOINT provider_child');
        records = before.records; addresses = before.addresses; edges = before.edges; stored = 0;
        tierWarnings.clear(); for (const [key,warning] of before.warnings) tierWarnings.set(key,warning);
      } else await flush();
      await tx.exec('RELEASE SAVEPOINT provider_child');
      if (child.snapshot_id && (failure === 'truncated' || failure === 'invalid_json')) await tx.query(`UPDATE qhp_child_url
        SET status=$2,publisher_metadata=publisher_metadata || $3::jsonb WHERE snapshot_id=$1 AND kind='provider_urls'`,
      [child.snapshot_id,failure,JSON.stringify({ parse_failure: failure })]);
      await saveIssues(tx, shardId, issues);
      if (firstOutsidePlan) await tx.query(`UPDATE quality_issue SET explanation=(explanation::jsonb || $2::jsonb)::text
        WHERE snapshot_id=$1 AND issue_code='plan_outside_issuer_scope'`,[shardId,JSON.stringify({
        requested_scope: scope,first_plan_id: firstOutsidePlan,
      })]);
      if (firstOutsideStatePlan) await tx.query(`UPDATE quality_issue SET explanation=(explanation::jsonb || $2::jsonb)::text
        WHERE snapshot_id=$1 AND issue_code='plan_outside_state_scope'`,[shardId,JSON.stringify({
        requested_scope: scope,first_plan_id: firstOutsideStatePlan,
      })]);
      const status = failure ? (count ? 'partial' : 'failed') : invalid ? 'partial' : 'complete';
      if (status === 'partial') partial = true;
      const reason = failure ?? (invalid ? 'invalid_source_records' : null);
      if (status === 'complete') complete++; else reasons.add(reason!);
      await tx.query(`UPDATE provider_shard SET status=$2,reason=$3,record_count=$4,edge_count=$5 WHERE snapshot_id=$1`,
        [shardId,status,reason,failure || invalid ? 0 : count,stored]);
      options.onShard?.({ issuer: scope.issuer,child_id: child.child_id,status,reason,
        records: failure || invalid ? 0 : count,edges: stored,elapsed_ms: Date.now()-shardStarted });
    }
    await tx.query('UPDATE snapshot SET sha256=$2 WHERE snapshot_id=$1',[id,createHash('sha256')
      .update(JSON.stringify(parsedChildren.map(c => [c.child_id,c.snapshot_id,c.sha256]))).digest('hex')]);
    if (records && !options.signal?.aborted && (options.deadline === undefined || Date.now() < options.deadline)) await analyzeProviderRows(tx);
    for (const warning of tierWarnings.values()) await tx.query(`INSERT INTO quality_issue
      (snapshot_id,source_record,severity,issue_code,explanation) VALUES ($1,$2,'warning','unresolved_network_tier',$3)`,
      [warning.snapshot,String(warning.first),JSON.stringify({ base_hios_id: warning.plan,network_tier: warning.tier,
        count: warning.count,first_source_record: warning.first })]);
    // Identity joins only: a missing or deactivated NPI never changes participation evidence.
    const stats = records ? (await tx.query<{ npis: number; matches: number; absent: number; deactivated: number }>(`SELECT
      count(DISTINCT r.npi)::int AS npis, count(DISTINCT n.npi)::int AS matches,
      count(*) FILTER (WHERE r.npi IS NOT NULL AND n.npi IS NULL)::int AS absent,
      count(*) FILTER (WHERE n.deactivated)::int AS deactivated
      FROM qhp_provider_record r JOIN provider_shard s USING(snapshot_id)
      LEFT JOIN npi_provider n ON n.npi=r.npi WHERE s.source_set_id=$1`, [id])).rows[0]! : { npis: 0,matches: 0,absent: 0,deactivated: 0 };
    for (const [code, count] of [['npi_absent_from_nppes', stats.absent], ['npi_deactivated_still_listed', stats.deactivated]] as const) {
      if (count) { totals[code] = count; await saveIssues(tx, id, new Map([[code,{ count, first: null }]])); }
    }
    const completeness = !reasons.size && complete === children.length ? 'complete' : partial || complete || records || totals.truncated || totals.too_large || totals.run_budget_exceeded ? 'partial' : !children.length ? set.indexStatuses.includes('access_denied') ? 'access_denied' : 'unknown' : totals.access_denied ? 'access_denied' : 'failed';
    const reason = completeness === 'complete' ? 'all_advertised_provider_children_validated' : [...reasons].sort().join(',');
    for (const code of rootReasons) totals[code] = (totals[code] ?? 0)+1;
    if (rootReasons.size) await saveIssues(tx, id, new Map([...rootReasons].map(code => [code,{ count: 1, first: null }])));
    // A definition-year gap limits absence evidence; it does not invalidate explicitly dated
    // positive associations. Structural/fetch/hash failures still preserve the prior pointer.
    const publishPositive = completeness === 'complete' || edges > 0 && complete === children.length
      && reasons.size === 1 && reasons.has('catalog_plan_year_not_in_definitions');
    await publishSet(tx, scope, id, completeness, reason, children.length, complete, [...new Set(plans.map(p => p.market))],publishPositive);
    await tx.exec('ANALYZE provider_active_set; ANALYZE provider_shard; ANALYZE provider_source_set; ANALYZE snapshot');
    return { snapshot_id: id,...scope,status: publishPositive ? 'ACTIVE' : 'QUARANTINED',completeness,reason,
      expected_children: children.length,complete_children: complete,records,addresses,edges,distinct_npis: stats.npis,
      nppes_matches: stats.matches,nppes_match_rate: stats.npis ? stats.matches / stats.npis : null,issues: totals,elapsed_ms: Date.now() - started };
  });
}
