import { readFile } from "node:fs/promises";
import type {
  FeedContext,
  FeedSource,
  SqlSession,
} from "@openplans/plugin-sdk";
import { formularyArgs } from "./args.js";
import type { FormularyRun, IssuerScope } from "./args.js";
import {
  admittedTiers,
  documentRefusal,
  stagedFromExtracted,
} from "./checks.js";
import {
  DISCOVERY_MAX_BYTES,
  DOCUMENT_HOSTS,
  DOCUMENT_MAX_BYTES,
  FORMULARY_ARGV,
  FORMULARY_USAGE,
  MAX_DOCUMENTS,
  PUBLISHER,
  REFUSAL,
  SOURCE_ID,
} from "./constants.js";
import { selectFormularyLinks } from "./discover.js";
import type { FormularyLink } from "./discover.js";
import type { ExtractedFormulary, FormularyExtractor } from "./extract.js";
import { formularyDrugCoverage } from "./coverage.js";
import { matchCoverPlans, resolveSharedClaims } from "./match.js";
import type { CatalogPlan, PlanLink } from "./match.js";
import {
  catalogPlans,
  clearEarlier,
  DOCUMENT_TABLE,
  LINK_TABLE,
  recordAvailability,
  ROW_TABLE,
  writeDocument,
  writeLinks,
} from "./stage.js";

export interface FormularySourceOptions {
  extractor: FormularyExtractor;
  /** The document hosts; tests use synthetic ones. Defaults to the reviewed `DOCUMENT_HOSTS`. */
  hosts?: readonly string[];
  /**
   * The plugin's `identityJoin` switch. On: joined rows answer the core's drug coverage questions
   * (`drugCoverage`). Off (the default): every such question is `unknown` (`identity_join_off`).
   */
  identityJoin?: boolean;
}

interface StagedDocument {
  snapshotId: string;
  link: FormularyLink;
  extracted: ExtractedFormulary;
}

interface CoverMatch {
  key: string;
  planYear: number;
  issuer: IssuerScope;
  links: PlanLink[];
}

const scopeKey = (issuer: IssuerScope, year: number) =>
  `${issuer.issuerId}:${year}`;

/** Match every staged cover against the catalogs of the run issuers in the document's states. */
async function matchCovers(
  tx: SqlSession,
  run: FormularyRun,
  documents: readonly StagedDocument[],
  catalogs: Map<string, CatalogPlan[]>,
): Promise<CoverMatch[]> {
  const catalog = async (issuer: IssuerScope, year: number) => {
    const key = scopeKey(issuer, year);
    if (!catalogs.has(key))
      catalogs.set(key, await catalogPlans(tx, issuer, year));
    return catalogs.get(key)!;
  };
  const matches: CoverMatch[] = [];
  for (const { snapshotId, link, extracted } of documents) {
    const planYear = extracted.cover.plan_year;
    // A document without a readable year in the run is refused by validate; it attaches nothing.
    if (planYear === null || !run.years.includes(planYear)) continue;
    for (const issuer of run.issuers.filter((i) =>
      link.states.includes(i.state),
    ))
      matches.push({
        key: snapshotId,
        planYear,
        issuer,
        links: matchCoverPlans(
          extracted.cover.plan_names,
          await catalog(issuer, planYear),
        ),
      });
  }
  resolveSharedClaims(matches);
  return matches;
}

