import { logInternalError } from "./error-log.js";
import { createMcpHttp } from "../mcp/http.js";
import { Hono } from "hono";
import { checkDatabase } from "../db/availability.js";
import type { SqlSession } from "../db/database.js";
import { nativeRoutes } from "./routes.js";
import type { ApiOptions } from "./routes.js";
import { InputError, state, year } from "./validation.js";
import { dataAvailability } from "./availability.js";
import { compatRoutes } from "../compat/v1/index.js";
import { createResponseCache } from "./cache/index.js";
import type { ResponseCacheOptions } from "./cache/index.js";
import { publicQuoteAdmission } from "./quotes.js";

export function createApp(
  db: SqlSession,
  options: ApiOptions = { premiumToken: process.env.OPENPLANS_API_TOKEN },
  cacheOptions?: ResponseCacheOptions,
) {
  const app = new Hono();
  const cache = createResponseCache(db, options.premiumToken, cacheOptions);
  // Admission precedes the cache so cached quotes count against the same limits.
  app.use("/v1/quotes", ...publicQuoteAdmission(options));
  app.use("*", cache.middleware);

  app.get("/healthz", async (c) => {
    const healthy = await checkDatabase(db);
    return c.json(
      { status: "ok", db: healthy ? "ok" : "down" },
      healthy ? 200 : 503,
    );
  });

  app.get("/v1/cache-stats", (c) => c.json(cache.stats()));

  app.get("/v1/data-availability", async (c) => {
    try {
      const stateFilter =
        c.req.query("state") === undefined
          ? undefined
          : state(c.req.query("state"));
      const yearFilter =
        c.req.query("year") === undefined
          ? undefined
          : year(c.req.query("year"));
      return c.json(
        (await dataAvailability(db)).filter(
          (row) =>
            (stateFilter === undefined || row.state === stateFilter) &&
            (yearFilter === undefined || row.plan_year === yearFilter),
        ),
      );
    } catch (error) {
      if (error instanceof InputError)
        return c.json({ error: { code: error.code, field: error.field } }, 400);
      return c.json({ error: "data_availability_unavailable" }, 503);
    }
  });

  app.route("/", createMcpHttp(db));
  app.route("/v1", nativeRoutes(db, options));
  app.route("/", compatRoutes(db, options));

  app.onError((error, c) => {
    logInternalError(error);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
