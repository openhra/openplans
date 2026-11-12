import {
  CMS_API_SOURCE,
  OPENING_REASONS,
} from "@openplans/source-cms-marketplace-api";
import type { CmsApiAvailability } from "@openplans/source-cms-marketplace-api";
import type { SqlSession } from "../../db/database.js";
import type { DrugCoverage } from "../../domain/drugs/index.js";
import type { ProviderParticipation } from "../../domain/providers/index.js";
import { cmsFallbackEnabled } from "../../fetch/index.js";
import {
  passThrough,
  passThroughSourceIds,
  resetPassThrough,
} from "../../plugins/sources/passthrough.js";
import type { HostPassThroughScope } from "../../plugins/sources/passthrough.js";

/**
 * Host side of the CMS Marketplace API fallback, off unless `OPENPLANS_CMS_FALLBACK=on`. The
 * source itself is `@openplans/source-cms-marketplace-api`, which the core plugin registers
 * while the switch is on; the pass-through core (`ctx.sources.passThrough`) runs it. This
 * module builds the per-request scope and keeps the names the routes and services use.
 */
export { CMS_API_SOURCE, OPENING_REASONS };
export type {
  CmsApiAvailability,
  CmsApiEvidence,
} from "@openplans/source-cms-marketplace-api";
export type CmsKind = "drug" | "provider";

/**
 * One per inbound request. Without `writer` (read-only request scopes such as MCP tools) only
 * rows absorbed earlier are served: no live call, no write.
 */
export type CmsFallbackContext = HostPassThroughScope;

/** Live CMS calls per inbound request while the fallback is on, shared by both kinds. */
export const CMS_CALLS_PER_REQUEST = 2;

/**
 * The request's pass-through scope. Each source has its own switch: the CMS fallback is on with
 * `OPENPLANS_CMS_FALLBACK=on`, a plugin's source when its plugin is configured. Without either
 * there is no scope and answers stay as the loaded files gave them. Each source spends its own
 * allowance: the CMS source `CMS_CALLS_PER_REQUEST`, a plugin source its `maxCallsPerRequest`.
 */
export function cmsFallbackContext(
  reader: SqlSession,
  writer: SqlSession | undefined,
  overrides: Partial<CmsFallbackContext> = {},
): CmsFallbackContext | undefined {
  if (cmsFallbackEnabled())
    return {
      reader,
      writer,
      allowances: { [CMS_API_SOURCE]: CMS_CALLS_PER_REQUEST },
      ...overrides,
    };
  if (!passThroughSourceIds().length) return undefined;
  return { reader, writer, ...overrides };
}

/**
 * Applies the fallback to answers already computed from loaded files. Answers that are not
 * `unknown` with an opening reason come back unchanged.
 */
export async function applyCmsFallback<
  T extends DrugCoverage | ProviderParticipation,
>(kind: CmsKind, answers: T[], context: CmsFallbackContext | undefined) {
  if (!context || !cmsFallbackEnabled()) return answers;
  return passThrough.apply(kind, answers, context);
}

/** Test hook: forgets every client's count. */
export function resetCmsClientCounts(): void {
  resetPassThrough();
}

/**
 * Stored API answers per issuer, state and plan year, keyed `issuer|state|year`. Null unless
 * the fallback is on. It returns counts and a time, never plan ids, codes or key material.
 */
export async function cmsApiAvailability(db: SqlSession): Promise<{
  configured: boolean;
  byIssuer: Map<string, CmsApiAvailability>;
} | null> {
  return (await passThrough.availability(CMS_API_SOURCE, db)) as {
    configured: boolean;
    byIssuer: Map<string, CmsApiAvailability>;
  } | null;
}
