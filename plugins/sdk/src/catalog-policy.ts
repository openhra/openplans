import type { McpToolContext } from "./contracts.js";

export interface CanonicalPlanRequest {
  plan_ids: string[];
  year: number;
}
export interface CanonicalPlan {
  readonly id: string;
  readonly base_plan_id: string;
  readonly plan_year: number;
  readonly issuer_id: string | null;
  readonly state: string | null;
  readonly product_family: "medical" | "dental";
  readonly business_market: string;
  readonly on_exchange: boolean | null;
  readonly off_exchange: boolean | null;
  readonly provenance: {
    readonly snapshot_id: string;
    readonly source_row: number;
    readonly channel_granularity: "base_plan";
  };
}
export interface CanonicalPlanBatch {
  readonly catalog_generation: string;
  readonly plans: readonly CanonicalPlan[];
}
/** Host-owned bounded reads; callers supply the current request's session and cancellation. */
export interface CanonicalReader {
  plans(
    input: CanonicalPlanRequest,
    scope: McpToolContext,
  ): Promise<CanonicalPlanBatch>;
}
export interface CatalogPolicyInput extends CanonicalPlanRequest {
  source_id: string;
  as_of?: string;
  market_segment?: "on_exchange" | "off_exchange";
}
export interface CatalogPolicyProvenance {
  readonly id: string;
  readonly origin: "msot" | "msot_default";
  readonly source_id: string;
  readonly version: number;
  readonly definition: string;
  readonly rule_id: string | null;
  readonly matched_scope: Readonly<Record<string, string | undefined>> | null;
  readonly set_by: string;
  readonly set_at: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly reason_code: string;
  readonly unresolved_dimensions?: readonly string[];
  readonly candidate_rule_ids?: readonly string[];
}
export type CatalogFieldValue =
  | { readonly state: "known"; readonly value: boolean | string | number }
  | { readonly state: "unknown"; readonly value: null };
export type CatalogFieldResolution = CatalogFieldValue & {
  readonly origin: "msot" | "msot_default";
  readonly provenance_ref: string;
  readonly public: { readonly state: "not_defined"; readonly value: null };
};
export interface CatalogPolicyResolution {
  readonly msot: {
    readonly source_id: string;
    readonly version: number;
    readonly version_hash: string;
    readonly as_of: string;
    readonly catalog_generation: string;
    readonly evaluator_version: number;
    readonly dimension_schema_version: number;
    readonly provenance: readonly CatalogPolicyProvenance[];
  };
  readonly plans: readonly {
    readonly id: string;
    readonly public: CanonicalPlan;
    readonly msot: {
      readonly by_market_segment: Readonly<
        Partial<
          Record<
            "on_exchange" | "off_exchange" | "unknown",
            {
              readonly applicability: "applicable" | "inapplicable" | "unknown";
              readonly fields: Readonly<Record<string, CatalogFieldResolution>>;
            }
          >
        >
      >;
    };
  }[];
}
/** Annotation only. A provider cannot change public rows or select catalog offerings. */
export interface CatalogPolicyProvider {
  resolve(
    input: CatalogPolicyInput,
    scope: McpToolContext,
  ): Promise<CatalogPolicyResolution>;
}
export interface CatalogPolicyRegistry {
  provide(name: string, provider: CatalogPolicyProvider): void;
}
