// Synthetic plugin for the scoped route writer: one pass-through source with its own attempt
// table, and routes that use the writer the API host gives this plugin's routes. The host, the
// answers and the terms are synthetic; the test's injected transport serves them.
import { PASSTHROUGH_OPENING_REASONS } from "@openplans/plugin-sdk";
import { z } from "zod";

export const HOST = "answers.synthetic.test";
export const SOURCE = "synthetic-route-writer";

/**
 * Statements a route tries directly on its writer. Only `own_insert` and `read` may run: the
 * others write a core table, write outside the plugin's tables or are not plain statements.
 */
export const STATEMENTS = {
  own_insert: "INSERT INTO synthetic_route_attempt(outcome) VALUES ('direct')",
  read: "SELECT count(*)::int AS n FROM snapshot",
  core_attempt:
    "INSERT INTO passthrough_attempt(source_id,kind,level,plan_year,pairs,outcome) VALUES ('synthetic-route-writer','drug','none',2026,1,'answered')",
  core_delete: "DELETE FROM snapshot WHERE false",
  cms_budget: "UPDATE cms_api_budget SET max_daily_requests=1",
  quoted_core: 'UPDATE "cms_api_budget" SET max_daily_requests=1',
  schema_core: "UPDATE public.cms_api_budget SET max_daily_requests=1",
  ddl: "CREATE TABLE synthetic_route_extra(x int)",
  drop: "DROP TABLE synthetic_route_attempt",
  truncate: "TRUNCATE synthetic_route_attempt",
  several:
    "INSERT INTO synthetic_route_attempt(outcome) VALUES ('a'); DELETE FROM snapshot WHERE false",
  comment_split:
    "INSERT INTO synthetic_route_attempt(outcome) VALUES ('a')\n-- note\n; DELETE FROM snapshot WHERE false",
  cte: "WITH gone AS (DELETE FROM snapshot WHERE false RETURNING 1) INSERT INTO synthetic_route_attempt(outcome) SELECT 'x' FROM gone",
  select_into: "SELECT * INTO synthetic_route_copy FROM snapshot",
  setting: "SELECT set_config('statement_timeout','0',false)",
  session: "SET statement_timeout = 0",
};

function source(hostile) {
  return {
    kind: "passthrough",
    id: SOURCE,
    publisher: "Synthetic publisher",
    kinds: ["drug"],
    manifest: {
      host: HOST,
      accessMode: "public",
      permittedPaths: ["/answers"],
    },
    cache: { level: "none" },
    eligibility: {
      openingReasons: PASSTHROUGH_OPENING_REASONS,
      years: [2026],
      accepts: (question) => /^\d{1,10}$/.test(question.identity),
    },
    question: (_kind, answer) => ({
      planId: answer.requested_plan_id,
      identity: answer.rxcui,
      year: answer.plan_year,
    }),
    batch: { maxQuestionsPerCall: 10, maxCallsPerRequest: 2 },
    budget: {
      dailyMax: 50,
      minIntervalMs: 0,
      clientShare: 1,
      breaker: { failures: 2, windowMs: 300_000, pauseMs: 900_000 },
    },
    buildRequest: (questions) => ({
      path: "/answers",
      query: {
        year: String(questions[0].year),
        q: questions.map((q) => `${q.planId}:${q.identity}`).join(","),
      },
    }),
    mapResponse: (body) => body.answers,
    evidence: {
      source: "Synthetic publisher",
      termsUrl: `https://${HOST}/terms`,
    },
    storage: {
      readAbsorbed: async () => [],
      writeAbsorbed: async () => {},
      recordConflict: async () => {},
      excludedTables: ["synthetic_route_attempt"],
      // A hostile source claims a core table as its own; the claim never counts.
      tables: hostile
        ? ["synthetic_route_attempt", "cms_api_budget"]
        : ["synthetic_route_attempt"],
      async recordAttempt(db, attempt) {
        if (hostile)
          await db.query("UPDATE cms_api_budget SET max_daily_requests=1");
        await db.query(
          "INSERT INTO synthetic_route_attempt(outcome) VALUES ($1)",
          [attempt.outcome],
        );
      },
    },
  };
}

export default {
  manifest: {
    name: "@synthetic/route-writer",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["sources", "routes"],
    capabilities: { network: [HOST] },
    options: z
      .strictObject({ hostile: z.boolean().default(false) })
      .prefault({}),
  },
  setup(ctx) {
    ctx.sources.add(source(ctx.options.hostile));
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/route-writer/drug",
      exposure: "public",
      contentType: "application/json",
      handler: async (c) => {
        const answer = {
          status: "unknown",
          reason: "source_set_not_available",
          requested_plan_id: c.req.query("plan"),
          rxcui: c.req.query("rxcui"),
          plan_year: 2026,
        };
        const [out] = await ctx.sources.passThrough.apply("drug", [answer], {
          reader: c.get("pluginDb"),
          writer: c.get("pluginPassThroughWriter"),
        });
        return c.json(out);
      },
    });
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/route-writer/try",
      exposure: "public",
      contentType: "application/json",
      handler: async (c) => {
        const writer = c.get("pluginPassThroughWriter");
        if (!writer) return c.json({ result: "missing" });
        try {
          await writer.query(STATEMENTS[c.req.query("statement")]);
          return c.json({ result: "ran" });
        } catch (error) {
          return c.json({
            result:
              error?.code === "passthrough_write_refused"
                ? "refused"
                : "failed",
          });
        }
      },
    });
  },
};
