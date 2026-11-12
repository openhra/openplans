import type { Mapped } from "@openplans/plugin-sdk";
import { endpointOf } from "./constants.js";
import type { CmsKind } from "./constants.js";

/** One question: a base plan id, an RxCUI or NPI, and a plan year. */
export interface CmsQuestion {
  kind: CmsKind;
  planId: string;
  identity: string;
  year: number;
}
/** What the API said about one plan and code, besides the coverage flag. */
export interface CmsStatement {
  coverage: string;
  generic_rxcui: string | null;
  accepting: string | null;
  addresses?: unknown[];
  /** The receipt id, on rows read back from storage. */
  sourced_slug?: string;
}

const coverageEnum = {
  drug: ["Covered", "NotCovered", "GenericCovered", "DataNotProvided"],
  provider: ["Covered", "NotCovered", "DataNotProvided"],
};
interface ParsedRow {
  plan_id: string;
  identity: string;
  coverage: string;
  generic_rxcui: string | null;
  accepting: string | null;
  addresses: unknown[];
}

/** Validates a `drugs/covered` or `providers/covered` body. Any invalid row rejects it all. */
export function parseBody(kind: string, body: unknown): ParsedRow[] {
  const parsed = body as { coverage?: unknown };
  if (!parsed || !Array.isArray(parsed.coverage))
    throw new Error("invalid body");
  const drug = kind === "drug";
  return parsed.coverage.map((value: unknown) => {
    const r = value as Record<string, unknown>;
    const identity = drug ? r.rxcui : r.npi;
    if (
      typeof r.plan_id !== "string" ||
      !/^\d{5}[A-Z]{2}\d{7}$/.test(r.plan_id) ||
      typeof identity !== "string" ||
      !(drug ? /^\d{1,20}$/ : /^\d{10}$/).test(identity) ||
      typeof r.coverage !== "string" ||
      !coverageEnum[drug ? "drug" : "provider"].includes(r.coverage)
    )
      throw new Error("invalid row");
    return {
      plan_id: r.plan_id,
      identity,
      coverage: r.coverage,
      generic_rxcui:
        typeof r.generic_rxcui === "string" &&
        /^\d{1,20}$/.test(r.generic_rxcui)
          ? r.generic_rxcui
          : null,
      accepting:
        typeof r.accepting === "string" ? r.accepting.slice(0, 40) : null,
      addresses: Array.isArray(r.addresses) ? r.addresses.slice(0, 20) : [],
    };
  });
}

/**
 * One call for a plans x codes rectangle. The plans keep the batch's order; the codes keep the
 * order of the first plan's questions.
 */
export function buildRequest(questions: CmsQuestion[], kind: string) {
  const first = questions[0]!;
  const plans = [...new Set(questions.map((q) => q.planId))];
  const ids = [
    ...new Set(
      questions.filter((q) => q.planId === first.planId).map((q) => q.identity),
    ),
  ];
  return {
    path: `/api/v1/${endpointOf(kind)}`,
    query: {
      year: String(first.year),
      [kind === "drug" ? "drugs" : "providerids"]: ids.join(","),
      planids: plans.join(","),
    },
  };
}

/**
 * Every row of the body, in order. `NotCovered` is a negative: CMS also says it for codes it
 * cannot resolve, so it is served only for identities known locally. `DataNotProvided` is no data.
 */
export function mapResponse(
  body: unknown,
  questions: CmsQuestion[],
  kind: string,
): Mapped<CmsQuestion, CmsStatement>[] {
  const year = questions[0]!.year;
  return parseBody(kind, body).map((row, index) => {
    const question: CmsQuestion = {
      kind: kind as CmsKind,
      planId: row.plan_id,
      identity: row.identity,
      year,
    };
    const answer: CmsStatement = {
      coverage: row.coverage,
      generic_rxcui: row.generic_rxcui,
      accepting: row.accepting,
      addresses: row.addresses,
    };
    const sourceRow = index + 1;
    if (row.coverage === "DataNotProvided")
      return {
        question,
        outcome: "no_data",
        statement: row.coverage,
        answer,
        sourceRow,
      };
    return {
      question,
      outcome: "answer",
      answer,
      statement: row.coverage,
      negative: row.coverage === "NotCovered",
      sourceRow,
    };
  });
}