/** The staged documents of this run, read back as `validate` checks them. */
async function stagedDocuments(tx: SqlSession, snapshotIds: readonly string[]) {
  const { rows } = await tx.query<{
    url: string;
    plan_year: number | null;
    legend_tiers: Record<string, string>;
    stated_tiers: Record<string, unknown>;
    ql_flag_rows: number;
    ql_text_rows: number;
    rows: number;
    tiers: number[] | null;
    undefined_rows: number;
  }>(
    `SELECT d.url, d.plan_year, d.legend_tiers, d.stated_tiers, d.ql_flag_rows, d.ql_text_rows,
       (SELECT count(*)::int FROM ${ROW_TABLE} r WHERE r.snapshot_id = d.snapshot_id) AS rows,
       (SELECT array_agg(DISTINCT r.tier) FROM ${ROW_TABLE} r
        WHERE r.snapshot_id = d.snapshot_id AND r.unknown_reason IS NULL) AS tiers,
       (SELECT count(*)::int FROM ${ROW_TABLE} r
        WHERE r.snapshot_id = d.snapshot_id AND r.unknown_reason IS NOT NULL) AS undefined_rows
     FROM ${DOCUMENT_TABLE} d WHERE d.snapshot_id = ANY($1::text[]) ORDER BY d.url`,
    [snapshotIds],
  );
  return rows.map((row) => ({
    url: row.url,
    staged: {
      rows: row.rows,
      legendTiers: Object.keys(row.legend_tiers).map(Number),
      statedTiers: row.stated_tiers,
      rowTiers: row.tiers ?? [],
      undefinedTierRows: row.undefined_rows,
      qlFlagRows: row.ql_flag_rows,
      qlTextRows: row.ql_text_rows,
      planYear: row.plan_year,
    },
  }));
}

/**
 * The formulary-PDF feed (kind `formulary-pdf`). `plan` reads the admitted discovery pages and
 * lists the formulary PDFs for the run's years and states; the core fetches them; `stage` runs the
 * extractor and writes every row with page, line, raw text, confidence and the document hash,
 * matches each cover's plan list to the catalog and records `formulary_document_status`;
 * `validate` refuses the run when any document fails its round trips.
 */
