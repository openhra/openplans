import { readFile } from "node:fs/promises";
import taxonomyPlugin, {
  createTaxonomySource,
  CSV_MAX_BYTES,
  discoverRelease,
  expectedHash,
  filesPage,
  importTaxonomy,
  nuccHost,
  PAGE_MAX_BYTES,
  sourceId,
} from "@openplans/source-nucc-taxonomy";
import type { AcquiredRelease } from "@openplans/source-nucc-taxonomy";
import { createCmsMarketplaceSource } from "@openplans/source-cms-marketplace-api";
import type { PassThroughSource, Question } from "@openplans/plugin-sdk";
import { parse_hios } from "../domain/hios/index.js";
import { createRxnormRepository } from "../ingest/rxnorm/repository.js";
import type { Database } from "../db/database.js";
import { migrate, migrationsDirectory } from "../db/migrate.js";
import {
  cmsFallbackEnabled,
  fetchToCache,
  snapshotStore,
} from "../fetch/index.js";
import type { FetchOptions } from "../fetch/index.js";
import { runFeedSource } from "./sources/feed.js";
import type { FeedRunOptions } from "./sources/feed.js";
import { dataDirectory } from "../config/access.js";

/**
 * First-party source packages the core plugin loads itself (design 5.14). The NUCC taxonomy
 * feed is always loaded, so `worker ingest taxonomy` needs no plugin configuration. The CMS
 * Marketplace API pass-through source is loaded only while `OPENPLANS_CMS_FALLBACK=on`.
 */
export { discoverRelease, importTaxonomy };
export type { Release } from "@openplans/source-nucc-taxonomy";

interface WorkerOutput {
  out(message: string): void;
  error(message: string): void;
}
type FetchDependencies = Pick<FetchOptions, "lookup" | "transport" | "sleep">;

/**
 * `worker ingest taxonomy --accept-nucc-terms` on the feed lifecycle. The feed core checks the
 * source's host before it opens the database: the shipped manifest holds www.nucc.org as
 * terms-restricted, so without an operator manifest that clears it the command prints the
 * manifest's reason and writes nothing. On success it prints the same JSON line as before:
 * version, source URL, snapshot id, codes.
 */
export async function runTaxonomyIngest(
  args: string[],
  openDatabase: () => Database,
  output: WorkerOutput,
  directory = migrationsDirectory,
  options: FeedRunOptions = {},
): Promise<number> {
  const source = createTaxonomySource();
  let db: Database | undefined,
    code = 1;
  try {
    // The feed run's own summary names its receipt snapshot; this command's line stays the
    // import summary it has always printed.
    code = await runFeedSource(
      source,
      args,
      async () => {
        try {
          db = openDatabase();
          await migrate(db, directory);
          return db;
        } catch (error) {
          output.error(
            "worker ingest taxonomy failed; check NUCC source availability and cache",
          );
          throw error;
        }
      },
      {
        ...options,
        declaredHosts: taxonomyPlugin.manifest.capabilities?.network ?? [],
        output: { out: () => {}, error: (line) => output.error(line) },
      },
    );
    const imported = source.imported();
    if (code === 0 && imported) output.out(JSON.stringify(imported));
    else code = 1;
  } finally {
    try {
      await (db as Database | undefined)?.close();
    } catch {
      output.error("worker database shutdown failed");
      code = 1;
    }
  }
  return code;
}

/**
 * Fetches the current release outside a feed run, for `worker bootstrap --with-nucc-taxonomy`.
 * It reads the page and CSV through `fetchToCache` under the same source names as before.
 */
export async function acquireRelease(
  dataDir = dataDirectory(),
  dependencies: FetchDependencies = {},
): Promise<AcquiredRelease> {
  const page = await fetchToCache(filesPage, {
    ...dependencies,
    source: `${sourceId}-page`,
    dataDir,
    allowHosts: [nuccHost],
    expectedContent: "binary",
    maxBytes: PAGE_MAX_BYTES,
  });
  if (page.outcome === "not_modified")
    throw new Error("NUCC page body required");
  const release = discoverRelease(await readFile(page.path, "utf8"));
  const result = await fetchToCache(release.url, {
    ...dependencies,
    source: sourceId,
    dataDir,
    allowHosts: [nuccHost],
    expectedContent: "csv",
    maxBytes: CSV_MAX_BYTES,
    expectedSha256: await expectedHash(
      dataDir,
      sourceId,
      release.url,
      snapshotStore(dataDir),
    ),
  });
  if (result.outcome === "not_modified")
    throw new Error("NUCC CSV body required");
  return { ...release, path: result.path, metadata: result.metadata };
}

type PassThrough = PassThroughSource<Question, unknown>;
let cmsSource: PassThrough | undefined;

/**
 * Pass-through sources the core registers without plugin configuration. The CMS Marketplace API
 * source is the implicit entry for `OPENPLANS_CMS_FALLBACK=on`; it is read on every call, so
 * turning the switch off removes the source at once. A drug `NotCovered` is served only for an
 * RxCUI that resolves to an unsuppressed concept in the active local RxNorm release.
 */
export function implicitPassThroughSources(): readonly PassThrough[] {
  if (!cmsFallbackEnabled()) return [];
  cmsSource ??= createCmsMarketplaceSource({
    planBase: (id) => parse_hios(id).base,
    async knownRxcuis(db, rxcuis) {
      const rxnorm = createRxnormRepository(db);
      const known = new Set<string>();
      for (const id of rxcuis)
        if ((await rxnorm.conceptByRxcui(id)).some((c) => c.suppress === "N"))
          known.add(id);
      return known;
    },
  }) as unknown as PassThrough;
  return [cmsSource];
}
