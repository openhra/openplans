import { PASSTHROUGH_OPENING_REASONS } from "@openplans/plugin-sdk";
import type {
  PassThroughAnswer,
  PassThroughApi,
  PassThroughScope,
} from "@openplans/plugin-sdk";
import { InputError } from "../api/validation.js";
import { currentRegistries } from "../plugins/registries.js";
import { passThroughSourcesOf } from "../plugins/sources/passthrough.js";
import {
  declineInScope,
  declinedInScope,
  recordUpstream,
} from "../plugins/upstream-scope.js";

export {
  declinedInScope,
  recordUpstream,
  upstreamSources,
  withUpstreamDisclosure,
} from "../plugins/upstream-scope.js";

/**
 * Upstream disclosure (provrxplan 4.5, D-PRX-5). Every answer that a pass-through source filled
 * names that source in the `x-openplans-upstream` response header (MCP: result `_meta`), and a
 * caller can keep a question local with `passthrough=off`. The scope itself is in
 * `plugins/upstream-scope.ts`; the pass-through core records every live call it starts there.
 */
export const UPSTREAM_HEADER = "x-openplans-upstream";
export const UPSTREAM_META_KEY = "openplans/upstream";
/** The request parameter, body field and MCP argument that turns pass-through off. */
export const PASSTHROUGH_FIELD = "passthrough";
/** The reason an eligible `unknown` answer keeps when the caller declined pass-through. */
export const PASSTHROUGH_DECLINED = "passthrough_declined";

/**
 * Reads `passthrough` from a query string, body or tool input: absent or `on` keeps pass-through,
 * `off` declines it. Anything else is an input error on that field.
 */
export function passThroughDeclined(value: unknown): boolean {
  if (value === undefined || value === "on") return false;
  if (value === "off") return true;
  throw new InputError(PASSTHROUGH_FIELD);
}

/** Applies a body's `passthrough` field to the current request scope. */
export function declineFromBody(body: unknown): void {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  if (
    !passThroughDeclined((body as Record<string, unknown>)[PASSTHROUGH_FIELD])
  )
    return;
  declineInScope();
}

/**
 * The source ids on an answer's pass-through evidence blocks. The core's block carries
 * `source_id`; a source with its own `serve` may name itself `sourced_by`. Both carry
 * `served_from`, which answers from loaded files never have. A drug answer can carry two: the
 * coverage source's and the identity source's (`rxnorm_identity`).
 */
function evidenceSources(answer: object): string[] {
  const ids: string[] = [];
  for (const value of Object.values(answer)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const block = value as Record<string, unknown>;
    if (typeof block.served_from !== "string") continue;
    const id = block.source_id ?? block.sourced_by;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

/** Eligible `unknown` answers keep their local status with `passthrough_declined`. */
function declineAnswers<T extends PassThroughAnswer>(
  kind: string,
  answers: T[],
): T[] {
  const sources = passThroughSourcesOf(currentRegistries().sources).filter(
    (source) => source.kinds.includes(kind),
  );
  let changed = false;
  const out = answers.map((answer) => {
    const reason = answer.reason ?? "";
    if (
      answer.status !== "unknown" ||
      !PASSTHROUGH_OPENING_REASONS.includes(reason)
    )
      return answer;
    const eligible = sources.some((source) => {
      if (!source.eligibility.openingReasons.includes(reason)) return false;
      try {
        return source.question(kind, answer) !== null;
      } catch {
        return false;
      }
    });
    if (!eligible) return answer;
    changed = true;
    return { ...answer, reason: PASSTHROUGH_DECLINED };
  });
  return changed ? out : answers;
}

/**
 * The host's single entry to the pass-through core. Callers pass the core they import, so a test
 * that plants a core mutant in their imports reaches it here too. Without a scope the answers stay
 * as the loaded files gave them. When the caller declined pass-through, nothing is asked upstream.
 * Otherwise every source whose evidence lands on an answer is recorded for disclosure; the core
 * itself records each live call it starts, including ones that fail or that the upstream refuses.
 */
export async function consultPassThrough<T extends PassThroughAnswer>(
  core: Pick<PassThroughApi, "apply">,
  kind: string,
  answers: T[],
  scope: PassThroughScope | undefined,
): Promise<T[]> {
  if (!scope) return answers;
  if (declinedInScope()) return declineAnswers(kind, answers);
  const filled = await core.apply(kind, answers, scope);
  if (filled === answers) return filled;
  const ids = new Set<string>();
  filled.forEach((answer, index) => {
    if (answer === answers[index]) return;
    for (const id of evidenceSources(answer)) ids.add(id);
  });
  recordUpstream(ids);
  return filled;
}