export function createFormularySource(
  options: FormularySourceOptions,
): FeedSource {
  const hosts = [...(options.hosts ?? DOCUMENT_HOSTS)];
  let run: FormularyRun | undefined;
  let planned = new Map<string, FormularyLink>();
  let staged: string[] = [];
  let refusals: { snapshotId: string; url: string; reasonCode: string }[] = [];

  const plan = async (ctx: FeedContext, args: unknown) => {
    run = args as FormularyRun;
    planned = new Map();
    staged = [];
    refusals = [];
    const states = [...new Set(run.issuers.map((issuer) => issuer.state))];
    for (const discovery of run.discovery) {
      const page = await ctx.fetch(discovery, {
        expectedContent: "binary",
        maxBytes: DISCOVERY_MAX_BYTES,
      });
      const body = await readFile(page.path, "utf8");
      for (const link of selectFormularyLinks(body, discovery, {
        years: run.years,
        states,
        hosts,
      }))
        planned.set(link.url, link);
    }
    if (planned.size > MAX_DOCUMENTS) throw new Error("too many documents");
    ctx.log({ code: "carrier_formulary_planned", documents: planned.size });
    return {
      files: [...planned.values()].map((link) => ({
        url: link.url,
        expectedContent: "binary" as const,
        maxBytes: DOCUMENT_MAX_BYTES,
      })),
      requireRows: [DOCUMENT_TABLE, ROW_TABLE],
    };
  };

  return {
    kind: "feed",
    id: SOURCE_ID,
    publisher: PUBLISHER,
    hosts,
    dataScope: {
      kind: "annual",
      domain: "individual",
      years: (args) => (args as FormularyRun).years,
    },
    command: {
      argv: FORMULARY_ARGV,
      usage: FORMULARY_USAGE,
      args: formularyArgs,
    },
    plan,
    drugCoverage: (db, question) =>
      formularyDrugCoverage(db, {
        ...question,
        identityJoin: options.identityJoin === true,
      }),
    async stage(ctx, acquired, tx) {
      if (!run) throw new Error("stage before plan");
      // Each document is admitted or refused on its own. A refused document stages nothing and
      // leaves an earlier reading of its URL, and the years it would have covered, as they are.
      const documents: StagedDocument[] = [];
      refusals = [];
      let rows = 0;
      for (const file of acquired) {
        const link = planned.get(file.url);
        if (!link) throw new Error("unplanned file");
        const extracted = await options.extractor(file.path);
        const reasonCode = documentRefusal(
          stagedFromExtracted(extracted),
          run.years,
        );
        if (reasonCode) {
          refusals.push({
            snapshotId: file.snapshotId,
            url: file.url,
            reasonCode,
          });
          ctx.log({
            code: "carrier_formulary_refused",
            url: file.url,
            reason: reasonCode,
          });
          continue;
        }
        documents.push({ snapshotId: file.snapshotId, link, extracted });
      }
      const admittedYears = [
        ...new Set(documents.map((d) => d.extracted.cover.plan_year!)),
      ];
      await clearEarlier(
        tx,
        documents.map((d) => d.link.url),
        run.issuers.map((issuer) => issuer.issuerId),
        admittedYears,
      );
      for (const { link, extracted, snapshotId } of documents) {
        await writeDocument(tx, { ...link, snapshotId }, extracted);
        rows += extracted.rows.length;
      }
      staged = documents.map((document) => document.snapshotId);
      const catalogs = new Map<string, CatalogPlan[]>();
      const matches = await matchCovers(tx, run, documents, catalogs);
      for (const match of matches)
        await writeLinks(
          tx,
          match.key,
          match.issuer,
          match.planYear,
          match.links,
        );
      for (const issuer of run.issuers)
        for (const year of admittedYears) {
          const attached = new Set(
            matches
              .filter((m) => m.issuer === issuer && m.planYear === year)
              .flatMap((m) => m.links.map((link) => link.basePlanId))
              .filter((id) => id !== null),
          );
          const size = catalogs.get(scopeKey(issuer, year))?.length ?? 0;
          const status = await recordAvailability(
            tx,
            issuer,
            year,
            size,
            attached.size,
          );
          ctx.log({
            code: "carrier_formulary_availability",
            issuer: issuer.issuerId,
            state: issuer.state,
            plan_year: year,
            catalog_plans: size,
            attached_plans: attached.size,
            status,
          });
        }
      for (const { link, extracted, snapshotId } of documents) {
        const admitted = admittedTiers({
          legendTiers: Object.keys(extracted.legend.tiers).map(Number),
          statedTiers: extracted.legend.stated_tiers,
        });
        const count = (level: string) =>
          extracted.rows.filter((row) => row.confidence === level).length;
        const links = matches
          .filter((m) => m.key === snapshotId)
          .flatMap((m) => m.links);
        const linked = (status: string) =>
          links.filter((l) => l.status === status).length;
        ctx.log({
          code: "carrier_formulary_document",
          url: link.url,
          plan_year: extracted.cover.plan_year,
          pages: extracted.summary.pages,
          rows: extracted.rows.length,
          undefined_tier_rows: extracted.rows.filter(
            (row) => !admitted.includes(row.tier),
          ).length,
          high: count("high"),
          medium: count("medium"),
          low: count("low"),
          cover_plans: extracted.cover.plan_names.length,
          attached: linked("attached"),
          ambiguous: linked("plan_mapping_ambiguous"),
          not_in_catalog: linked("plan_not_in_catalog"),
        });
      }
      return {
        rows,
        tables: [DOCUMENT_TABLE, ROW_TABLE, LINK_TABLE, "data_availability"],
      };
    },
    async validate(ctx, tx) {
      if (!run) return { ok: false, reasonCode: REFUSAL.notStaged };
      // Every document was judged in `stage`; what it kept is read back as a second check.
      // A kept document that fails now is a fault, not a refusal: the whole run stops.
      for (const { url, staged: document } of await stagedDocuments(
        tx,
        staged,
      )) {
        const reasonCode = documentRefusal(document, run.years);
        if (reasonCode) {
          ctx.log({
            code: "carrier_formulary_refused",
            url,
            reason: reasonCode,
          });
          return { ok: false, reasonCode };
        }
      }
      if (!staged.length)
        return {
          ok: false,
          reasonCode: refusals[0]?.reasonCode ?? REFUSAL.notStaged,
        };
      return {
        ok: true,
        refused: refusals.map(({ snapshotId, reasonCode }) => ({
          snapshotId,
          reasonCode,
        })),
      };
    },
  };
}
