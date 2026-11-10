import { Hono } from "hono";
import type { SqlSession } from "../db/database.js";
import {
  getMedicareBenefits,
  getMedicareDrug,
  getMedicareLineage,
  getMedicarePharmacies,
  getMedicarePlan,
  getMedicareServiceArea,
  medicareAvailability,
  searchMedicarePlans,
} from "../services/medicare.js";

/** Medicare plan data from CMS public files. No personal data and no age rating: no token. */
export function medicareRoutes(db: SqlSession) {
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
    c.json(await getMedicareDrug(db, c.req.param("key"), c.req.query())),
  );
  app.get("/medicare/plans/:key/pharmacies", async (c) =>
    c.json(await getMedicarePharmacies(db, c.req.param("key"), c.req.query())),
  );
  return app;
}
