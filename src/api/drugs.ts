import { apiError } from "./errors.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlSession } from "../db/database.js";
import {
  searchDrugs,
  getDrug,
  checkDrugCoverage,
  checkDrugCoverages,
} from "../services/drugs.js";
import * as v from "./validation.js";
import { cmsFallbackContext } from "../ingest/cms-api/fallback.js";
import type { Context } from "hono";
import { requestSource } from "./rate-limit.js";
import { trustedProxies } from "../config/access.js";
import { declineFromBody } from "../services/upstream-disclosure.js";

/** The name the rate limiter gives the caller; bounds one client's share of fallback calls. */
const client = (c: Context) => requestSource(c, trustedProxies());

export function drugRoutes(db: SqlSession) {
  const app = new Hono();
  app.get("/drugs", async (c) =>
    c.json(
      await searchDrugs(
        db,
        c.req.query(),
        cmsFallbackContext(db, db, { client: client(c) }),
      ),
    ),
  );
  app.get("/drugs/:rxcui", async (c) =>
    c.json(await getDrug(db, c.req.param("rxcui"))),
  );
  app.get("/plans/:id/drugs/:rxcui", async (c) =>
    c.json(
      await checkDrugCoverage(
        db,
        c.req.param("id"),
        c.req.param("rxcui"),
        c.req.query("year"),
        cmsFallbackContext(db, db, { client: client(c) }),
      ),
    ),
  );
  app.post(
    "/drug-coverage",
    bodyLimit({
      maxSize: 65_536,
      onError: (c) => c.json(apiError("request_too_large", "body"), 400),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return v.fail("body", "invalid_json");
      }
      declineFromBody(body);
      return c.json(
        await checkDrugCoverages(
          db,
          body,
          cmsFallbackContext(db, db, { client: client(c) }),
        ),
      );
    },
  );
  return app;
}
