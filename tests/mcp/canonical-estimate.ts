import type { SqlSession } from '../../src/db/database.js';
import { getSnapshot } from '../../src/services/provenance.js';
import { outputSchemas } from '../../src/mcp/schemas.js';

// Test-only projection of actual service results. No invented amounts or fallback prices.
const record = (value: unknown) => value as Record<string, unknown>;
export async function canonicalEstimateOutput(db: SqlSession, quotes: readonly unknown[]) {
  const snapshots = new Set<string>();
  function collect(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['snapshot_id','publication_snapshot_id'].includes(key) && typeof child === 'string') snapshots.add(child);
      else if (key === 'snapshot_ids' && child && typeof child === 'object') {
        for (const id of Object.values(child)) if (typeof id === 'string') snapshots.add(id);
      } else collect(child);
    }
  }
  quotes.forEach(collect);
  const ids = [...snapshots];
  const evidence = { evidence_refs: ids, gaps: [] };
  const date = (value: string | null) => value ? new Date(value).toISOString() : null;
  const provenance = await Promise.all(ids.map(async id => {
    const row = await getSnapshot(db, id);
    if (!row) throw new Error('Fixture points to absent snapshot');
    return { id, snapshot_id: id, publisher: row.publisher, url: row.url, sha256: row.sha256,
      retrieved_at: date(row.retrieved_at), publisher_updated_at: date(row.publisher_updated_at), record_ref: null, status: 'available' };
  }));
  function rate(value: unknown) {
    const row = record(value), provenance = row.provenance ? record(row.provenance) : null;
    return { snapshot_id: provenance?.snapshot_id ?? row.publication_snapshot_id, source_row: provenance?.source_row ?? null,
      source_record: row.source_record ?? null, column: row.column ?? null, tier: row.tier ?? null, value: row.value ?? null,
      individual_rate_cents: row.individual_rate_cents ?? null, individual_tobacco_rate_cents: row.individual_tobacco_rate_cents ?? null,
      family_rates_cents: row.family_rates_cents ?? null, effective_date: row.effective_date ?? null, expiration_date: row.expiration_date ?? null,
      age_band: row.age_band ?? null, tobacco: row.tobacco ?? null, ...evidence };
  }
  const estimates = quotes.map(value => {
    const quote = record(value), subsidy = quote.subsidy ? record(quote.subsidy) : null, rule = quote.rule_trace ? record(quote.rule_trace) : null;
    const benchmark = subsidy ? record(subsidy.benchmark) : null, dental = benchmark?.pediatric_dental ? record(benchmark.pediatric_dental) : null;
    return { kind: 'estimate', plan_ref: quote.plan_id, coverage_start: quote.coverage_start, gross_status: quote.status,
      coverage: quote.coverage, gross_monthly_cents: quote.total_cents ?? null, estimated_credit_cents: quote.estimated_monthly_tax_credit_cents ?? null,
      estimated_net_cents: quote.estimated_net_monthly_cents ?? null, benchmark_cents: quote.slcsp_monthly_cents ?? null,
      subsidy_status: quote.subsidy_status ?? 'not_requested', quote_method: quote.quote_method ?? 'puf_calculation', bindable_quote: false,
      csr_eligibility_status: 'not_evaluated', rating_area_id: quote.rating_area_id ?? null, filed_column: quote.filed_column ?? null,
      state_rule_trace: rule ? { state: rule.state, tier: rule.tier, nominal_multiplier: rule.nominal_multiplier,
        citation: rule.citation, references: rule.references } : null,
      rate_trace: (quote.rate_rows_used as unknown[]).map(rate),
      members: (quote.members as Record<string, unknown>[]).map(m => ({ ...m, rate_rows: (m.rate_rows as unknown[]).map(rate) })),
      dental_business_rules: ((quote.dental_business_rules ?? []) as Record<string, unknown>[]).map(row => ({
        snapshot_id: row.snapshot_id, source_row: row.source_row, fields: Object.entries(record(row.raw)).map(([field, raw]) => ({ field, raw })), ...evidence })),
      pediatric_ehb: quote.pediatric_ehb ? (() => {
        const p = record(quote.pediatric_ehb);
        return { status: p.status, monthly_cents: p.monthly_cents, pediatric_gross_cents: p.pediatric_gross_cents,
          fraction: p.fraction, field: p.field, reason: p.reason ?? null, citation: p.citation, ...evidence };
      })() : null,
      subsidy: subsidy && benchmark ? { status: subsidy.status, reason: subsidy.reason, rounding_policy: subsidy.rounding_policy,
        fpl_percent: subsidy.fpl_percent, applicable_percentage: subsidy.applicable_percentage,
        expected_contribution_monthly_cents: subsidy.expected_contribution_monthly_cents,
        expected_contribution_annual_cents: subsidy.expected_contribution_annual_cents, enrollment_ehb_monthly_cents: subsidy.enrollment_ehb_monthly_cents,
        benchmark: { status: benchmark.status, slcsp_monthly_cents: benchmark.slcsp_monthly_cents,
          benchmark_plan_ids: benchmark.benchmark_plan_ids, silver_plan_count: benchmark.silver_plan_count,
          lowest_silver_plans: (benchmark.lowest_silver_plans as Record<string, unknown>[]).map(p => ({ plan_id: p.plan_id,
            gross_monthly_cents: p.gross_monthly_cents, ehb_monthly_cents: p.ehb_monthly_cents, benchmark_monthly_cents: p.benchmark_monthly_cents,
            pediatric_dental_adjustment_cents: p.pediatric_dental_adjustment_cents, ehb_fraction: p.ehb_fraction, ...evidence })),
          pediatric_dental_monthly_cents: dental?.monthlyCents ?? null,
          pediatric_dental_offers: ((dental?.offers ?? []) as Record<string, unknown>[]).map(p => ({ plan_id: p.planId,
            pediatric_gross_cents: p.pediatricGrossCents, ehb_monthly_cents: p.ehbCents, ...evidence })), issues: benchmark.issues, ...evidence } } : null,
      ...evidence };
  });
  return outputSchemas.estimate_premiums.parse({ schema_version: '1', status: 'ok', data_generation: 'fixture-generation',
    provenance, notes: [], truncated: false, freshness: { checked_at: '2026-11-08T00:00:00Z', status: 'current_local' },
    page: null, error: null, data: { estimates, bindable_quote: false } });
}
