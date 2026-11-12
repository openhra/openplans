import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../db/database.js";
import { credentialMatches } from "../compat/v1/auth.js";
import { restrictCacheLevel } from "../plugins/request-scope.js";
import { medicareDrugResponseSchema } from "./medicare-schemas.js";
import {
  estimateMedicareDrugCost,
  getMedicareBenefits,
  getMedicareDrug,
  getMedicareLineage,
  getMedicarePharmacies,
  getMedicarePlan,
  getMedicareServiceArea,
  medicareAvailability,
  searchMedicarePlans,
} from "../services/medicare.js";
import { drugCostDeps } from "../services/medicare-drug-cost.js";
import type { DrugCostDeps } from "../services/medicare-drug-cost.js";
import type { QuoteOptions } from "./quotes.js";
import * as v from "./validation.js";

/**
 * The personalized-estimate grant for HTTP is the operator's API Bearer token. Unlike the household
 * routes this never opens to anonymous callers. With no token configured the route answers
 * AUTH_NOT_CONFIGURED. Responses are never stored by HTTP caches.
 */
export function estimateGrant(options: QuoteOptions): MiddlewareHandler {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!options.premiumToken)
      return c.json({ error: { code: "AUTH_NOT_CONFIGURED" } }, 503);
    if (
      !credentialMatches(
        c.req.header("authorization"),
        `Bearer ${options.premiumToken}`,
      )
    )
      return c.json({ error: { code: "UNAUTHORIZED" } }, 401);
    await next();
  };
}

export interface MedicareRouteDeps {
  grant: (options: QuoteOptions) => MiddlewareHandler;
  /** Marks the request so no response cache stores it, whatever TTL a route table holds. */
  restrict: () => void;
  service: DrugCostDeps;
}
export const medicareRouteDeps: MedicareRouteDeps = {
  grant: estimateGrant,
  restrict: () => restrictCacheLevel("none"),
  service: drugCostDeps,
};

const estimateBodyLimit = bodyLimit({
  maxSize: 65_536,
  onError: (c) =>
    c.json({ error: { code: "REQUEST_TOO_LARGE", field: "body" } }, 400),
});

/**
 * Medicare plan data from CMS public files. The GET routes carry no personal data and need no
 * token. The drug-cost estimate takes a fill schedule, so it needs the personalized-estimate grant
 * and is never cached.
 */
export function medicareRoutes(
  db: SqlSession,
  options: QuoteOptions = {},
  deps: MedicareRouteDeps = medicareRouteDeps,
) {
  const app = new Hono();
  app.get("/medicare/data-availability", async (c) =>
    c.json(await medicareAvailability(db)),
  );
  app.get("/medicare/plans", async (c) =>
    c.json(await searchMedicarePlans(db, c.req.query())),
  );
  app.get("/medicare/plans/:key", async (c) =>
    c.json(await getMedicarePlan(db, c.req.param("key"), c.req.query())),
  );
  app.get("/medicare/plans/:key/benefits", async (c) =>
    c.json(await getMedicareBenefits(db, c.req.param("key"), c.req.query())),
  );
  app.get("/medicare/plans/:key/service-area", async (c) =>
    c.json(await getMedicareServiceArea(db, c.req.param("key"), c.req.query())),
  );
  app.get("/medicare/plans/:key/lineage", async (c) =>
    c.json(await getMedicareLineage(db, c.req.param("key"), c.req.query())),
  );
  app.get("/medicare/plans/:key/drugs", async (c) =>
    c.json(
      medicareDrugResponseSchema.parse(
        await getMedicareDrug(db, c.req.param("key"), c.req.query()),
      ),
    ),
  );
  app.get("/medicare/plans/:key/pharmacies", async (c) =>
    c.json(await getMedicarePharmacies(db, c.req.param("key"), c.req.query())),
  );
  const estimates = "/medicare/plans/:key/drug-cost-estimates";
  app.use(estimates, async (_c, next) => {
    deps.restrict();
    await next();
  });
  app.use(estimates, deps.grant(options));
  app.post(estimates, estimateBodyLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return v.fail("body", "INVALID_JSON");
    }
    return c.json(
      await estimateMedicareDrugCost(
        db,
        c.req.param("key"),
        c.req.query(),
        body,
        deps.service,
      ),
    );
  });
  return app;
}
