import {
  DRUG_IDENTITY_KIND,
  DRUG_NAME_SEARCH_KIND,
  IDENTITY_OPENING_REASONS,
} from "@openplans/plugin-sdk";
import type {
  CandidateList,
  IdentityAnswer,
  PassThroughSource,
  Question,
} from "@openplans/plugin-sdk";
import {
  ABSENT_STATUSES,
  DRUGS_PATH,
  DRUG_NAME_PATTERN,
  NAME_SEARCH_LIMITS,
  NLM_ACKNOWLEDGEMENT,
  RXCUI_PATH,
  RXCUI_PATTERN,
  RXNAV_BUDGET,
  RXNAV_CACHE,
  RXNAV_HOST,
  RXNAV_LIMITS,
  RXNAV_PUBLISHER,
  RXNAV_SOURCE,
  RXNAV_TERMS_URL,
  historyPath,
  propertiesPath,
} from "./constants.js";
import { mapHistory, mapNames, mapProperties } from "./response.js";
import type { RxnavConfirmation } from "./response.js";

/** What the source answers: a confirmation for an RxCUI, or candidates for a name. */
export type RxnavAnswer = RxnavConfirmation | CandidateList;
const KINDS = [DRUG_IDENTITY_KIND, DRUG_NAME_SEARCH_KIND] as const;
const isNameSearch = (kind: string) => kind === DRUG_NAME_SEARCH_KIND;
/** The questions a kind takes: an RxCUI for identity, a normalized name for name search. */
const fits = (kind: string, identity: string) =>
  (isNameSearch(kind) ? DRUG_NAME_PATTERN : RXCUI_PATTERN).test(identity);

/** Each call asks about one question: one RxCUI, or one name. */
const onlyQuestion = (questions: Question[]) => {
  const [question] = questions;
  if (!question || questions.length !== 1)
    throw new Error("RxNav lookups take exactly one question");
  return question.identity;
};

/**
 * RxNav as the drug identity source, used only when no local RxNorm release is ACTIVE. Kind
 * `drug-identity` confirms that an RxCUI is a current, unsuppressed RxNorm concept: it asks
 * `properties.json` first and, for an RxCUI without current properties, `historystatus.json`.
 * Kind `drug-name-search` suggests current concepts for a drug name from `drugs.json?name=`;
 * the core labels them `passthrough` and they never confirm an RxCUI. Both kinds share one switch,
 * budget, pacing and evidence block. Answers stay in memory for 24 hours (1 hour when not
 * confirmed or nothing matched) and never reach the database.
 */
export function createRxnavIdentitySource(): PassThroughSource<
  Question,
  RxnavAnswer
> {
  return {
    kind: "passthrough",
    id: RXNAV_SOURCE,
    publisher: RXNAV_PUBLISHER,
    kinds: KINDS,
    manifest: {
      host: RXNAV_HOST,
      accessMode: "public",
      permittedPaths: [RXCUI_PATH, DRUGS_PATH],
    },
    cache: { ...RXNAV_CACHE },
    eligibility: {
      openingReasons: [
        ...new Set(KINDS.flatMap((kind) => IDENTITY_OPENING_REASONS[kind]!)),
      ],
      accepts: (question) =>
        KINDS.some((kind) => fits(kind, question.identity)),
    },
    question(kind, answer) {
      const asked = answer as IdentityAnswer;
      if (typeof asked.identity !== "string" || !fits(kind, asked.identity))
        return null;
      return { identity: asked.identity, year: asked.plan_year };
    },
    batch: { maxQuestionsPerCall: 1, maxCallsPerRequest: 1 },
    budget: {
      ...RXNAV_BUDGET,
      breaker: { ...RXNAV_BUDGET.breaker },
    },
    buildRequest: (
      questions,
      kind,
    ): { path: string; query: Record<string, string> } =>
      isNameSearch(kind)
        ? { path: DRUGS_PATH, query: { name: onlyQuestion(questions) } }
        : { path: propertiesPath(onlyQuestion(questions)), query: {} },
    mapResponse: (body, questions, kind) =>
      isNameSearch(kind)
        ? mapNames(body, questions)
        : mapProperties(body, questions),
    followUp: {
      // `mapNames` answers every name, so only an RxCUI ever gets here.
      buildRequest: (questions, kind) => {
        if (isNameSearch(kind))
          throw new Error("A name search has no follow-up lookup");
        return { path: historyPath(onlyQuestion(questions)), query: {} };
      },
      mapResponse: (body, questions) => mapHistory(body, questions),
    },
    absentStatuses: ABSENT_STATUSES,
    evidence: {
      key: RXNAV_SOURCE,
      source: NLM_ACKNOWLEDGEMENT,
      termsUrl: RXNAV_TERMS_URL,
      limits: (kind) =>
        isNameSearch(kind) ? NAME_SEARCH_LIMITS : RXNAV_LIMITS,
    },
  };
}
