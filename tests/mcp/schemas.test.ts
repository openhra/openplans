import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { assertHonest, inputJsonSchemas, outputJsonSchemas, outputSchemas, parseToolInput, toolNames } from '../../src/mcp/schemas.js';
import type { ToolName } from '../../src/mcp/schemas.js';

import { evidence, envelope, shellPlan } from './helpers.js';
const payloads: Record<ToolName, unknown> = {
  search: { results: [], scope_gaps: [] }, fetch: { id: 'plan:2026:87226TX0100013', title: 'Synthetic contract shell',
    url: 'openplans://plan/2026/87226TX0100013', text: '', entity: 'plan', section: 'summary', records: [shellPlan] },
  search_plans: { plans: [shellPlan], location_status: 'available', counties: [] },
  get_plan: { plan: shellPlan, section: 'summary', records: [] }, estimate_premiums: { estimates: [], bindable_quote: false },
  search_providers: { providers: [], unlocated: null }, search_drugs: { candidates: [], exact_concept_required: true, terminology_status: 'unknown' },
  check_drug_coverage: { results: [] }, check_provider_network: { results: [] },
  lookup_geography: { zip: '77001', resolution: 'unknown', counties: [] },
  get_data_status: { datasets: [], personalized_access: 'authentication_required', loaded: false }, list_carriers_networks: { rows: [] },
};
const validInputs: Record<ToolName, unknown> = {
  search: { query: '77002' }, fetch: { id: 'plan:2026:87226TX0100013' }, search_plans: { location: { zip: '77002' }, year: 2026 },
  get_plan: { plan_ref: 'BCBSVT:Gold Plan', year: 2026 }, estimate_premiums: { plan_refs: ['87226TX0100013'], location: { county: '48201' },
    coverage_start: '2026-01-01', members: [{ age: 35, tobacco: false, relationship: 'subscriber' }],
    household: { income_annual: 30000.01, size: 1, tax_filing: 'single' } },
  search_providers: { npi: '1234567890', year: 2026 }, search_drugs: { query: 'metformin' },
  check_drug_coverage: { plan_ids: ['87226TX0100013'], rxcuis: ['860975'], year: 2026 },
  check_provider_network: { plan_ids: ['87226TX0100013'], npis: ['1234567890'], year: 2026 },
  lookup_geography: { zip: '75034' }, get_data_status: {}, list_carriers_networks: { state: 'TX' },
};
const validator = new AjvJsonSchemaValidator();
describe('twelve closed MCP tool contracts (no transport)', () => {
  it('compiles all input/output schemas with the pinned SDK validator and round-trips JSON', () => {
    expect(toolNames).toHaveLength(12); expect(toolNames).toEqual([...toolNames].sort());
    expect(toolNames).not.toContain('benchmark_silver');
    for (const tool of toolNames) {
      const input = JSON.parse(JSON.stringify(validInputs[tool]));
      const inputCheck = validator.getValidator(inputJsonSchemas[tool])(input);
      expect(inputCheck.valid, `${tool}: ${JSON.stringify(inputCheck)}`).toBe(true);
      parseToolInput(tool, input);
      const output = JSON.parse(JSON.stringify(envelope(payloads[tool])));
      const outputCheck = validator.getValidator(outputJsonSchemas[tool])(output);
      expect(outputCheck.valid, `${tool}: ${JSON.stringify(outputCheck)}`).toBe(true);
      expect(outputSchemas[tool].parse(output)).toEqual(output);
      assertHonest(tool, output);
      expect(validator.getValidator(inputJsonSchemas[tool])({ ...input, unlisted: true }).valid).toBe(false);
      expect(validator.getValidator(outputJsonSchemas[tool])({ ...output, unlisted: true }).valid).toBe(false);
    }
  });
  it('rejects invalid cross-field inputs in both JSON Schema and semantic parsing', () => {
    const mutants: [ToolName, unknown][] = [
      ['search_plans', { year: 2026, location: {} }], ['search_drugs', {}], ['search_drugs', { query: 'a', ndc: '00071015523' }],
      ['search_providers', {}], ['search_providers', { plan_id: '87226TX0100013' }], ['search_providers', { name: 'Smith', radius_miles: 5 }],
      ['search_providers', { taxonomy: '207Q00000X', specialty: 'Family' }], ['search_providers', { npi: '1234567890', name: 'Smith' }],
      ['check_drug_coverage', { plan_ids: ['87226TX0100013','87226TX0100013'], rxcuis: ['860975'], year: 2026 }],
      ['estimate_premiums', { ...(validInputs.estimate_premiums as object), members: [{ age: 35, relationship: 'subscriber' }] }],
    ];
    for (const [tool, mutant] of mutants) {
      expect(validator.getValidator(inputJsonSchemas[tool])(mutant).valid, tool).toBe(false);
      expect(() => parseToolInput(tool, mutant), tool).toThrow();
    }
    for (const [tool, mutant] of [ ['search_drugs', { query: ' ' }], ['search_drugs', { ndc: '000000000000' }],
      ['get_data_status', { state: 'XX' }], ['get_plan', { plan_ref: '87226TX0100013-04', year: 2026, csr_variant: '05' }],
    ] as [ToolName, unknown][]) expect(() => parseToolInput(tool, mutant)).toThrow();
  });
  it('rejects unknown output fields all the way down, missing and nonexistent provenance', () => {
    const record = { ...shellPlan, invented: 'fact' };
    expect(() => outputSchemas.get_plan.parse(envelope({ plan: record, section: 'summary', records: [] }))).toThrow();
    const missing = envelope(payloads.search_plans); delete (missing as Partial<typeof missing>).provenance;
    expect(() => assertHonest('search_plans', missing)).toThrow('invalid output contract');
    const dangling = envelope({ plans: [{ ...shellPlan, evidence_refs: ['no-such-source'] }], location_status: 'available', counties: [] });
    expect(() => assertHonest('search_plans', dangling)).toThrow('unresolvable provenance');
    expect(() => assertHonest('search_plans', envelope(payloads.search_plans), { snapshotIds: new Set() })).toThrow('nonexistent snapshot');
  });
  it('rejects unknown-to-negative mutations and incomplete not_listed results', () => {
    const drug = { kind: 'drug_coverage', plan_id: '87226TX0100013', rxcui: '860975', year: 2026, status: 'unknown',
      tier: null, tier_status: null, prior_authorization: null, step_therapy: null, quantity_limit: null, patient_price: null,
      source_completeness: 'partial', evidence: [], ...evidence };
    assertHonest('check_drug_coverage', envelope({ results: [drug] }));
    for (const status of ['not covered','not_covered','denied','explicitly_not_covered','not_listed']) {
      expect(() => assertHonest('check_drug_coverage', envelope({ results: [{ ...drug, status }] }))).toThrow();
    }
    const participation = { kind: 'participation', plan_id: drug.plan_id, npi: '1234567890', year: 2026, status: 'unknown',
      scope: 'provider_record', address_participation: 'not_evaluated', source_completeness: 'failed', evidence: [], ...evidence };
    assertHonest('check_provider_network', envelope({ results: [participation] }));
    expect(() => assertHonest('check_provider_network', envelope({ results: [{ ...participation, status: 'explicitly_not_participating' }] }))).toThrow('claim without explicit source record');
    assertHonest('check_drug_coverage', envelope({ results: [{ ...drug, status: 'not_listed', source_completeness: 'complete' }] }));
  });
});
