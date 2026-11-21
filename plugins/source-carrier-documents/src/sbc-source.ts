import { readFile } from "node:fs/promises";
import type {
  FeedContext,
  FeedSource,
  SqlSession,
} from "@openplans/plugin-sdk";
import { formularyArgs } from "./args.js";
import type { FormularyRun, IssuerScope } from "./args.js";
import {
  DISCOVERY_MAX_BYTES,
  DOCUMENT_HOSTS,
  SBC_ARGV,
  SBC_MAX_BYTES,
  SBC_MAX_DOCUMENTS,
  SBC_PUBLISHER,
  SBC_REFUSAL,
  SBC_SOURCE_ID,
  SBC_USAGE,
} from "./constants.js";
import { selectSbcLinks } from "./sbc-discover.js";
import type { SbcLink } from "./sbc-discover.js";
import type { ExtractedSbc, SbcExtractor } from "./sbc-extract.js";
import { mapSbcPlan, resolveSharedSbcClaims } from "./sbc-match.js";
import type { CatalogVariant, SbcPlanLink } from "./sbc-match.js";
import {
  catalogVariants,
  clearEarlierSbc,
  SBC_CHECK_TABLE,
  SBC_DOCUMENT_TABLE,
  SBC_LINK_TABLE,
  SBC_ROW_TABLE,
  writeSbcChecks,
  writeSbcDocument,
  writeSbcLink,
} from "./sbc-stage.js";

export interface SbcSourceOptions {
  extractor: SbcExtractor;
  /** The document hosts; tests use synthetic ones. Defaults to the reviewed `DOCUMENT_HOSTS`. */
  hosts?: readonly string[];
}

/** What the refusal checks read of one document, from the extractor or back from the tables. */
export interface SbcDocumentFacts {
  /** Year of the printed coverage period, or null when no single-year period was read. */
  planYear: number | null;
  urlYear: number;
  /** Chart rows whose label matched the template. */
  matchedRows: number;
}

/**
 * Why an SBC is refused, or undefined when it is admitted. The plan year is the coverage period
 * printed in the document: it must be one calendar year, equal the year the link names, and be a
 * run year. A document linked as one year's SBC that prints another year's coverage period (a
 * 2025 SBC on a 2026 page) is refused, never filed under either year.
 */
export function sbcRefusal(
  facts: SbcDocumentFacts,
  runYears: readonly number[],
): string | undefined {
  if (facts.planYear === null) return SBC_REFUSAL.periodUnresolved;
  if (facts.planYear !== facts.urlYear || !runYears.includes(facts.planYear))
    return SBC_REFUSAL.periodMismatch;
  if (facts.matchedRows === 0) return SBC_REFUSAL.empty;
  return undefined;
}

export const sbcFacts = (
  link: SbcLink,
  extracted: ExtractedSbc,
): SbcDocumentFacts => ({
  planYear: extracted.coverage_period?.plan_year ?? null,
  urlYear: link.urlYear,
  matchedRows: extracted.chart.filter((row) => row.matched).length,
});

interface Admitted {
  snapshotId: string;
  link: SbcLink;
  extracted: ExtractedSbc;
}

/**
 * The SBC feed (kind `sbc-pdf`). `plan` reads the admitted discovery pages and lists the SBC PDFs
 * for the run's years and states; the core fetches them; `stage` runs the word-coordinate
 * extractor, refuses a document whose printed coverage period is not the linked year, maps each
 * admitted document to catalog variants (HIOS id in the file name, else the printed marketing
 * name) and cross-checks every attached row against the federal cost-sharing tables.
 */
