// Synthetic drug identity plugin for the identity-stage tests. The host, the terms and every
// answer are synthetic; the test's injected transport serves them. No real publisher is involved.
import {
  DRUG_IDENTITY_KIND,
  IDENTITY_OPENING_REASONS,
} from "@openplans/plugin-sdk";
import { z } from "zod";

export const IDENTITY_HOST = "identity.synthetic.test";
export const IDENTITY_PATH = "/identity";

/**
 * Reads the synthetic body `{ concepts: [{ rxcui, status }] }`. Status `active` confirms the
 * RxCUI; any other status, or a missing entry, is no data.
 */
export function mapConcepts(body, questions) {
  const statuses = new Map(
    (body?.concepts ?? []).map((concept) => [concept.rxcui, concept.status]),
  );
  return questions.map((question) =>
    statuses.get(question.identity) === "active"
      ? {
          question,
          outcome: "answer",
          answer: { confirmed: true },
          statement: "Active concept",
        }
      : { question, outcome: "no_data", statement: "No active concept" },
  );
}

/** One synthetic drug identity source declared at `level` (default `memory`). */
export function syntheticIdentitySource(level = "memory", overrides = {}) {
  return {
    kind: "passthrough",
    id: `synthetic-identity-${level}`,
    publisher: "Synthetic terminology publisher",
    kinds: [DRUG_IDENTITY_KIND],
    manifest: {
      host: IDENTITY_HOST,
      accessMode: "public",
      permittedPaths: [IDENTITY_PATH],
    },
    cache: { level, ttl: "24 hours", negativeTtl: "1 hour" },
    eligibility: {
      openingReasons: IDENTITY_OPENING_REASONS[DRUG_IDENTITY_KIND],
      accepts: (question) => /^\d{1,10}$/.test(question.identity),
    },
    question: (_kind, answer) => ({
      identity: answer.identity,
      year: answer.plan_year,
    }),
    batch: { maxQuestionsPerCall: 20, maxCallsPerRequest: 2 },
    budget: {
      dailyMax: 50,
      minIntervalMs: 0,
      clientShare: 1,
      breaker: { failures: 2, windowMs: 300_000, pauseMs: 900_000 },
    },
    buildRequest: (questions) => ({
      path: IDENTITY_PATH,
      query: { rxcuis: questions.map((q) => q.identity).join(",") },
    }),
    mapResponse: mapConcepts,
    evidence: {
      key: "identity",
      source: "Synthetic terminology publisher",
      termsUrl: `https://${IDENTITY_HOST}/terms`,
    },
    ...overrides,
  };
}

export default {
  manifest: {
    name: "@synthetic/drug-identity",
    version: "0.0.1",
    apiVersion: "0.2",
    kinds: ["sources"],
    capabilities: { network: [IDENTITY_HOST] },
    options: z
      .strictObject({
        level: z
          .enum(["none", "request", "memory", "stored"])
          .default("memory"),
      })
      .prefault({}),
  },
  setup(ctx) {
    ctx.sources.add(syntheticIdentitySource(ctx.options.level));
  },
};
