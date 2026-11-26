import { apiError, apiErrorFrom } from "./errors.js";
import { lowestQuery, marketSummaryQuery, admitsHandyScope } from "./handy.js";
import {
  householdHandy,
  getMarketSummary,
  lowestPremiums,
  HandyDataChanged,
} from "../services/handy.js";
import { loadConfig } from "../config/index.js";
import { jsonBody, jsonBodyLimit, publicQuoteAdmission } from "./quotes.js";
import { logInternalError, queryTimeoutResponse } from "./error-log.js";
import {
  lookupZip,
  searchPlans,
  getPlan,
  benchmarkSilver,
  listCarriersNetworks,
} from "../services/catalog.js";
import { isQueryTimeout, ReadError } from "../services/errors.js";
import { providerRoutes } from "./providers.js";
import { drugRoutes } from "./drugs.js";
import { medicareRoutes } from "./medicare.js";
import { ichraBatchRoutes } from "./ichra-batch.js";
import type { TpaOptions } from "./ichra-batch.js";
import { ichraRoutes } from "./ichra.js";
import { Hono } from "hono";
import { boundedDatabase, DEADLINE_MS } from "../db/bounded.js";
import type { SqlSession } from "../db/database.js";
import * as v from "./validation.js";

import { personalizedOnly, quoteRoutes } from "./quotes.js";
import type { QuoteOptions } from "./quotes.js";

export type ApiOptions = QuoteOptions & { tpa?: TpaOptions };
export function nativeRoutes(db: SqlSession, options: ApiOptions) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof HandyDataChanged)
      return c.json(apiError("data_changed"), 503);
    if (error instanceof v.InputError) {
      return c.json(apiError(error.code, error.field), 400);
    } else if (error instanceof ReadError) {
      if (["not_loaded", "data_policy_unavailable"].includes(error.error.code))
        c.header("Cache-Control", "no-store");
      if (error.error.code === "data_policy_unavailable")
        return c.json(apiErrorFrom(error.error), 503);
      return c.json(
        apiErrorFrom(error.error),
        error.error.code === "unsupported_without_taxonomy" ? 422 : 404,
      );
    } else if (isQueryTimeout(error)) {
      return queryTimeoutResponse(c);
    } else {
      logInternalError(error);
      return c.json(apiError("internal_error"), 500);
    }
  });

  // One household admission: premium quotes, ICHRA checks and the benchmark share its limits.
  const household = personalizedOnly(options);

  if (options.lowestPremiums ?? loadConfig().lowestPremiums) {
    const scope =
      options.lowestPremiumsScope ?? loadConfig().lowestPremiumsScope;
    app.get("/lowest-premiums", ...publicQuoteAdmission(options), async (c) => {
      c.header("Cache-Control", "no-store");
      const deadline = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(DEADLINE_MS),
      ]);
      try {
        const input = lowestQuery(c.req.query());
        if (!admitsHandyScope(scope, input)) return v.fail("scope");
        const run = (session: SqlSession) =>
          lowestPremiums(boundedDatabase(session, deadline), input, {
            builtOnly: true,
            evidencePage: Number(c.req.query("evidence_page") ?? "1"),
          });
        return c.json(
          db.withRequest ? await db.withRequest(deadline, run) : await run(db),
        );
      } catch (error) {
        if (deadline.aborted) return c.json(apiError("request_deadline"), 504);
        throw error;
      }
    });
    app.get("/market-summary", ...publicQuoteAdmission(options), async (c) => {
      c.header("Cache-Control", "no-store");
      const deadline = AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(DEADLINE_MS),
      ]);
      try {
        const input = marketSummaryQuery(c.req.query());
        if (!admitsHandyScope(scope, input, true)) return v.fail("scope");
        const run = (session: SqlSession) =>
          getMarketSummary(boundedDatabase(session, deadline), input);
        return c.json(
          db.withRequest ? await db.withRequest(deadline, run) : await run(db),
        );
      } catch (error) {
        if (deadline.aborted) return c.json(apiError("request_deadline"), 504);
        throw error;
      }
    });
    for (const path of scope === "full"
      ? (["/lowest-premiums", "/market-summary"] as const)
      : []) {
      app.post(path, household, jsonBodyLimit, async (c) => {
        const deadline = AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(DEADLINE_MS),
        ]);
        try {
          const result = await householdHandy(
            boundedDatabase(db, deadline),
            await jsonBody(c),
            path === "/market-summary",
          );
          deadline.throwIfAborted();
          if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024)
            return c.json(apiError("result_too_large"), 422);
          return c.json(result);
        } catch (error) {
          if (deadline.aborted)
            return c.json(apiError("request_deadline"), 504);
          throw error;
        }
      });
    }
  }
  app.route("/", drugRoutes(db));
  app.route("/", providerRoutes(db));
  app.route("/", medicareRoutes(db, options));

  app.get("/zip-counties", async (c) =>
    c.json(await lookupZip(db, c.req.query("zip"))),
  );

  app.get("/plans", async (c) => c.json(await searchPlans(db, c.req.query())));

  app.get("/plans/:id", async (c) =>
    c.json(await getPlan(db, v.planId(c.req.param("id")).full, c.req.query())),
  );

  app.route("/", quoteRoutes(db, options, household));
  app.route("/", ichraRoutes(db, options, household));
  app.route("/", ichraBatchRoutes(db, options));
  app.use("/benchmark", household);
  app.get("/benchmark", async (c) => {
    const deadline = AbortSignal.any([
      c.req.raw.signal,
      AbortSignal.timeout(DEADLINE_MS),
    ]);
    try {
      return c.json(
        await benchmarkSilver(boundedDatabase(db, deadline), c.req.query()),
      );
    } catch (error) {
      if (deadline.aborted) return c.json(apiError("request_deadline"), 504);
      throw error;
    }
  });

  for (const kind of ["carriers", "networks"] as const) {
    app.get(`/${kind}`, async (c) => {
      return c.json(await listCarriersNetworks(db, kind, c.req.query()));
    });
  }
  return app;
}
