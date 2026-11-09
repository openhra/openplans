import {
  lookupZip,
  searchPlans,
  getPlan,
  benchmarkSilver,
  listCarriersNetworks,
} from "../services/catalog.js";
import { ReadError } from "../services/errors.js";
import { providerRoutes } from "./providers.js";
import { drugRoutes } from "./drugs.js";
import { Hono } from "hono";
import type { SqlSession } from "../db/database.js";
import * as v from "./validation.js";

import { personalizedOnly, quoteRoutes } from "./quotes.js";
import type { QuoteOptions } from "./quotes.js";

export type ApiOptions = QuoteOptions;
export function nativeRoutes(db: SqlSession, options: ApiOptions) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof v.InputError) {
      return c.json({ error: { code: error.code, field: error.field } }, 400);
    } else if (error instanceof ReadError) {
      return c.json(
        { error: error.error },
        error.error.code === "unsupported_without_taxonomy" ? 422 : 404,
      );
    } else {
      return c.json({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
  });

  app.route("/", drugRoutes(db));
  app.route("/", providerRoutes(db));

  app.get("/zip-counties", async (c) =>
    c.json(await lookupZip(db, c.req.query("zip"))),
  );

  app.get("/plans", async (c) => c.json(await searchPlans(db, c.req.query())));

  app.get("/plans/:id", async (c) =>
    c.json(await getPlan(db, v.planId(c.req.param("id")).full, c.req.query())),
  );

  app.route("/", quoteRoutes(db, options));
  app.use("/benchmark", personalizedOnly(options));
  app.get("/benchmark", async (c) =>
    c.json(await benchmarkSilver(db, c.req.query())),
  );

  for (const kind of ["carriers", "networks"] as const) {
    app.get(`/${kind}`, async (c) => {
      return c.json(await listCarriersNetworks(db, kind, c.req.query()));
    });
  }
  return app;
}
