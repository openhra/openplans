import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CatalogFieldResolution,
  CatalogPolicyProvider,
  CatalogPolicyResolution,
  McpToolContext,
} from "@openplans/plugin-sdk";
import type { CoreConfig } from "../config/index.js";
import {
  restrictCacheLevel,
  runWithScope,
  scopeCacheLevel,
} from "../plugins/request-scope.js";
import { ReadError } from "./errors.js";

type Segment = "on_exchange" | "off_exchange";
type FieldName = "marketable" | "custom_payment_allowed";
export type PolicyConfig = NonNullable<CoreConfig["catalogPolicy"]>;
export interface FieldFilter {
  field: FieldName;
  operator: "eq" | "state";
  value: boolean | "unknown";
}
export interface PolicySelection {
  market_segment?: Segment;
  filters?: readonly FieldFilter[];
}
interface PolicyRequest {
  readonly catalogPolicy: PolicyConfig;
  readonly provider: CatalogPolicyProvider;
  readonly scope: McpToolContext;
  readonly transport: "rest" | "compat" | "mcp";
  readonly asOf: string;
  readonly selection: PolicySelection;
  readonly resolvedPlans: Map<string, CatalogPolicyResolution["plans"][number]>;
  readonly answers: Map<string, Promise<CatalogPolicyResolution>>;
  pinned?: CatalogPolicyResolution["msot"];
}
const requests = new AsyncLocalStorage<PolicyRequest>();
const refuse = (code: string): never => {
  throw new ReadError({ code });
};
export const catalogPolicyActive = () => requests.getStore() !== undefined;
export const catalogPolicyContext = () => {
  const pinned = requests.getStore()?.pinned;
  return pinned ? structuredClone(pinned) : undefined;
};
export function catalogPolicyAnswerContext() {
  const request = requests.getStore();
  const pinned = request?.pinned;
  if (!request || !pinned) return undefined;
  const definitions =
    pinned.field_definitions?.filter(
      (d) =>
        d.visibility.audience === "answer" && d.visibility[request.transport],
    ) ?? [];
  const visible = new Set(definitions.map((d) => d.name));
  return structuredClone({
    ...pinned,
    field_definitions: definitions,
    provenance: pinned.provenance.filter((p) =>
      visible.has(p.definition.split("@")[0]!),
    ),
  });
}
export function withCatalogPolicyContext<T extends object>(answer: T) {
  const msot = catalogPolicyAnswerContext();
  return msot ? { ...answer, msot } : answer;
}

/** Internal request boundary. Hosts must pass serving readiness before entering it. */
export function withCatalogPolicy<T>(
  catalogPolicy: PolicyConfig,
  provider: CatalogPolicyProvider,
  scope: McpToolContext,
  transport: PolicyRequest["transport"],
  selection: PolicySelection,
  run: () => Promise<T>,
): Promise<T> {
  const inherited = requests.getStore();
  if (inherited) {
    if (
      JSON.stringify(inherited.catalogPolicy) !==
        JSON.stringify(catalogPolicy) ||
      inherited.provider !== provider ||
      inherited.transport !== transport ||
      JSON.stringify(inherited.selection) !== JSON.stringify(selection)
    )
      return refuse("msot_context_mismatch");
    return run();
  }
  const request: PolicyRequest = {
    catalogPolicy: structuredClone(catalogPolicy),
    provider,
    scope,
    transport,
    selection: structuredClone(selection),
    asOf: catalogPolicy.asOf ?? new Date().toISOString().slice(0, 10),
    answers: new Map(),
    resolvedPlans: new Map(),
  };
  return runWithScope(async () => {
    restrictCacheLevel("request");
    return requests.run(request, run);
  });
}

