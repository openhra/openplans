import type { CanonicalPlan, CanonicalReader } from "@openplans/plugin-sdk";
import type { Source } from "../src/schema.js";
// Synthetic identities and operator instructions, never insurance or payment evidence.
export const source: Source = {
  source_id: "agency-market",
  version: 1,
  product_families: ["medical", "dental"],
  business_markets: ["individual"],
  fields: [
    {
      name: "custom_payment_allowed",
      entity: "plan",
      definition_version: 1,
      type: "boolean",
      allowed_values: [true, false],
      default: { state: "unknown", value: null },
      description:
        "Permission for the operator payment workflow; does not establish insurer acceptance or binding authority.",
      visibility: { audience: "answer", rest: true, compat: false, mcp: true },
      filterable: false,
      set_by: "operator-demo",
      set_at: "2026-11-15T12:00:00Z",
    },
  ],
  rules: [
    {
      id: "payment-tx-off",
      field: "custom_payment_allowed",
      scope: {
        issuer_id: "issuer-demo-a",
        state: "TX",
        market_segment: "off_exchange",
      },
      valid_from: "2026-11-15",
      valid_until: null,
      value: { state: "known", value: true },
      set_by: "operator-demo",
      set_at: "2026-11-15T12:00:00Z",
      reason_code: "payment_workflow_enabled",
    },
  ],
};
export const plans: CanonicalPlan[] = [
  {
    id: "plan-demo-a",
    issuer_id: "issuer-demo-a",
    on_exchange: false,
    off_exchange: true,
  },
  {
    id: "plan-demo-b",
    issuer_id: "issuer-demo-a",
    on_exchange: true,
    off_exchange: false,
  },
  {
    id: "plan-demo-c",
    issuer_id: "issuer-demo-b",
    on_exchange: false,
    off_exchange: true,
  },
].map((p) => ({
  ...p,
  base_plan_id: p.id,
  plan_year: 2026,
  state: "TX",
  product_family: "medical",
  business_market: "individual",
  provenance: {
    snapshot_id: "synthetic-snapshot",
    source_row: 1,
    channel_granularity: "base_plan",
  },
}));
export const reader: CanonicalReader = {
  validateScopes: async () => {},
  plans: async (input) => ({
    catalog_generation: "synthetic-generation",
    plans: input.plan_ids.map((id) => plans.find((p) => p.id === id)!),
  }),
};
export const input = {
  source_id: source.source_id,
  plan_ids: plans.map((p) => p.id),
  year: 2026,
  as_of: "2026-11-15",
};
export const db = { query: async () => ({ rows: [] }), exec: async () => {} };
export const scope = { db, signal: new AbortController().signal };

// Synthetic operator decisions over the shared synthetic canonical reader.
export function marketSource(): Source {
  const result = structuredClone(source);
  result.fields.push({
    ...result.fields[0]!,
    name: "marketable",
    filterable: true,
    visibility: { audience: "answer", rest: true, compat: true, mcp: true },
    description: "The operator offers this plan in the selected channel.",
  });
  result.rules.push({ ...result.rules[0]!, id: "offer", field: "marketable" });
  return result;
}
