// Synthetic pass-through plugin for the cache-level tests. The host, the answers and the terms
// are synthetic; the test's injected transport serves them. No real publisher is involved.
import { PASSTHROUGH_OPENING_REASONS } from "@openplans/plugin-sdk";
import { z } from "zod";

export const HOST = "answers.synthetic.test";

/**
 * One drug pass-through source. `options.level` sets the declared cache level (default `none`);
 * a `stored` declaration names the record policies the test inserts. With `coreEvidence` the
 * source has no `serve` hook, so answers carry the core's default evidence block.
 */
export function syntheticSource(level = "none", { coreEvidence = false } = {}) {
  const source = {
    kind: "passthrough",
    id: `synthetic-${level}`,
    publisher: "Synthetic publisher",
    kinds: ["drug"],
    manifest: {
      host: HOST,
      accessMode: "public",
      permittedPaths: ["/answers"],
    },
    cache: {
      level,
      ttl: "10 minutes",
      negativeTtl: "1 minute",
      ...(level === "stored"
        ? {
            recordPolicy: {
              name: "synthetic_answer",
              noDataName: "synthetic_no_data",
            },
          }
        : {}),
    },
    eligibility: {
      openingReasons: PASSTHROUGH_OPENING_REASONS,
      years: [2026],
      accepts: (question) => /^\d{1,10}$/.test(question.identity),
    },
    question: (_kind, answer) => ({
      planId: answer.requested_plan_id ?? answer.plan_id,
      identity: answer.rxcui ?? answer.code,
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
    // Its own evidence block, the shape the earlier tests read.
    serve: (_kind, answer, result) => ({
      ...answer,
      ...(result.outcome === "answer" ? result.answer : {}),
      reason:
        result.outcome === "answer" ? null : "passthrough_data_not_provided",
      synthetic_passthrough: {
        source_id: `synthetic-${level}`,
        level: result.level,
        served_from: result.servedFrom,
        snapshot_id: result.snapshotId,
        statement: result.statement,
      },
    }),
  };
  if (coreEvidence) delete source.serve;
  return source;
}

export default {
  manifest: {
    name: "@synthetic/passthrough",
    version: "0.0.1",
    apiVersion: "0.1",
    kinds: ["sources", "routes"],
    capabilities: { network: [HOST] },
    options: z
      .strictObject({
        level: z.enum(["none", "request", "memory", "stored"]).default("none"),
        coreEvidence: z.boolean().default(false),
      })
      .prefault({}),
  },
  setup(ctx) {
    const { level, coreEvidence } = ctx.options;
    ctx.sources.add(syntheticSource(level, { coreEvidence }));
    // A cached public route that answers one drug-coverage pair through the source. The local
    // answer is the one loaded files give before any source has an answer: unknown, not sourced.
    ctx.routes.add({
      method: "GET",
      path: "/synthetic/passthrough/drug",
      exposure: "public",
      contentType: "application/json",
      cache: { ttlSeconds: 60 },
      handler: async (c) => {
        const answer = {
          status: "unknown",
          reason: "source_set_not_available",
          requested_plan_id: c.req.query("plan"),
          rxcui: c.req.query("rxcui"),
          plan_year: 2026,
        };
        // The API host's request scope: read-only, plus the writer scoped to this plugin's own
        // source. A host that hands plugins a database at setup keeps working.
        const [out] = await ctx.sources.passThrough.apply("drug", [answer], {
          reader: c.get("pluginDb") ?? ctx.db.reader,
          writer: c.get("pluginPassThroughWriter") ?? ctx.db.writer,
        });
        return c.json(out);
      },
    });
  },
};