export function parsePolicySelection(
  params: Record<string, unknown>,
): PolicySelection {
  const filters: FieldFilter[] = [];
  const aliases = new Set<string>();
  let segment: Segment | undefined;
  if (params.market_segment !== undefined) {
    if (
      params.market_segment !== "on_exchange" &&
      params.market_segment !== "off_exchange"
    )
      return refuse("msot_invalid_filter");
    segment = params.market_segment;
  }
  for (const [key, raw] of Object.entries(params)) {
    let field: string, operator: string;
    if (["marketable", "custom_payment_allowed"].includes(key)) {
      field = key;
      operator = "eq";
    } else if (key.startsWith("msot.field.")) {
      const match = /^msot\.field\.([a-z_]+)\.(eq|state)$/.exec(key);
      if (!match) return refuse("msot_invalid_filter");
      field = match[1]!;
      operator = match[2]!;
    } else continue;
    if (!["marketable", "custom_payment_allowed"].includes(field))
      return refuse("msot_invalid_filter");
    if (aliases.has(field)) return refuse("msot_conflicting_filter");
    aliases.add(field);
    if (operator === "state") {
      if (raw !== "unknown") return refuse("msot_invalid_filter");
      filters.push({ field: field as FieldName, operator, value: "unknown" });
    } else {
      if (![true, false, "true", "false"].includes(raw as boolean | string))
        return refuse("msot_invalid_filter");
      filters.push({
        field: field as FieldName,
        operator: "eq",
        value: raw === true || raw === "true",
      });
    }
  }
  if (filters.length && !segment) return refuse("market_segment_required");
  return { market_segment: segment, filters };
}

function checkContext(request: PolicyRequest, result: CatalogPolicyResolution) {
  const context = result.msot;
  for (const filter of request.selection.filters ?? []) {
    const definition = context.field_definitions?.find(
      (f) => f.name === filter.field,
    );
    if (
      !definition?.filterable ||
      definition.visibility.audience !== "answer" ||
      !definition.visibility[request.transport]
    )
      return refuse("msot_invalid_filter");
  }
  if (
    context.source_id !== request.catalogPolicy.source ||
    context.as_of !== request.asOf ||
    (typeof request.catalogPolicy.version === "number" &&
      context.version !== request.catalogPolicy.version)
  )
    return refuse("msot_context_mismatch");
  if (request.pinned) {
    const previous = request.pinned;
    if (
      [
        "source_id",
        "version",
        "version_hash",
        "as_of",
        "catalog_generation",
        "evaluator_version",
        "dimension_schema_version",
      ].some(
        (key) =>
          previous[key as keyof typeof previous] !==
          context[key as keyof typeof context],
      )
    )
      return refuse("msot_context_changed");
    const provenance = new Map(previous.provenance.map((p) => [p.id, p]));
    for (const entry of context.provenance)
      provenance.set(entry.id, structuredClone(entry));
    request.pinned = { ...previous, provenance: [...provenance.values()] };
  } else request.pinned = structuredClone(context);
}

async function resolutions(ids: readonly string[], year: number) {
  const request = requests.getStore();
  if (!request) return undefined;
  request.scope.signal.throwIfAborted();
  if (ids.length > 10000) return refuse("msot_candidate_limit");
  const memoize = scopeCacheLevel() !== "none";
  if (!memoize) {
    request.answers.clear();
    request.resolvedPlans.clear();
  }
  const resolved = memoize
    ? new Map(request.resolvedPlans)
    : new Map<string, CatalogPolicyResolution["plans"][number]>();
  const unique = [...new Set(ids)].filter(
    (id) => !resolved.has(JSON.stringify([year, id])),
  );
  for (let offset = 0; offset < unique.length; offset += 100) {
    request.scope.signal.throwIfAborted();
    const planIds = unique.slice(offset, offset + 100);
    const version =
      request.pinned?.version ??
      (typeof request.catalogPolicy.version === "number"
        ? request.catalogPolicy.version
        : undefined);
    const input = {
      source_id: request.catalogPolicy.source,
      ...(version === undefined ? {} : { version }),
      plan_ids: planIds,
      year,
      as_of: request.asOf,
      ...(request.selection.market_segment
        ? { market_segment: request.selection.market_segment }
        : {}),
    };
    const key = JSON.stringify([
      request.catalogPolicy.provider,
      request.transport,
      request.catalogPolicy.selection,
      input,
    ]);
    let answer = memoize ? request.answers.get(key) : undefined;
    if (!answer) {
      answer = request.provider.resolve(input, request.scope);
      if (memoize && scopeCacheLevel() !== "none")
        request.answers.set(key, answer);
    }
    const result = await answer;
    checkContext(request, result);
    if (
      result.plans.length !== planIds.length ||
      result.plans.some((p, i) => p.id !== planIds[i])
    )
      return refuse("msot_context_mismatch");
    for (const plan of result.plans) {
      const identity = JSON.stringify([year, plan.id]);
      const copy = structuredClone(plan);
      resolved.set(identity, copy);
      if (scopeCacheLevel() !== "none")
        request.resolvedPlans.set(identity, copy);
    }
    if (scopeCacheLevel() === "none") {
      request.answers.clear();
      request.resolvedPlans.clear();
    }
  }
  return new Map(
    ids.map((id) => [id, resolved.get(JSON.stringify([year, id]))!]),
  );
}
function channel(
  plan: CatalogPolicyResolution["plans"][number],
  request: PolicyRequest,
) {
  const segments = Object.values(plan.msot.by_market_segment).filter(
    (c) => c?.applicability !== "inapplicable",
  );
  if (!request.selection.market_segment && segments.length !== 1)
    return refuse("market_segment_required");
  return request.selection.market_segment
    ? plan.msot.by_market_segment[request.selection.market_segment]
    : segments[0];
}
export function matchesPolicyFilter(
  value: CatalogFieldResolution | undefined,
  filter: FieldFilter,
) {
  return filter.operator === "state"
    ? value?.state === "unknown"
    : value?.state === "known" && value.value === filter.value;
}
function selected(
  plan: CatalogPolicyResolution["plans"][number],
  request: PolicyRequest,
) {
  if (
    request.catalogPolicy.selection === "annotation" &&
    !request.selection.filters?.length
  )
    return true;
  const segment = channel(plan, request);
  if (!segment || segment.applicability === "inapplicable") return false;
  if (
    request.catalogPolicy.selection === "marketable_only" &&
    (segment.applicability !== "applicable" ||
      !matchesPolicyFilter(segment.fields.marketable, {
        field: "marketable",
        operator: "eq",
        value: true,
      }))
  )
    return false;
  return (request.selection.filters ?? []).every((f) =>
    matchesPolicyFilter(segment.fields[f.field], f),
  );
}

