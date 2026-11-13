import { databaseUrl } from "../config/access.js";
import { ingestStateRates } from "../ingest/state/index.js";
import { ingestSbeGeography } from "../ingest/sbe/geography.js";
import {
  acquireSbe,
  sbePublications,
  SBE_INDIVIDUAL_STATES,
} from "../ingest/sbe/source.js";
import { importSbe } from "../ingest/sbe/import.js";
import { sbeRulesFile } from "../ingest/sbe/rules.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, rename } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "../db/database.js";
import type { CoreEvents } from "../plugins/worker.js";
import { migrate, migrationsDirectory } from "../db/migrate.js";
import {
  assertSnapshotAdmissible,
  cachedNames,
  cachedPayloadPath,
  FetchError,
  readCachedText,
  remoteSnapshotStore,
  sidecarNames,
  storeCachedText,
} from "../fetch/index.js";
import type { SnapshotMetadata } from "../fetch/index.js";
import { parameterRegistry } from "../domain/subsidy/generated.js";
import { isSubsidyParameters } from "../domain/subsidy/parameters.js";
import { ingestRatingRules } from "../ingest/rating-rules/index.js";
import { acquirePufs, PUF_KINDS } from "../ingest/puf/acquire.js";
import type { PufManifest } from "../ingest/puf/acquire.js";
import {
  cachedImportFiles,
  importDataDirectory,
  verifyImportFile,
} from "../ingest/puf/import-source.js";
import { importPufs } from "../ingest/puf/import.js";
import { pufStates } from "../ingest/puf/import-batch.js";
import { acquireGeo, geoSources } from "../ingest/geo/sources.js";
import { STATE_FIPS } from "../ingest/geo/states.js";
import {
  acquireRelease as acquireRxnorm,
  discoverRelease as discoverRxnorm,
} from "../ingest/rxnorm/acquire.js";
import { importRxnorm } from "../ingest/rxnorm/import.js";
import {
  acquireRelease as acquireNppes,
  discoverCurrent,
  discoverReleases,
} from "../ingest/nppes/acquire.js";
import type { Kind } from "../ingest/nppes/acquire.js";
import { importNppes } from "../ingest/nppes/import.js";
import {
  acquireRelease as acquireTaxonomy,
  discoverRelease as discoverTaxonomy,
  importTaxonomy,
} from "../plugins/core-plugin.js";
import {
  cachedRegistry,
  verifyRegistry,
  readRegistry,
  registryWorkbook,
  readGeorgiaRegistry,
} from "../ingest/qhp/discover-registry.js";
import { cachedGeorgiaRegistry } from "../ingest/sbe/georgia.js";
import {
  preparedQhpFetcher,
  preparedQhpOutcome,
  readQhpProfile,
} from "./qhp-profile.js";
import { discoverQhp } from "../ingest/qhp/discover.js";
import { ingestQhpBatch } from "../ingest/qhp/formulary-batch.js";
import {
  acquireCounties,
  geocodeState,
  geocodeStates,
} from "../ingest/geocode/counties.js";
import {
  createRun,
  stageStatewide,
  geocodeStatewide,
  publishStatewide,
  refreshStatewideFallbacks,
} from "../ingest/geocode/statewide.js";

interface Output {
  out(message: string): void;
  error(message: string): void;
}
export interface BootstrapOptions {
  states: string[];
  years: number[];
  drugs: boolean;
  providers: boolean;
  nuccTaxonomy: boolean;
  geocode: boolean;
  dryRun: boolean;
  qhpCacheOnly?: boolean;
  qhpProfile?: string;
}
export interface StepOutcome {
  skipped?: boolean;
  reason?: string;
  evidence?: unknown;
}
export interface BootstrapStep {
  id: string;
  depends_on: string[];
  estimated_download_bytes: number | "unknown";
  skip_reason?: string;
  run(): Promise<StepOutcome>;
}
export interface StepResult extends StepOutcome {
  id: string;
  status: "completed" | "skipped" | "failed" | "planned";
  elapsed_ms: number;
  blocked_by?: string[];
  /** A stable failure code and a message that excludes paths, credentials and row data. */
  error?: { code: string; message: string; status?: number };
  /** What an operator can do about a held or unreviewed publisher. */
  action?: string;
}
const usage =
  "Usage: worker bootstrap --states TX,FL --years 2026,2027 [--with-drugs] [--with-providers] [--with-nucc-taxonomy] [--with-geocode] [--qhp-cache-only] [--qhp-profile PATH] [--dry-run]";
