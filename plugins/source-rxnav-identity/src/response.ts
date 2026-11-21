import { MAX_CANDIDATES } from "@openplans/plugin-sdk";
import type {
  CandidateList,
  DrugNameCandidate,
  Mapped,
  Question,
} from "@openplans/plugin-sdk";
import { NOT_SUPPRESSED } from "./constants.js";

/** What a confirmed lookup answers; the core builds the identity answer from it. */
export interface RxnavConfirmation {
  confirmed: true;
}
export type RxnavMapped = Mapped<Question, RxnavConfirmation>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * The named object in a response body. A `null` body is a 404 (`ABSENT_STATUSES`): the RxCUI has
 * no such record, like a 200 with `{}`.
 */
function record(body: unknown, field: string): Record<string, unknown> | null {
  if (body === null) return null;
  if (!isRecord(body)) throw new Error("RxNav response is not a JSON object");
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new Error(`RxNav ${field} is not an object`);
  return value;
}

/**
 * `properties.json`: `{ properties: { rxcui, name, tty, suppress, ... } }` for a concept in the
 * current release, and no `properties` (`{}`, or a 404) for an RxCUI that is not one. Only a current concept whose
 * suppress flag is `N` confirms. An RxCUI without properties gets no entry here, so the follow-up
 * asks `historystatus.json` about it.
 */
export function mapProperties(
  body: unknown,
  questions: Question[],
): RxnavMapped[] {
  const properties = record(body, "properties");
  if (!properties) return [];
  const rxcui = text(properties.rxcui);
  const suppress = text(properties.suppress);
  return questions
    .filter((question) => question.identity === rxcui)
    .map((question): RxnavMapped =>
      suppress === NOT_SUPPRESSED
        ? {
            question,
            outcome: "answer",
            answer: { confirmed: true },
            statement: `Current RxNorm concept (${text(properties.tty) || "unknown term type"})`,
          }
        : {
            question,
            outcome: "no_data",
            statement: `RxNorm concept is suppressed (suppress ${suppress || "missing"})`,
          },
    );
}

/** Remapped-to RxCUIs, when the history names any. */
function remappedTo(history: Record<string, unknown>): string[] {
  const derived = history.derivedConcepts;
  if (!isRecord(derived) || !Array.isArray(derived.remappedConcept)) return [];
  return derived.remappedConcept
    .map((concept: unknown) =>
      isRecord(concept) ? text(concept.remappedRxCui) : "",
    )
    .filter(Boolean);
}

/**
 * `historystatus.json` for an RxCUI that has no current properties. It never confirms: it says
 * why the RxCUI is not a current concept (`Remapped`, `Obsolete`, `Quantified`, `NotCurrent`,
 * `Unknown`), which stays in provenance.
 */
export function mapHistory(
  body: unknown,
  questions: Question[],
): RxnavMapped[] {
  const history = record(body, "rxcuiStatusHistory");
  const status = history
    ? text(isRecord(history.metaData) ? history.metaData.status : "")
    : "";
  const remapped = history ? remappedTo(history) : [];
  let statement = "No RxNorm history for this RxCUI";
  if (status)
    statement = `No current RxNorm properties; history status ${status}`;
  if (status && remapped.length)
    statement += `, remapped to ${remapped.join(", ")}`;
  return questions.map((question) => ({
    question,
    outcome: "no_data",
    statement,
  }));
}

export type RxnavNamesMapped = Mapped<Question, CandidateList>;

/** The current, unsuppressed concepts of one `conceptGroup`. */
function groupConcepts(group: unknown): DrugNameCandidate[] {
  if (!isRecord(group)) return [];
  const listed = group.conceptProperties;
  if (listed === undefined || listed === null) return [];
  if (!Array.isArray(listed))
    throw new Error("RxNav conceptProperties is not an array");
  return listed.flatMap((concept: unknown) => {
    if (!isRecord(concept) || text(concept.suppress) !== NOT_SUPPRESSED)
      return [];
    const rxcui = text(concept.rxcui);
    const name = text(concept.name);
    const tty = text(concept.tty) || text(group.tty);
    return rxcui && name && tty ? [{ rxcui, name, tty }] : [];
  });
}

/**
 * `drugs.json?name=`: `{ drugGroup: { conceptGroup: [{ tty, conceptProperties: [...] }] } }`.
 * Candidates keep RxNav's order, at most `MAX_CANDIDATES`. A name with no current concept is
 * `no_data`; either way the question gets an entry, so no follow-up runs.
 */
export function mapNames(
  body: unknown,
  questions: Question[],
): RxnavNamesMapped[] {
  const group = record(body, "drugGroup");
  const listed = group?.conceptGroup;
  if (listed !== undefined && listed !== null && !Array.isArray(listed))
    throw new Error("RxNav conceptGroup is not an array");
  const candidates = (Array.isArray(listed) ? listed : [])
    .flatMap(groupConcepts)
    .slice(0, MAX_CANDIDATES);
  return questions.map((question): RxnavNamesMapped =>
    candidates.length
      ? {
          question,
          outcome: "answer",
          answer: { candidates },
          statement: `RxNorm concepts whose names match (${candidates.length})`,
        }
      : {
          question,
          outcome: "no_data",
          statement: "No current RxNorm concept matches this name",
        },
  );
}