/** Resolve the complete bounded candidate relation before counts, sort or pagination. */
export async function selectCatalogPlans<T>(
  plans: readonly T[],
  year: number,
  identity: (plan: T) => string,
): Promise<T[]> {
  const request = requests.getStore();
  if (!request) return [...plans];
  const resolved = await resolutions(plans.map(identity), year);
  return plans.filter((p) => selected(resolved!.get(identity(p))!, request));
}

/** Direct and nested evidence reads withhold offerings without changing coverage evidence. */
export async function guardCatalogPlans(ids: readonly string[], year: number) {
  const request = requests.getStore();
  if (!request) return;
  const resolved = await resolutions(ids, year);
  for (const id of ids) {
    const plan = resolved!.get(id)!;
    if (request.catalogPolicy.selection === "marketable_only") {
      const result = channel(plan, request);
      const value = result?.fields.marketable;
      if (result?.applicability !== "applicable" || value?.state !== "known")
        throw new ReadError({
          code: "marketability_unknown",
          plan_id: id,
          year,
        });
      if (value?.value !== true)
        throw new ReadError({ code: "plan_not_marketable", plan_id: id, year });
    }
    if (!selected(plan, request)) refuse("msot_filter_mismatch");
  }
}

export async function annotateCatalogPlan<T extends object>(
  plan: T,
  id: string,
  year: number,
): Promise<T & { msot?: CatalogPolicyResolution["plans"][number]["msot"] }> {
  const result = await resolutions([id], year);
  if (!result) return plan;
  const request = requests.getStore()!;
  const definitions = request.pinned?.field_definitions ?? [];
  const visible = new Set(
    definitions
      .filter(
        (d) =>
          d.visibility.audience === "answer" && d.visibility[request.transport],
      )
      .map((d) => d.name),
  );
  const original = structuredClone(result.get(id)!.msot);
  const by_market_segment = Object.fromEntries(
    Object.entries(original.by_market_segment).map(([segment, value]) => [
      segment,
      value && {
        ...value,
        fields: Object.fromEntries(
          Object.entries(value.fields).filter(([name]) => visible.has(name)),
        ),
      },
    ]),
  );
  return {
    ...plan,
    msot: { ...catalogPolicyAnswerContext(), by_market_segment },
  };
}

/** No serving activation is exposed until every transport and nested-read adapter is verified. */
export function requireCatalogServingReady(): never {
  return refuse("msot_serving_disabled");
}