class BootstrapFailure extends Error {
  constructor(
    reason: string,
    readonly evidence?: unknown,
  ) {
    super(reason);
  }
}
const fail = (reason: string, evidence?: unknown): never => {
  throw new BootstrapFailure(reason, evidence);
};
const accessGuide = "docs/self-host.md#publisher-access";
/** Sources OpenPlans cannot collect with its shipped manifests, and why (see the access guide). */
const heldSourceActions: [RegExp, string][] = [
  [
    /^rxnorm$/,
    "RxNorm is unavailable: its download host (download.nlm.nih.gov) disallows all automated access in robots.txt, so OpenPlans ships no clearance for it. Run without --with-drugs.",
  ],
  [
    /^taxonomy$/,
    "NUCC taxonomy needs your own terms review: add a reviewed operator manifest entry for www.nucc.org through OPENPLANS_ACCESS_MANIFEST.",
  ],
  [
    /^qhp-/,
    "Issuer hosts are not shipped: add a reviewed operator manifest entry for each issuer host through OPENPLANS_ACCESS_MANIFEST.",
  ],
];
function operatorAction(stepId: string): string {
  const held = heldSourceActions.find(([pattern]) => pattern.test(stepId));
  return `${held ? `${held[1]} ` : ""}See ${accessGuide}.`;
}
function fetchFailure(error: unknown): FetchError | undefined {
  for (let cause = error, depth = 0; cause && depth < 5; depth++) {
    if (cause instanceof FetchError) return cause;
    cause = (cause as { cause?: unknown }).cause;
  }
}
/** Only fetch errors and fixed diagnostic messages are safe to log. */
export function failureDetail(
  stepId: string,
  error: unknown,
): Pick<StepResult, "reason" | "error" | "action" | "evidence"> {
  const fetchError = fetchFailure(error);
  if (fetchError)
    return {
      reason: fetchError.code,
      error: {
        code: fetchError.code,
        message: fetchError.message,
        ...(fetchError.status !== undefined && { status: fetchError.status }),
      },
      ...(/^admission_/.test(fetchError.code) && {
        action: operatorAction(stepId),
      }),
    };
  if (error instanceof BootstrapFailure)
    return {
      reason: error.message,
      ...(error.evidence !== undefined && { evidence: error.evidence }),
      ...(/^(qhp_|no_qhp_|required_puf_)/.test(error.message) && {
        action: operatorAction(stepId),
      }),
    };
  const filesystemMessages: Record<string, string> = {
    EROFS:
      "Cache filesystem is read-only; mount work and derived outputs writable",
    EACCES: "Cache access denied; check worker permissions",
    ENOENT: "Required cache file or directory is missing",
    ENOSPC: "Cache filesystem has no free space",
  };
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string" && Object.hasOwn(filesystemMessages, code))
    return {
      reason: "filesystem_error",
      error: { code, message: filesystemMessages[code]! },
    };
  return { reason: "step_failed_check_source_cache_and_database" };
}
const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
const dataFile = (path: string) =>
  fileURLToPath(new URL(`../../data/${path}`, import.meta.url));

export function parseBootstrapOptions(args: string[]): BootstrapOptions {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (
      flags.has(key) ||
      ![
        "--states",
        "--years",
        "--with-drugs",
        "--with-providers",
        "--with-nucc-taxonomy",
        "--with-geocode",
        "--qhp-cache-only",
        "--qhp-profile",
        "--dry-run",
      ].includes(key)
    )
      throw new Error(usage);
    const value = ["--states", "--years", "--qhp-profile"].includes(key)
      ? args[++i]
      : "true";
    if (!value || value.startsWith("--")) throw new Error(usage);
    flags.set(key, value);
  }
  const states = (flags.get("--states") ?? "").split(","),
    years = (flags.get("--years") ?? "").split(",");
  if (
    states.some((state) => !Object.hasOwn(STATE_FIPS, state)) ||
    years.some((year) => !/^(2026|2027)$/.test(year))
  )
    throw new Error(usage);
  return {
    states: [...new Set(states)],
    years: [...new Set(years.map(Number))],
    drugs: flags.has("--with-drugs"),
    providers: flags.has("--with-providers") || flags.has("--with-geocode"),
    nuccTaxonomy: flags.has("--with-nucc-taxonomy"),
    geocode: flags.has("--with-geocode"),
    dryRun: flags.has("--dry-run"),
    qhpCacheOnly: flags.has("--qhp-cache-only") || flags.has("--qhp-profile"),
    ...(flags.has("--qhp-profile") && {
      qhpProfile: flags.get("--qhp-profile")!,
    }),
  };
}

/** The graph is ordered, but only failed prerequisites block a step. Only FetchError text is logged. */
export async function executeBootstrap(
  steps: BootstrapStep[],
  output: Output,
  dryRun = false,
) {
  const results: StepResult[] = [];
  for (const step of steps) {
    const started = Date.now();
    const blocked = step.depends_on.filter((id) => {
      const dependency = results.find((result) => result.id === id);
      return (
        !dependency ||
        dependency.status === "failed" ||
        !!dependency.blocked_by?.length
      );
    });
    let result: StepResult;
    if (step.skip_reason)
      result = {
        id: step.id,
        status: "skipped",
        reason: step.skip_reason,
        elapsed_ms: 0,
      };
    else if (dryRun) result = { id: step.id, status: "planned", elapsed_ms: 0 };
    else if (blocked.length)
      result = {
        id: step.id,
        status: "skipped",
        reason: "dependency_failed",
        blocked_by: blocked,
        elapsed_ms: 0,
      };
    else {
      output.out(
        JSON.stringify({ bootstrap_step: step.id, status: "starting" }),
      );
      try {
        const outcome = await step.run();
        result = {
          ...outcome,
          id: step.id,
          status: outcome.skipped ? "skipped" : "completed",
          elapsed_ms: Date.now() - started,
        };
      } catch (error) {
        result = {
          id: step.id,
          status: "failed",
          ...failureDetail(step.id, error),
          elapsed_ms: Date.now() - started,
        };
      }
    }
    results.push(result);
    output.out(
      JSON.stringify({
        ...result,
        depends_on: step.depends_on,
        estimated_download_bytes: step.estimated_download_bytes,
      }),
    );
  }
  const failed = results
    .filter((result) => result.status === "failed")
    .map((result) => result.id);
  const blocked = results
    .filter((result) => result.blocked_by?.length)
    .map((result) => result.id);
  const summary = {
    command: "bootstrap",
    dry_run: dryRun,
    passed: !failed.length && !blocked.length,
    failed,
    blocked,
    steps: results,
  };
  output.out(JSON.stringify(summary));
  return summary;
}