export function createSbcSource(options: SbcSourceOptions): FeedSource {
  const hosts = [...(options.hosts ?? DOCUMENT_HOSTS)];
  let run: FormularyRun | undefined;
  let planned = new Map<string, SbcLink>();
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
      for (const link of selectSbcLinks(body, discovery, {
        years: run.years,
        states,
        hosts,
      }))
        planned.set(link.url, link);
    }
    if (planned.size > SBC_MAX_DOCUMENTS) throw new Error("too many documents");
    ctx.log({ code: "carrier_sbc_planned", documents: planned.size });
    return {
      files: [...planned.values()].map((link) => ({
        url: link.url,
        expectedContent: "binary" as const,
        maxBytes: SBC_MAX_BYTES,
      })),
      requireRows: [SBC_DOCUMENT_TABLE, SBC_ROW_TABLE],
    };
  };

  async function mapDocuments(tx: SqlSession, documents: readonly Admitted[]) {
    const catalogs = new Map<string, CatalogVariant[]>();
    const catalog = async (issuer: IssuerScope, year: number) => {
      const key = `${issuer.issuerId}:${year}`;
      if (!catalogs.has(key))
        catalogs.set(key, await catalogVariants(tx, issuer, year));
      return catalogs.get(key)!;
    };
    const mapped: {
      key: string;
      planYear: number;
      issuer: IssuerScope;
      link: SbcPlanLink;
    }[] = [];
    for (const { snapshotId, link, extracted } of documents) {
      const planYear = extracted.coverage_period!.plan_year!;
      // A HIOS id names its issuer; otherwise every run issuer in the link's states is tried.
      const issuers = run!.issuers.filter(
        (issuer) =>
          link.states.includes(issuer.state) &&
          (!link.hiosIds.length ||
            link.hiosIds.every((id) =>
              id.startsWith(issuer.issuerId + issuer.state),
            )),
      );
      for (const issuer of issuers)
        mapped.push({
          key: snapshotId,
          planYear,
          issuer,
          link: mapSbcPlan(
            link.hiosIds,
            extracted.plan_name,
            await catalog(issuer, planYear),
          ),
        });
    }
    // A document attached under one issuer is never also left unmatched under another.
    const attached = new Set(
      mapped.filter((m) => m.link.status === "attached").map((m) => m.key),
    );
    const kept = mapped.filter(
      (m) => m.link.status === "attached" || !attached.has(m.key),
    );
    resolveSharedSbcClaims(kept);
    return kept;
  }

  return {
    kind: "feed",
    id: SBC_SOURCE_ID,
    publisher: SBC_PUBLISHER,
    hosts,
    dataScope: {
      kind: "annual",
      domain: "individual",
      years: (args) => (args as FormularyRun).years,
    },
    command: { argv: SBC_ARGV, usage: SBC_USAGE, args: formularyArgs },
    plan,
    async stage(ctx, acquired, tx) {
      if (!run) throw new Error("stage before plan");
      const documents: Admitted[] = [];
      refusals = [];
      for (const file of acquired) {
        const link = planned.get(file.url);
        if (!link) throw new Error("unplanned file");
        const extracted = await options.extractor(file.path);
        const reasonCode = sbcRefusal(sbcFacts(link, extracted), run.years);
        if (reasonCode) {
          refusals.push({
            snapshotId: file.snapshotId,
            url: file.url,
            reasonCode,
          });
          ctx.log({
            code: "carrier_sbc_refused",
            url: file.url,
            reason: reasonCode,
            printed_year: extracted.coverage_period?.plan_year ?? null,
          });
          continue;
        }
        documents.push({ snapshotId: file.snapshotId, link, extracted });
      }
      const years = [
        ...new Set(
          documents.map((d) => d.extracted.coverage_period!.plan_year!),
        ),
      ];
      await clearEarlierSbc(
        tx,
        documents.map((d) => d.link.url),
        run.issuers.map((issuer) => issuer.issuerId),
        years,
      );
      let rows = 0;
      for (const { snapshotId, link, extracted } of documents) {
        await writeSbcDocument(tx, { ...link, snapshotId }, extracted);
        rows += extracted.questions.length + extracted.chart.length;
      }
      staged = documents.map((d) => d.snapshotId);
      const mapped = await mapDocuments(tx, documents);
      for (const { key, planYear, issuer, link } of mapped) {
        await writeSbcLink(tx, key, issuer, planYear, link);
        const document = documents.find((d) => d.snapshotId === key)!;
        const checks =
          link.status === "attached"
            ? await writeSbcChecks(
                tx,
                key,
                planYear,
                link.variantPlanIds,
                document.extracted,
              )
            : null;
        const count = (level: string) =>
          document.extracted.chart.filter((row) => row.confidence === level)
            .length;
        ctx.log({
          code: "carrier_sbc_document",
          url: document.link.url,
          plan_year: planYear,
          printed_plan_name: document.extracted.plan_name,
          issuer: issuer.issuerId,
          chart_rows: document.extracted.chart.length,
          high: count("high"),
          medium: count("medium"),
          low: count("low"),
          missing_services: document.extracted.missing_services.length,
          mapping: link.method,
          status: link.status,
          variants: link.variantPlanIds.length,
          ...(checks
            ? Object.fromEntries(
                Object.entries(checks).map(([status, n]) => [
                  `check_${status}`,
                  n,
                ]),
              )
            : {}),
        });
      }
      return {
        rows,
        tables: [
          SBC_DOCUMENT_TABLE,
          SBC_ROW_TABLE,
          SBC_LINK_TABLE,
          SBC_CHECK_TABLE,
        ],
      };
    },
    async validate(ctx, tx) {
      if (!run) return { ok: false, reasonCode: SBC_REFUSAL.notStaged };
      // Every document was judged in `stage`; what it kept is read back as a second check. A kept
      // document that fails now is a fault, not a refusal: the whole run stops.
      const { rows } = await tx.query<{
        url: string;
        plan_year: number;
        url_year: number;
        matched: number;
      }>(
        `SELECT d.url, d.plan_year, d.url_year,
           (SELECT count(*)::int FROM ${SBC_ROW_TABLE} r
            WHERE r.snapshot_id = d.snapshot_id AND r.section = 'chart' AND r.label IS NOT NULL) AS matched
         FROM ${SBC_DOCUMENT_TABLE} d WHERE d.snapshot_id = ANY($1::text[]) ORDER BY d.url`,
        [staged],
      );
      for (const row of rows) {
        const reasonCode = sbcRefusal(
          {
            planYear: row.plan_year,
            urlYear: row.url_year,
            matchedRows: row.matched,
          },
          run.years,
        );
        if (reasonCode) {
          ctx.log({
            code: "carrier_sbc_refused",
            url: row.url,
            reason: reasonCode,
          });
          return { ok: false, reasonCode };
        }
      }
      if (!staged.length)
        return {
          ok: false,
          reasonCode: refusals[0]?.reasonCode ?? SBC_REFUSAL.notStaged,
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
