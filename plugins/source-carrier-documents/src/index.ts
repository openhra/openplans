import packageJson from "../package.json" with { type: "json" };
import type { OpenPlansPlugin } from "@openplans/plugin-sdk";
import { z } from "zod";
import { DOCUMENT_HOSTS } from "./constants.js";
import { DEFAULT_EXTRACTOR, pythonExtractor } from "./extract.js";
import { identityJoinCommand } from "./command.js";
import { createFormularySource } from "./source.js";
import { DEFAULT_SBC_EXTRACTOR, pythonSbcExtractor } from "./sbc-extract.js";
import { createSbcSource } from "./sbc-source.js";

export { formularyArgs } from "./args.js";
export type { FormularyRun, IssuerScope } from "./args.js";
export {
  admittedTiers,
  documentRefusal,
  stagedFromExtracted,
} from "./checks.js";
export type { StagedDocument } from "./checks.js";
export {
  COVERAGE_UNKNOWN_REASON,
  DOCUMENT_HOSTS,
  FEED_KIND,
  IDENTITY_JOIN_ARGV,
  IDENTITY_JOIN_DEFAULT_LOOKUPS,
  IDENTITY_CONFIRMATION_MAX_AGE_DAYS,
  IDENTITY_JOIN_PACING_MS,
  IDENTITY_REFRESH_AGE_DAYS,
  IDENTITY_REUSE_DAYS,
  FORMULARY_ARGV,
  FORMULARY_USAGE,
  MAX_UNDEFINED_TIER_SHARE,
  REFUSAL,
  SBC_ARGV,
  SBC_FEED_KIND,
  SBC_REFUSAL,
  SBC_SOURCE_ID,
  SBC_SOURCE_LABEL,
  SBC_UNKNOWN_REASON,
  SERVED_CONFIDENCE,
  SOURCE_ID,
  UNKNOWN_REASON,
} from "./constants.js";
export { fileHiosIds, selectSbcLinks } from "./sbc-discover.js";
export type { SbcLink } from "./sbc-discover.js";
export {
  DEFAULT_SBC_EXTRACTOR,
  extractedSbcSchema,
  pythonSbcExtractor,
} from "./sbc-extract.js";
export type { ExtractedSbc, SbcExtractor } from "./sbc-extract.js";
export { mapSbcPlan, resolveSharedSbcClaims } from "./sbc-match.js";
export type { CatalogVariant, SbcPlanLink } from "./sbc-match.js";
export {
  answerAmounts,
  checkItem,
  PUF_BENEFIT,
  PUF_QUESTION,
  pufCost,
  sbcCost,
} from "./sbc-compare.js";
export type { CheckStatus, Cost, PufCostSharing } from "./sbc-compare.js";
export { createSbcSource, sbcRefusal } from "./sbc-source.js";
export type { SbcDocumentFacts, SbcSourceOptions } from "./sbc-source.js";
export { sbcCostSharingEvidence } from "./sbc-evidence.js";
export type {
  SbcCitation,
  SbcCostSharingAnswer,
  SbcItemAnswer,
} from "./sbc-evidence.js";
export { selectFormularyLinks, stateHints } from "./discover.js";
export type { FormularyLink } from "./discover.js";
export { drugNameKey, formularyDocumentEvidence } from "./evidence.js";
export type {
  FormularyDocumentAnswer,
  FormularyDocumentText,
} from "./evidence.js";
export {
  DEFAULT_EXTRACTOR,
  extractedFormularySchema,
  pythonExtractor,
  statedTierSchema,
} from "./extract.js";
export type {
  ExtractedFormulary,
  FormularyExtractor,
  StatedTier,
} from "./extract.js";
export {
  ADD_ON_JOINS,
  ADD_ONS,
  baseNameKey,
  matchCoverPlans,
  nameKey,
  resolveSharedClaims,
} from "./match.js";
export type { CatalogPlan, PlanLink, PlanLinkStatus } from "./match.js";
export { createFormularySource } from "./source.js";
export { identityJoinCommand, joinArgs } from "./command.js";
export { formularyDrugCoverage } from "./coverage.js";
export type {
  FormularyCoverageAnswer,
  FormularyCoverageEvidence,
} from "./coverage.js";
export {
  IDENTITY_UNRESOLVED,
  TERM_TYPE,
  matchCandidates,
  readPrintedName,
  readStrengths,
} from "./identity.js";
export type { CandidateMatch, NameReading, ReadName } from "./identity.js";
export {
  IDENTITY_TABLE,
  JOIN_IDENTITY_SOURCE,
  joinFormularyIdentities,
} from "./join.js";
export type { JoinOptions, JoinSummary } from "./join.js";
export {
  activeRxnormRelease,
  passThroughIdentityLookup,
  PASSTHROUGH_IDENTITY_SOURCE,
  RELEASE_IDENTITY_SOURCE,
  releaseIdentityLookup,
} from "./lookup.js";
export type { Confirmation, IdentityLookup, NameSearch } from "./lookup.js";
export type { FormularySourceOptions } from "./source.js";

const absolutePath = z.string().regex(/^\//).max(1024);
const options = z
  .strictObject({
    /** `formulary.py` from `src/ingest/carrier-documents`; defaults to the source checkout's copy. */
    extractor: absolutePath.optional(),
    /** `sbc.py` from `src/ingest/carrier-documents`; defaults to the source checkout's copy. */
    sbcExtractor: absolutePath.optional(),
    python: z.string().min(1).max(1024).default("python3"),
    /** Poppler's `pdftotext`; otherwise it is found on PATH. */
    pdftotext: absolutePath.optional(),
    /**
     * The RxCUI join switch. `off` (the default): the join command asks nothing, no row is joined,
     * and rows stay text evidence. `on`: the ingest-time join may run and joined rows may answer
     * drug coverage.
     */
    identityJoin: z.enum(["off", "on"]).default("off"),
  })
  .prefault({});

const plugin: OpenPlansPlugin = {
  manifest: {
    name: "@openplans/source-carrier-documents",
    version: packageJson.version,
    apiVersion: "0.2",
    kinds: ["sources", "workerCommands"],
    tablePrefix: "carrierdoc",
    capabilities: { network: [...DOCUMENT_HOSTS], writes: ["staging"] },
    options,
  },
  setup(ctx) {
    const settings = ctx.options as z.infer<typeof options>;
    ctx.sources.add(
      createFormularySource({
        extractor: pythonExtractor(
          settings.extractor ?? DEFAULT_EXTRACTOR,
          settings.python,
          settings.pdftotext,
        ),
        identityJoin: settings.identityJoin === "on",
      }),
    );
    ctx.sources.add(
      createSbcSource({
        extractor: pythonSbcExtractor(
          settings.sbcExtractor ?? DEFAULT_SBC_EXTRACTOR,
          settings.python,
          settings.pdftotext,
        ),
      }),
    );
    ctx.workerCommands.add(
      identityJoinCommand(
        ctx.sources.passThrough,
        settings.identityJoin === "on",
      ),
    );
  },
};
export default plugin;