async function metadata(
  dataDir: string,
  source: string,
  url?: string | RegExp,
): Promise<SnapshotMetadata | undefined> {
  // Sidecars are read through the fetch cache's store, local or remote.
  const values: SnapshotMetadata[] = [];
  for (const name of await sidecarNames(dataDir, source)) {
    const m = JSON.parse(
      await readCachedText(dataDir, source, name),
    ) as SnapshotMetadata;
    if (
      m.source !== source ||
      !/^[a-f0-9]{64}$/.test(m.sha256) ||
      !Number.isSafeInteger(m.bytes) ||
      m.bytes < 0 ||
      typeof m.fetched_at !== "string"
    )
      fail("invalid_cache_metadata");
    if (!url || (typeof url === "string" ? m.url === url : url.test(m.url)))
      values.push(m);
  }
  return values.sort((a, b) => b.fetched_at.localeCompare(a.fetched_at))[0];
}
async function latestManifest(
  dataDir: string,
): Promise<PufManifest | undefined> {
  // PUF manifests live beside their snapshots, in the fetch cache's store.
  const name = (await cachedNames(dataDir, "cms-exchange-puf"))
    .filter((name) => /^manifest-.*\.json$/.test(name))
    .sort()
    .at(-1);
  if (!name) return;
  const m = JSON.parse(
    await readCachedText(dataDir, "cms-exchange-puf", name),
  ) as PufManifest;
  if (m.schema_version !== 1 || m.dry_run || !Array.isArray(m.files))
    fail("invalid_puf_manifest");
  return m;
}
/** Cached release pages and archives obey the fetch cache's quarantine and re-admission rule. */
const SNAPSHOT_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
async function verifiedCached(dataDir: string, source: string, url?: string) {
  const m = await metadata(dataDir, source, url);
  if (!m) return;
  await assertSnapshotAdmissible(dataDir, m);
  // A feed run names its cache directory by snapshot id; other fetches use the hash.
  const directory = SNAPSHOT_DIRECTORY.test(m.snapshot_id ?? "")
    ? m.snapshot_id
    : m.sha256;
  let path: string;
  try {
    path = await cachedPayloadPath(dataDir, source, directory, {
      bytes: m.bytes,
      sha256: m.sha256,
    });
  } catch (error) {
    // A remote store's copy that fails its size or hash check.
    if ((error as { code?: string }).code === "cache_error")
      fail("cache_integrity_failed");
    throw error;
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (hash.digest("hex") !== m.sha256 || bytes !== m.bytes)
    fail("cache_integrity_failed");
  return { path, metadata: m };
}

/** Build without DB access, downloads or writes, so --dry-run works on an empty installation. */
export async function bootstrapPlan(
  options: BootstrapOptions,
  database: () => Database,
  dataDir: string,
  directory = migrationsDirectory,
  sbeScopes: readonly { state: string; year: number }[] = [],
): Promise<BootstrapStep[]> {
  if (!isAbsolute(dataDir)) fail("absolute_data_directory_required");
  const profile = options.qhpProfile
    ? await readQhpProfile(options.qhpProfile)
    : undefined;
  if (
    profile &&
    (!options.providers ||
      options.drugs ||
      options.nuccTaxonomy ||
      profile.scopes.length !== options.states.length * options.years.length ||
      profile.scopes.some(
        (scope) =>
          !options.states.includes(scope.state) ||
          !options.years.includes(scope.year),
      ))
  )
    fail("prepared_qhp_scope_mismatch");
  const preparedFetcher = profile ? preparedQhpFetcher(profile) : undefined;
  const steps: BootstrapStep[] = [];
  const add = (
    id: string,
    depends_on: string[],
    run: BootstrapStep["run"],
    bytes: number | "unknown" = 0,
    skip_reason?: string,
  ) =>
    steps.push({
      id,
      depends_on,
      run,
      estimated_download_bytes: bytes,
      skip_reason,
    });
  const exists = async (sql: string, parameters: unknown[] = []) =>
    (await database().query(sql, parameters)).rows.length > 0;
  const active = (id: string) =>
    exists(
      "SELECT 1 FROM snapshot WHERE snapshot_id=$1 AND validation_state='ACTIVE'",
      [id],
    );
  const current = { skipped: true, reason: "current_active_snapshot" };
  const estimateMetadata = (source: string, url?: string | RegExp) =>
    metadata(dataDir, source, url).catch(() => undefined);
  const publicationStates = new Map<number, string[]>();
  // Publication selection belongs to the command. Programmatic federal-only
  // plans keep their explicit acquired-manifest semantics.
  const isSbe = (state: string, year: number) =>
    sbeScopes.some((scope) => scope.state === state && scope.year === year);
  add("migrate", [], async () => {
    const applied = await migrate(database(), directory);
    return {
      skipped: !applied.length,
      reason: applied.length ? "migrations_applied" : "schema_current",
      evidence: { applied },
    };
  });
  for (const year of options.years) {
    add(`rating-rules-${year}`, ["migrate"], async () => {
      const file = sbeScopes.some((scope) => scope.year === year)
          ? await sbeRulesFile(dataDir, year)
          : dataFile(`rating-rules/${year}.json`),
        sha = digest(await readFile(file));
      if (
        await exists(
          `SELECT 1 FROM rating_rule_set r JOIN snapshot s USING(snapshot_id)
        WHERE r.plan_year=$1 AND s.sha256=$2 AND s.validation_state='ACTIVE'`,
          [year, sha],
        )
      )
        return current;
      return { evidence: await ingestRatingRules(database(), file) };
    });
    add(`subsidy-${year}`, ["migrate"], async () => {
      const parameters =
        parameterRegistry[year as keyof typeof parameterRegistry];
      if (!isSubsidyParameters(parameters))
        throw new BootstrapFailure("invalid_bundled_subsidy_parameters");
      return {
        skipped: true,
        reason: "bundled_parameters_validated",
        evidence: { status: parameters.status },
      };
    });
  }
  // Each year acquires independently. Preserve other observed years in a composite manifest,
  // because the existing importers deliberately read only the newest acquired manifest.
  for (const year of options.years) {
    const m = await latestManifest(dataDir).catch(() => undefined);
    const files = m?.files.filter((file) => file.year === year);
    const estimate =
      files?.length && files.every((file) => typeof file.bytes === "number")
        ? files.reduce((sum, file) => sum + file.bytes!, 0)
        : "unknown";
    add(
      `puf-acquire-${year}`,
      ["migrate"],
      async () => {
        const previous = await latestManifest(dataDir);
        const selected =
          previous?.files.filter((file) => file.year === year) ?? [];
        const wanted =
          options.drugs || options.providers
            ? PUF_KINDS.filter((kind) => kind !== "plan-id-crosswalk")
            : PUF_KINDS.filter(
                (kind) =>
                  !["plan-id-crosswalk", "machine-readable-url"].includes(kind),
              );
        if (
          wanted.every(
            (kind) =>
              selected.filter(
                (file) => file.kind === kind && file.status === "ok",
              ).length === 1,
          )
        ) {
          const cached = await cachedImportFiles(dataDir, year);
          for (const file of cached.files) await verifyImportFile(file);
          if (options.drugs || options.providers)
            await verifyRegistry(await cachedRegistry(dataDir, year));
          return { skipped: true, reason: "verified_cached_publication" };
        }
        const acquired = await acquirePufs({ year, dataDir });
        const combined = {
          ...acquired.manifest,
          files: [
            ...(previous?.files.filter((file) => file.year !== year) ?? []),
            ...acquired.manifest.files,
          ],
        };
        const name = `manifest-${new Date().toISOString().replace(/:/g, "-")}-bootstrap.json`;
        const text = `${JSON.stringify(combined, null, 2)}\n`;
        const remote = remoteSnapshotStore(dataDir);
        if (remote)
          await storeCachedText(remote, "cms-exchange-puf", name, text);
        else {
          const path = join(dataDir, "raw", "cms-exchange-puf", name);
          await writeFile(`${path}.part`, text, { flag: "wx" });
          await rename(`${path}.part`, path);
        }
        if (
          wanted.some(
            (kind) =>
              combined.files.find(
                (file) => file.year === year && file.kind === kind,
              )?.status !== "ok",
          )
        )
          fail(
            "required_puf_files_unavailable",
            combined.files
              .filter(
                (file) => file.year === year && wanted.includes(file.kind),
              )
              .map((file) => ({ kind: file.kind, status: file.status })),
          );
        return { reason: "publication_acquired" };
      },
      estimate,
      options.states.every((state) => isSbe(state, year))
        ? "sbe_publications_selected"
        : undefined,
    );
    for (const state of options.states) {
      if (isSbe(state, year)) {
        add(
          `sbe-acquire-${state}-${year}`,
          ["migrate"],
          async () => {
            const link = (await sbePublications(dataDir)).find(
              (link) => link.state === state && link.year === year,
            );
            if (!link) fail("sbe_state_year_not_published");
            const files = await acquireSbe(link!, dataDir);
            return {
              evidence: {
                source: "cms_sbe_puf",
                url: link!.url,
                sha256: files[0]!.sha256,
              },
            };
          },
          "unknown",
        );
        add(
          `puf-${state}-${year}`,
          [`sbe-acquire-${state}-${year}`, `rating-rules-${year}`],
          async () => {
            const link = (await sbePublications(dataDir)).find(
              (link) => link.state === state && link.year === year,
            )!;
            const files = await acquireSbe(link, dataDir);
            if (
              await exists(
                `SELECT 1 FROM sbe_catalog c JOIN puf_import p USING(import_id) JOIN snapshot s ON s.snapshot_id=p.import_id
            WHERE p.state=$1 AND p.plan_year=$2 AND c.bundle_sha256=$3 AND s.validation_state='ACTIVE'
            AND (NOT c.serving OR EXISTS(SELECT 1 FROM puf_active_catalog a WHERE a.import_id=c.import_id))`,
                [state, year, files[0]!.sha256],
              )
            )
              return current;
            const report = await importSbe(database(), {
              year,
              state,
              dataDir,
              files,
            });
            if (!report.passed)
              fail("sbe_reconciliation_failed_previous_active_preserved");
            return { evidence: report };
          },
        );
      } else
        add(`puf-${state}-${year}`, [`puf-acquire-${year}`], async () => {
          const { files } = await cachedImportFiles(dataDir, year);
          const rows = (
            await database().query<{
              kind: string;
              sha256: string;
              validation_state: string;
            }>(
              `SELECT f.kind,s.sha256,s.validation_state
          FROM puf_active_catalog a JOIN puf_import_file f ON f.import_id=a.import_id JOIN snapshot s ON s.snapshot_id=f.snapshot_id
          JOIN snapshot parent ON parent.snapshot_id=a.import_id AND parent.validation_state='ACTIVE' AND parent.parser_version='puf-import-v1' WHERE a.state=$1 AND a.plan_year=$2`,
              [state, year],
            )
          ).rows;
          if (
            rows.length === files.length &&
            files.every((file) =>
              rows.some(
                (row) =>
                  row.kind === file.kind &&
                  row.sha256 === file.sha256 &&
                  row.validation_state === "ACTIVE",
              ),
            )
          )
            return current;
          if (!publicationStates.has(year))
            publicationStates.set(year, await pufStates(files, year));
          if (!publicationStates.get(year)!.includes(state))
            fail("state_not_in_publication");
          const report = await importPufs(database(), { year, state, dataDir });
          if (!report.passed)
            fail("puf_reconciliation_failed_previous_active_preserved");
          if (!report.identifiers.base_plans) fail("state_not_in_publication");
          return {
            evidence: {
              import_id: report.import_id,
              base_plans: report.identifiers.base_plans,
              report_json: report.report_json,
            },
          };
        });
      if (isSbe(state, year) && ["NY", "VT"].includes(state)) {
        add(
          `state-filed-${state}-${year}`,
          [`puf-${state}-${year}`],
          async () => {
            if (
              await exists(
                `SELECT 1 FROM state_rate_active a JOIN snapshot s ON s.snapshot_id=a.import_id
            WHERE a.state=$1 AND a.plan_year=$2 AND s.validation_state='ACTIVE'`,
                [state, year],
              )
            )
              return current;
            const file = join(
              dataDir,
              "derived",
              "state-rating",
              `${state.toLowerCase()}-${year}.json`,
            );
            if (
              !(await readFile(file).then(
                () => true,
                () => false,
              ))
            )
              fail("state_filed_tier_publications_not_prepared");
            return {
              evidence: await ingestStateRates(
                database(),
                file,
                state as "NY" | "VT",
              ),
            };
          },
        );
      }
      const sources = geoSources(state),
        sizes = await Promise.all(
          Object.values(sources).map((source) =>
            estimateMetadata(source.source, source.url),
          ),
        );
      add(
        `geo-${state}-${year}`,
        ["migrate"],
        async () => {
          const files = await acquireGeo({ dataDir, state });
          if (
            await exists(
              `SELECT 1 FROM geo_import g JOIN snapshot r ON r.snapshot_id=g.relationship_snapshot_id
          JOIN snapshot c ON c.snapshot_id=g.centroid_snapshot_id JOIN snapshot a ON a.snapshot_id=g.rating_snapshot_id
          WHERE g.state=$1 AND g.plan_year=$2 AND r.sha256=$3 AND c.sha256=$4 AND a.sha256=$5
          AND r.validation_state='ACTIVE' AND c.validation_state='ACTIVE' AND a.validation_state='ACTIVE'`,
              [
                state,
                year,
                files.relationship.metadata.sha256,
                files.centroids.metadata.sha256,
                files.ratingAreas.metadata.sha256,
              ],
            )
          )
            return current;
          // The state router registers CMS county spellings (IL's "Vermillion", for one) before
          // the shared importer runs, so a federal year of a state with one imports too.
          return {
            evidence: await ingestSbeGeography(database(), {
              state,
              planYear: year,
              dataDir,
              files,
            }),
          };
        },
        sizes.every(Boolean)
          ? sizes.reduce((sum, value) => sum + value!.bytes, 0)
          : "unknown",
      );
    }
  }
  if (options.drugs) {
    const m = await estimateMetadata("nlm-rxnorm-prescribe");
    add(
      "rxnorm",
      ["migrate"],
      async () => {
        const page = await verifiedCached(dataDir, "nlm-rxnorm-files");
        const release = page
          ? discoverRxnorm(await readFile(page.path, "utf8"))
          : undefined;
        const cached = release
          ? await verifiedCached(dataDir, "nlm-rxnorm-prescribe", release.url)
          : undefined;
        const acquired =
          cached && release
            ? { ...release, ...cached }
            : await acquireRxnorm(dataDir);
        if (
          await active(`rxnorm-${acquired.version}-${acquired.metadata.sha256}`)
        )
          return current;
        return { evidence: await importRxnorm(database(), acquired) };
      },
      m?.bytes ?? "unknown",
    );
  }
  if (options.providers) {
    for (const state of options.states) {
      for (const kind of ["full", "weekly", "deactivation"] as Kind[]) {
        const patterns = {
          full: /\/NPPES_Data_Dissemination_[A-Za-z]+_\d{4}_V2\.zip$/i,
          weekly: /_Weekly_V2\.zip$/i,
          deactivation: /\/NPPES_Deactivated_NPI_Report_[^/]+_V2\.zip$/i,
        };
        const size = (await estimateMetadata("cms-nppes", patterns[kind]))
          ?.bytes;
        add(
          `nppes-${state}-${kind}`,
          kind === "full" ? ["migrate"] : [`nppes-${state}-full`],
          async () => {
            // Migration 680 separates membership from the shared identity. Refuse an
            // inconsistent legacy selection rather than letting another state replace it.
            if (
              await exists(`SELECT 1 FROM (SELECT npi,state_filter FROM npi_provider
            EXCEPT SELECT npi,state_filter FROM npi_state_scope) missing LIMIT 1`)
            )
              fail("nppes_state_membership_missing");
            const cachedPage = await verifiedCached(dataDir, "cms-nppes-page");
            const available = cachedPage
              ? discoverReleases(await readFile(cachedPage.path, "utf8"))
              : await discoverCurrent(dataDir);
            const release = available.find((release) => release.kind === kind);
            if (!release) fail("nppes_official_v2_link_unavailable");
            const acquired = await acquireNppes(release!, dataDir);
            if (
              await exists(
                `SELECT 1 FROM npi_import_run r JOIN snapshot s USING(snapshot_id)
            WHERE r.state_filter=$1 AND r.kind=$2 AND s.sha256=$3 AND s.validation_state='ACTIVE'
            AND s.source_id='cms-nppes' AND s.schema_version='nppes-v2'`,
                [state, kind, acquired.metadata.sha256],
              )
            )
              return current;
            const report = await importNppes(database(), {
              ...acquired,
              state,
            });
            return {
              skipped: report.outcome !== "imported",
              reason: report.outcome,
              evidence: report,
            };
          },
          size ?? "unknown",
        );
      }
    }
  }
  if (options.providers || options.nuccTaxonomy) {
    add(
      "taxonomy",
      ["migrate"],
      async () => {
        if (!options.nuccTaxonomy)
          return { skipped: true, reason: "opt_in_required" };
        const page = await verifiedCached(
          dataDir,
          "nucc-provider-taxonomy-page",
        );
        const release = page
          ? discoverTaxonomy(await readFile(page.path, "utf8"))
          : undefined;
        const cached = release
          ? await verifiedCached(dataDir, "nucc-provider-taxonomy", release.url)
          : undefined;
        const acquired =
          cached && release
            ? { ...release, ...cached }
            : await acquireTaxonomy(dataDir);
        if (
          await exists(
            `SELECT 1 FROM provider_taxonomy t JOIN snapshot s USING(snapshot_id)
        WHERE s.validation_state='ACTIVE' AND s.sha256=$1 LIMIT 1`,
            [acquired.metadata.sha256],
          )
        )
          return current;
        return { evidence: await importTaxonomy(database(), acquired) };
      },
      options.nuccTaxonomy
        ? ((await estimateMetadata("nucc-provider-taxonomy"))?.bytes ??
            "unknown")
        : 0,
      options.nuccTaxonomy ? undefined : "opt_in_required",
    );
  }
  if (options.drugs || options.providers)
    for (const year of options.years)
      for (const state of options.states) {
        const scope = `${state}-${year}`;
        const preparedFeeds = profile?.provider_feeds.filter(
          (feed) => feed.state === state,
        );
        if (isSbe(state, year) && !preparedFeeds?.length) {
          add(`qhp-sbe-${scope}`, [`puf-${scope}`], async () => ({
            skipped: true,
            reason: "sbe_no_index_registry",
          }));
          continue;
        }
        add(
          `qhp-discover-${scope}`,
          [`puf-acquire-${year}`],
          async () => {
            const registry =
              profile && state === "GA"
                ? {
                    ...(await cachedGeorgiaRegistry(dataDir, year)),
                    format: "georgia-access-csv" as const,
                  }
                : await cachedRegistry(dataDir, year);
            await verifyRegistry(registry);
            // Discovery is observed PARSED evidence, never ACTIVE. Completeness here means
            // every registry row was attempted; denied indexes remain explicit coverage gaps.
            const expected =
              "format" in registry
                ? await readGeorgiaRegistry(registry.path, state)
                : await readRegistry(
                    await registryWorkbook(registry, dataDir),
                    state,
                  );
            const rows = (
              await database().query<{
                registry_row: number;
                registry_snapshot_id: string;
                issuer_id: string;
                status: string;
                snapshot_id: string | null;
              }>(
                `SELECT i.registry_row,i.registry_snapshot_id,i.issuer_id,i.status,i.snapshot_id FROM qhp_index i
        WHERE i.state=$1 AND i.plan_year=$2 AND i.discovery_id=(SELECT discovery_id FROM qhp_index
          WHERE state=$1 AND plan_year=$2 ORDER BY discovered_at DESC,qhp_index_id DESC LIMIT 1)`,
                [state, year],
              )
            ).rows;
            if (
              rows.length &&
              rows.length === expected.length &&
              (!profile ||
                expected
                  .filter((entry) =>
                    preparedFeeds!.some((feed) => feed.issuer === entry.issuer),
                  )
                  .every((entry) => {
                    const pin = profile.feed_raw.find(
                      (file) => file.url === entry.url,
                    );
                    return (
                      pin &&
                      rows.some(
                        (row) =>
                          row.registry_row === entry.row &&
                          row.status === "ok" &&
                          row.snapshot_id ===
                            `qhp:${entry.issuer}:${year}:index:${pin.sha256}`,
                      )
                    );
                  })) &&
              expected.every((entry) =>
                rows.some(
                  (row) =>
                    row.registry_row === entry.row &&
                    row.registry_snapshot_id ===
                      `qhp:registry:${registry.metadata.sha256}`,
                ),
              )
            )
              return { skipped: true, reason: "current_observed_discovery" };
            const report = await discoverQhp(database(), {
              state,
              year,
              dataDir,
              registry,
              offline: options.qhpCacheOnly,
              ...(preparedFetcher && { fetcher: preparedFetcher }),
            });
            return { evidence: report };
          },
          "unknown",
        );
        for (const kind of ["formulary", "providers"] as const) {
          if (kind === "formulary" ? !options.drugs : !options.providers)
            continue;
          const prerequisites = [`qhp-discover-${scope}`, `puf-${scope}`];
          if (kind === "formulary") prerequisites.push("rxnorm");
          // Participation evidence can still import when identity enrichment is unavailable.
          add(
            `qhp-${kind}-${scope}`,
            prerequisites,
            async () => {
              const table = kind === "providers" ? "provider" : "formulary",
                manifestKind = kind === "providers" ? "provider" : "drug";
              const issuers = (
                await database().query<{ issuer_id: string; current: boolean }>(
                  `WITH latest AS (
          SELECT DISTINCT ON (issuer_id) issuer_id,discovery_id FROM qhp_index WHERE state=$1 AND plan_year=$2
          ORDER BY issuer_id,discovered_at DESC,qhp_index_id DESC)
          SELECT l.issuer_id,(a.snapshot_id IS NOT NULL AND s.validation_state='ACTIVE' AND m.status='complete'
            AND f.discovery_id=l.discovery_id AND f.catalog_snapshot_id=pf.snapshot_id
            AND s.parser_version='${kind === "providers" ? "qhp-provider-v4" : "qhp-formulary-v3"}'
            AND NOT EXISTS (SELECT 1 FROM ${table}_shard sh JOIN qhp_child_url c ON c.qhp_child_url_id=sh.child_id
              WHERE sh.source_set_id=a.snapshot_id AND (sh.status<>'complete' OR sh.raw_snapshot_id IS DISTINCT FROM c.snapshot_id))) IS TRUE AS current
          FROM latest l LEFT JOIN ${table}_active_set a ON a.issuer_id=l.issuer_id AND a.state=$1 AND a.plan_year=$2
          LEFT JOIN ${table}_source_set f ON f.snapshot_id=a.snapshot_id LEFT JOIN snapshot s ON s.snapshot_id=a.snapshot_id
          LEFT JOIN qhp_coverage_manifest m ON m.issuer_id=l.issuer_id AND m.state=$1 AND m.plan_year=$2 AND m.kind=$3 AND m.snapshot_id=a.snapshot_id
          LEFT JOIN puf_active_catalog p ON p.state=$1 AND p.plan_year=$2
          LEFT JOIN puf_import_file pf ON pf.import_id=p.import_id AND pf.kind='plan-attributes'`,
                  [state, year, manifestKind],
                )
              ).rows;
              if (!issuers.length) fail("no_qhp_issuers_discovered");
              const skipIssuers = issuers
                .filter(
                  (issuer) =>
                    issuer.current ||
                    (profile &&
                      !preparedFeeds!.some(
                        (feed) => feed.issuer === issuer.issuer_id,
                      )),
                )
                .map((issuer) => issuer.issuer_id);
              if (skipIssuers.length === issuers.length)
                return profile
                  ? {
                      skipped: true,
                      reason: "prepared_qhp_issuers_current_or_out_of_scope",
                    }
                  : current;
              const report = await ingestQhpBatch(database(), kind, {
                state,
                year,
                skipIssuers,
                ...(preparedFetcher && { fetcher: preparedFetcher }),
                fetchOptions: {
                  dataDir,
                  ...(options.qhpCacheOnly && {
                    maxAttempts: 1,
                    lookup: async () => {
                      throw new FetchError(
                        "cache_error",
                        "QHP cache-only mode: snapshot unavailable",
                      );
                    },
                    transport: async () => {
                      throw new FetchError(
                        "cache_error",
                        "QHP cache-only mode: snapshot unavailable",
                      );
                    },
                  }),
                },
              });
              if (
                report.issuers.some((issuer) =>
                  profile
                    ? !preparedQhpOutcome(issuer)
                    : issuer.completeness !== "complete",
                ) ||
                report.not_run.length
              )
                fail(
                  profile
                    ? "prepared_qhp_import_failed"
                    : "qhp_incomplete_check_coverage_manifest",
                );
              return {
                evidence: {
                  imported: report.issuers.length,
                  skipped_issuers: skipIssuers,
                  ...(profile && {
                    issuers: report.issuers.map((issuer) => ({
                      issuer: issuer.issuer,
                      status: issuer.status,
                      reason: issuer.reason,
                      completeness: issuer.completeness,
                    })),
                  }),
                },
              };
            },
            "unknown",
          );
        }
      }
  if (options.geocode)
    for (const state of options.states) {
      add(
        `geocode-${state}`,
        [
          `nppes-${state}-full`,
          ...options.years.map((year) => `geo-${state}-${year}`),
        ],
        async () => {
          // Preserve the existing unsupported-state reason for callers that key on it.
          if (!Object.hasOwn(geocodeStates, state))
            fail("geocode_currently_supports_TX_only");
          const selectedState = geocodeState(state),
            db = database();
          // Hold the same global writer lock as the bulk CLI on a reserved connection.
          // Queue writes retain their own short atomic transactions on the other connections.
          return db.transaction(async (lock) => {
            if (
              !(
                await lock.query<{ locked: boolean }>(
                  "SELECT pg_try_advisory_xact_lock(1869636988) locked",
                )
              ).rows[0]?.locked
            )
              fail("another_statewide_geocoder_owns_lock");
            const interrupted = (
              await db.query<{ run_id: string }>(
                `SELECT r.run_id FROM geocode_tx_run r WHERE r.state=$1
          AND r.run_id LIKE 'bootstrap-%' AND (NOT r.npi_staged OR NOT r.issuer_staged OR EXISTS (
            SELECT 1 FROM geocode_tx_address a WHERE a.run_id=r.run_id AND NOT EXISTS (
              SELECT 1 FROM geocode_tx_result result WHERE result.address_hash=a.address_hash)))
          ORDER BY r.created_at LIMIT 1`,
                [state],
              )
            ).rows[0];
            const scope = (
              await db.query(`SELECT ARRAY(SELECT s.snapshot_id FROM provider_shard s
          JOIN provider_active_set a ON a.snapshot_id=s.source_set_id JOIN snapshot snap ON snap.snapshot_id=s.snapshot_id
          WHERE snap.validation_state='ACTIVE' ORDER BY s.snapshot_id) AS shards,
          ARRAY(SELECT snapshot_id FROM npi_import_run ORDER BY snapshot_id) AS nppes`)
            ).rows[0];
            const signature = createHash("sha256")
              .update(JSON.stringify(scope))
              .digest("hex");
            const complete =
              !interrupted &&
              (
                await db.query<{ run_id: string }>(
                  `SELECT r.run_id FROM geocode_tx_run r
          WHERE r.state=$1 AND r.run_id LIKE 'bootstrap-%' AND r.scope_signature=$2 AND r.return_type='locations'
            AND r.npi_staged AND r.issuer_staged AND NOT EXISTS (SELECT 1 FROM geocode_tx_address a
              WHERE a.run_id=r.run_id AND NOT EXISTS (SELECT 1 FROM geocode_tx_result result WHERE result.address_hash=a.address_hash))
          ORDER BY r.created_at DESC LIMIT 1`,
                  [state, signature],
                )
              ).rows[0];
            const runId =
              interrupted?.run_id ||
              (complete ? complete.run_id : undefined) ||
              `bootstrap-${state}-${randomUUID()}`;
            const options = { state, runId, dataDir },
              counties = await acquireCounties(db, dataDir, selectedState);
            if (complete) {
              const added = await refreshStatewideFallbacks(
                db,
                counties,
                runId,
              );
              return added
                ? { evidence: { fallbacks_added: added, requests: 0 } }
                : {
                    skipped: true,
                    reason: "all_selected_addresses_have_terminal_attempts",
                  };
            }
            if (!interrupted) {
              await createRun(db, runId, false, state);
              await db.query(
                "UPDATE geocode_tx_run SET scope_signature=$2 WHERE run_id=$1",
                [runId, signature],
              );
            }
            await stageStatewide(db, options);
            await refreshStatewideFallbacks(db, counties, runId);
            await db.transaction((tx) => publishStatewide(tx, runId));
            return { evidence: await geocodeStatewide(db, counties, options) };
          });
        },
        "unknown",
      );
    }
  return steps;
}

export async function runBootstrap(
  args: string[],
  openDatabase: (connectionString?: string) => Database,
  output: Output,
  directory = migrationsDirectory,
  events?: CoreEvents,
): Promise<number> {
  const runId = randomUUID();
  let options: BootstrapOptions;
  const stateFlag = args.indexOf("--states");
  const selectedStates =
    stateFlag < 0 ? [] : (args[stateFlag + 1] ?? "").split(",");
  // The reviewed SBE publication currently provides PY2026 only. Preserve the
  // existing explicit-year contract for federal or mixed-publication requests.
  if (
    !args.includes("--years") &&
    selectedStates.length &&
    selectedStates.every((state) => SBE_INDIVIDUAL_STATES.includes(state))
  )
    args = [...args, "--years", "2026"];
  try {
    options = parseBootstrapOptions(args);
  } catch {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  const database = () => {
    if (!db) {
      const connection = databaseUrl();
      const url = connection ? new URL(connection) : undefined;
      // Populated-database index upgrades can take minutes (e.g. migration 740).
      if (url && !url.searchParams.has("query_timeout"))
        url.searchParams.set("query_timeout", "3600000");
      db = openDatabase(url?.href);
    }
    return db;
  };
  try {
    const dataDir = importDataDirectory();
    const cached = await sbePublications(dataDir, false).catch(() => []);
    const scopes = [
      ...SBE_INDIVIDUAL_STATES.map((state) => ({ state, year: 2026 })),
      ...cached.filter((link) => link.year !== 2026 && link.state !== "OR"),
    ];
    const steps = await bootstrapPlan(
      options,
      database,
      dataDir,
      directory,
      scopes,
    );
    const summary = await executeBootstrap(steps, output, options.dryRun);
    code = summary.passed ? 0 : 1;
    for (const step of summary.steps)
      if (step.status === "failed")
        await readinessFailed(
          events,
          runId,
          `bootstrap.${step.id}`,
          step.reason,
        );
  } catch (error) {
    const fetchError = fetchFailure(error);
    output.error(
      fetchError
        ? `worker bootstrap failed: ${fetchError.message} (${fetchError.code})`
        : "worker bootstrap failed; check data cache metadata, options and database",
    );
    await readinessFailed(events, runId, "bootstrap", fetchError?.code);
    code = 1;
  } finally {
    try {
      await db?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}

/** `readiness.failed` for one failed step or plan: identifiers and codes only. */
async function readinessFailed(
  events: CoreEvents | undefined,
  runId: string,
  check: string,
  reason: string | undefined,
): Promise<void> {
  if (!events) return;
  const safeCheck = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(check)
    ? check
    : "bootstrap";
  await events.emit({
    type: "readiness.failed",
    idempotencyKey: `readiness.failed:${runId}:${safeCheck}`,
    payload: {
      check: safeCheck,
      reasonCode:
        reason && /^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(reason)
          ? reason
          : "bootstrap_failed",
    },
  });
}
