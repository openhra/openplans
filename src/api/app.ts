import { logInternalError, queryTimeoutResponse } from "./error-log.js";
import { isQueryTimeout } from "../services/errors.js";
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
import { loadConfig } from "../config/index.js";
import { apiToken } from "../config/access.js";
import { pluginRoutes } from "../plugins/routes.js";
import { SCHEMA_NOT_READY } from "./schema-gate.js";
import type { SchemaGate } from "./schema-gate.js";

export function createApp(
  db: SqlSession,
  options: ApiOptions = { premiumToken: apiToken() },
  cacheOptions?: ResponseCacheOptions,
  // The servers pass one; without it no route checks the migration journal.
  schema?: SchemaGate,
) {
  const app = new Hono();
  const cache = createResponseCache(db, options.premiumToken, cacheOptions);
  const config = () => cacheOptions?.config ?? loadConfig();
  const plugins = cacheOptions?.plugins?.routes.length
    ? pluginRoutes(cacheOptions.plugins, {
        db,
        operatorToken: () => config().tokens.operator?.reveal(),
        trustedProxies: options.trustedProxies ?? config().trustProxy,
        peerAddress: options.peerAddress,
        now: options.now,
      })
    : undefined;
  // Pending migrations answer 503 before admission counts the request or the cache sees it.
  if (schema) app.use("*", schema.middleware);
  // Admission precedes the cache so cached quotes count against the same limits.
  app.use("/v1/quotes", ...publicQuoteAdmission(options));
  // Plugin exposure and rate limits too; their handlers mount after the core routes.
  plugins?.guard(app);
  app.use("*", cache.middleware);

  // Liveness: the process and its database connection. A pending schema is reported, not failed,
  // so Compose can start the worker that migrates.
  app.get("/healthz", async (c) => {
    const healthy = await checkDatabase(db);
    const schemaStatus = healthy ? await schema?.status() : undefined;
    if (schemaStatus?.state === "pending")
      return c.json(
        {
          status: "ok",
          db: "ok",
          schema: "not_ready",
          pending: schemaStatus.pending,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    return c.json(
      { status: "ok", db: healthy ? "ok" : "down" },
      healthy ? 200 : 503,
    );
  });

  // Readiness: 200 only once the database answers and every migration is applied.
  app.get("/readyz", async (c) => {
    const noStore = { "Cache-Control": "no-store" };
    if (!(await checkDatabase(db)))
      return c.json({ status: "not_ready", reason: "db_down" }, 503, noStore);
    const schemaStatus = (await schema?.status()) ?? {
      state: "ready",
      pending: 0,
    };
    if (schemaStatus.state === "pending")
      return c.json(
        {
          status: "not_ready",
          reason: SCHEMA_NOT_READY,
          pending: schemaStatus.pending,
        },
        503,
        noStore,
      );
    if (schemaStatus.state === "unknown")
      return c.json(
        { status: "not_ready", reason: "schema_unknown" },
        503,
        noStore,
      );
    return c.json({ status: "ready" }, 200, noStore);
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
  plugins?.mount(app);

  app.onError((error, c) => {
    if (isQueryTimeout(error)) return queryTimeoutResponse(c);
    logInternalError(error);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}
