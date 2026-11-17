import type { MiddlewareHandler } from "hono";
import type { CoreConfig } from "../config/index.js";
import { currentRegistries } from "./registries.js";
import type { PluginRegistries } from "./registries.js";
import { ReadError } from "../services/errors.js";
import { requireCatalogServingReady } from "../services/catalog-policy.js";

export type OperationBasis =
  "public" | "calculation" | "offering" | "unsupported";
const publicHttp = new Set([
  "GET /healthz",
  "GET /readyz",
  "GET /v1/data-availability",
  "GET /v1/cache-stats",
  "GET /v1/zip-counties",
  "GET /v1/drugs",
  "GET /compat/v1/zip_counties",
  "GET /compat/v1/drugs",
  "GET /compat/v1/specialties",
]);
const calculationHttp = new Set([
  "GET /v1/benchmark",
  "POST /v1/ichra/affordability",
  "POST /v1/ichra/affordability/batch",
]);
const offeringHttp = new Set([
  "GET /v1/plans",
  "POST /v1/quotes",
  "POST /v1/premium-quotes",
  "GET /v1/carriers",
  "GET /v1/networks",
  "POST /compat/v1/plans/medical/search",
  "POST /compat/v1/plans/dental/search",
  "GET /compat/v1/carriers",
  "GET /compat/v1/networks",
  "POST /v1/provider-participation",
  "POST /v1/drug-coverage",
  "GET /v1/providers",
  "POST /compat/v1/providers/search",
]);

/** Exact classification defaults to refusal for new routes and plugin catalog operations. */
export function classifyCatalogHttp(
  method: string,
  path: string,
): OperationBasis {
  const key = `${method} ${path}`;
  if (publicHttp.has(key)) return "public";
  if (calculationHttp.has(key)) return "calculation";
  if (offeringHttp.has(key)) return "offering";
  if (method === "GET" && /^\/v1\/plans\/[^/]+$/.test(path)) return "offering";
  if (
    method === "GET" &&
    /^\/v1\/plans\/[^/]+\/(?:providers|drugs)\/[^/]+$/.test(path)
  )
    return "offering";
  if (method === "GET" && /^\/v1\/providers\/[^/]+$/.test(path))
    return "offering";
  if (method === "GET" && /^\/v1\/drugs\/[^/]+$/.test(path)) return "public";
  if (
    method === "GET" &&
    /^\/compat\/v1\/plans\/(?:medical\/|dental\/)?[^/]+$/.test(path)
  )
    return "offering";
  return "unsupported";
}
export function classifyCatalogTool(name: string): OperationBasis {
  if (["lookup_geography", "get_data_status", "search_drugs"].includes(name))
    return "public";
  if (["check_ichra_affordability", "get_benchmark"].includes(name))
    return "calculation";
  if (
    [
      "search",
      "fetch",
      "search_plans",
      "get_plan",
      "quote_plans",
      "quote_premiums",
      "check_drug_coverage",
      "check_provider_network",
      "list_carriers_networks",
      "search_providers",
    ].includes(name)
  )
    return "offering";
  return "unsupported";
}

export function catalogPolicyAdmission(
  config: CoreConfig,
  registries?: Partial<Pick<PluginRegistries, "catalogPolicies">>,
): MiddlewareHandler {
  return async (c, next) => {
    const catalogPolicy = config.catalogPolicy;
    if (!catalogPolicy) return next();
    const basis = classifyCatalogHttp(c.req.method, c.req.path);
    c.header("Cache-Control", "no-store");
    if (basis === "public") return next();
    try {
      const provider = registries?.catalogPolicies?.[catalogPolicy.provider];
      if (!provider) throw new ReadError({ code: "MSOT_PROVIDER_UNAVAILABLE" });
      const selector = c.req.header("X-OpenPlans-MSoT");
      if (selector === "public") {
        if (!catalogPolicy.allowPublicRead)
          throw new ReadError({ code: "MSOT_PUBLIC_READ_FORBIDDEN" });
        // Explicit public reads never apply policy and cannot select a policy version/date.
        if (
          c.req.header("X-OpenPlans-MSoT-Version") ||
          c.req.header("X-OpenPlans-MSoT-Date")
        )
          throw new ReadError({ code: "MSOT_SELECTOR_CONFLICT" });
        return next();
      }
      if (basis === "unsupported")
        throw new ReadError({ code: "MSOT_OPERATION_UNSUPPORTED" });
      requireCatalogServingReady();
    } catch (error) {
      if (error instanceof ReadError)
        return c.json({ error: error.error }, 403);
      throw error;
    }
  };
}

export function assertCatalogToolAdmission(
  config: CoreConfig["catalogPolicy"],
  name: string,
) {
  if (!config) return;
  if (classifyCatalogTool(name) === "public") return;
  if (!currentRegistries()?.catalogPolicies[config.provider])
    throw new ReadError({ code: "MSOT_PROVIDER_UNAVAILABLE" });
  if (classifyCatalogTool(name) === "unsupported")
    throw new ReadError({ code: "MSOT_OPERATION_UNSUPPORTED" });
  requireCatalogServingReady();
}
