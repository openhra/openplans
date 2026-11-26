import { apiError, apiErrorFrom } from "./errors.js";
import { releaseFactsReader } from "./release-facts.js";
import { requestIdMiddleware } from "./request-id.js";
import { ReadError } from "../services/errors.js";
import { servingPolicy } from "../services/data-window.js";
import { catalogPolicyAdmission } from "../plugins/catalog-policy.js";
import { activeRecorder, httpObserver } from "../telemetry/observer.js";
import type { Labels } from "../telemetry/aggregate.js";
import { logInternalError, queryTimeoutResponse } from "./error-log.js";
import { isQueryTimeout } from "../services/errors.js";
import { createMcpHttp } from "../mcp/http.js";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type { SqlSession } from "../db/database.js";
import { nativeRoutes } from "./routes.js";
import type { ApiOptions } from "./routes.js";
import { InputError, state, year } from "./validation.js";
import { dataAvailability } from "./availability.js";
import { compatRoutes } from "../compat/v1/index.js";
import { createResponseCache } from "./cache/index.js";
import type { ResponseCacheOptions } from "./cache/index.js";
import { publicQuoteAdmission } from "./quotes.js";
import { upstreamDisclosure } from "./upstream.js";
import { loadConfig } from "../config/index.js";
import { apiToken } from "../config/access.js";
import { createAdminAuth } from "../operator/auth-routes.js";
import { ADMIN_PLUGIN } from "../plugins/registries.js";
import { pluginRoutes } from "../plugins/routes.js";
import { prepareCmsZipFallback } from "../ingest/geo/cms.js";
import { SCHEMA_NOT_READY } from "./schema-gate.js";
import type { SchemaGate, SchemaStatus } from "./schema-gate.js";

export function createApp(
  db: SqlSession,
  options: ApiOptions = { premiumToken: apiToken() },
  cacheOptions?: ResponseCacheOptions,
  // The servers pass one; without it no route checks the migration journal.
  schema?: SchemaGate,
  operatorCommands?: { writable: () => boolean },
) {
  const app = new Hono();
  // First, so every later middleware, handler and error answer runs with the id in scope.
  app.use("*", requestIdMiddleware);
  const telemetry = activeRecorder();
  const operations = new Map<string, Labels>();
  if (telemetry) {
    const unmatched = telemetry.register("http", "unmatched");
    app.use(
      "*",
      httpObserver((method, template) => {
        if (template === "/admin" || template.startsWith("/admin/"))
          return undefined;
        return (
          operations.get(`${method} ${template}`) ??
          operations.get(`ALL ${template}`) ??
          unmatched
        );
      }),
    );
  }
  const cache = createResponseCache(db, options.premiumToken, cacheOptions);
  const config = () => cacheOptions?.config ?? loadConfig();
  const adminEnabled = () =>
    cacheOptions?.plugins?.routes.some(
      ({ plugin, spec }) =>
        plugin === ADMIN_PLUGIN && spec.adminSession === true,
    ) ?? false;
  const adminAuth = adminEnabled()
    ? createAdminAuth({
        enabled: adminEnabled,
        config,
        operatorToken: () => config().tokens.operator?.reveal(),
        trustedProxies: options.trustedProxies ?? config().trustProxy,
        peerAddress: options.peerAddress,
        now: options.now,
      })
    : undefined;
  adminAuth?.protect(app);
  const plugins = cacheOptions?.plugins?.routes.length
    ? pluginRoutes(cacheOptions.plugins, {
        db,
        adminAuth,
        commandWritable: operatorCommands?.writable,
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
  // Admin route identity bypasses the shared cache even without an Authorization header.
  const cacheAdmission: MiddlewareHandler = async (c, next) => {
    if (
      adminAuth &&
      (c.req.path === "/admin" || c.req.path.startsWith("/admin/"))
    )
      return next();
    return cache.middleware(c, next);
  };
  app.use("*", catalogPolicyAdmission(config(), cacheOptions?.plugins));
  app.use("*", cacheAdmission);
  app.use("*", upstreamDisclosure);
  adminAuth?.mount(app);

  // Liveness: the process and its database connection. A pending schema is reported, not failed,
  // so Compose can start the worker that migrates.
  const readiness = releaseFactsReader(db);
  app.get("/healthz", async (c) => {
    const { up: healthy, generation } = await readiness.probe();
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
      {
        status: healthy ? "ok" : "down",
        db: healthy ? "ok" : "down",
        ...(healthy
          ? await readiness.facts(
              generation,
              schemaStatus?.state === "ready"
                ? schemaStatus.applied
                : undefined,
            )
          : apiError("db_down")),
      },
      healthy ? 200 : 503,
    );
  });

  if (schema) void prepareCmsZipFallback();

  // Only database and schema availability can leave the API unready.
  app.get("/readyz", async (c) => {
    const noStore = { "Cache-Control": "no-store" };
    const { up, generation } = await readiness.probe();
    if (!up)
      return c.json(
        { status: "not_ready", reason: "db_down", ...apiError("db_down") },
        503,
        noStore,
      );
    const schemaStatus: SchemaStatus = (await schema?.status()) ?? {
      state: "ready",
      pending: 0,
    };
    if (schemaStatus.state === "pending")
      return c.json(
        {
          status: "not_ready",
          reason: SCHEMA_NOT_READY,
          ...apiError(SCHEMA_NOT_READY),
          pending: schemaStatus.pending,
        },
        503,
        noStore,
      );
    if (schemaStatus.state === "unknown")
      return c.json(
        {
          status: "not_ready",
          reason: "schema_unknown",
          ...apiError("schema_unknown"),
        },
        503,
        noStore,
      );
    return c.json(
      {
        status: "ready",
        ...(await readiness.facts(generation, schemaStatus.applied)),
      },
      200,
      noStore,
    );
  });

  app.get("/v1/data-policy", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await servingPolicy(db));
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
        return c.json(apiError(error.code, error.field), 400);
      return c.json(apiError("data_availability_unavailable"), 503);
    }
  });

  app.route("/", createMcpHttp(db, { config: config() }));
  app.route(
    "/v1",
    nativeRoutes(db, { ...options, tpa: options.tpa ?? config().tpa }),
  );
  app.route("/", compatRoutes(db, options));
  plugins?.mount(app);

  app.notFound((c) => c.json(apiError("not_found"), 404));

  app.onError((error, c) => {
    if (error instanceof ReadError) {
      c.header("Cache-Control", "no-store");
      return c.json(
        apiErrorFrom(error.error),
        error.error.code === "not_loaded" ? 404 : 503,
      );
    }
    if (isQueryTimeout(error)) return queryTimeoutResponse(c);
    logInternalError(error);
    return c.json(apiError("internal_error"), 500);
  });
  if (telemetry) {
    for (const route of app.routes) {
      if (route.path.includes("*")) continue;
      if (route.path === "/admin" || route.path.startsWith("/admin/")) continue;
      const owner =
        cacheOptions?.plugins?.routes.find(
          ({ spec }) =>
            spec.method === route.method && spec.path === route.path,
        )?.plugin ?? "core";
      const id = `${route.method.toLowerCase()}.${route.path.slice(1).replace(/[^a-zA-Z0-9_:-]+/g, ".")}`;
      operations.set(
        `${route.method} ${route.path}`,
        telemetry.register("http", id, owner),
      );
    }
  }
  return app;
}
