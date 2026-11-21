import {
  requireImportYear,
  skipAnnualCommand,
  reportImportSkip,
  planAnnualWork,
} from "../data-window.js";
import type { Database } from "../../db/database.js";
import { migrate, migrationsDirectory } from "../../db/migrate.js";
import { ensureCachedPayload } from "../../fetch/index.js";
import {
  acquireArchive,
  cachedArchives,
  dataDirectory,
  discover,
  medicareSession,
} from "./acquire.js";
import type { AcquireContext, CachedArchive } from "./acquire.js";
import { importServiceArea } from "./county-codes.js";
import { importCrosswalk } from "./crosswalk.js";
import { importLandscape } from "./landscape.js";
import { importPbp } from "./pbp.js";
import type { ReleaseReport } from "./release.js";
import { families, serviceAreaArchive } from "./sources.js";
import type { MedicareFamily } from "./sources.js";
import { importStars } from "./stars.js";
import {
  acquireSpuf,
  cachedSpuf,
  coreTables,
  importSpuf,
  largeTables,
  parseSpufUrl,
} from "./spuf.js";
import type { SpufKind, SpufTable } from "./spuf.js";

const usage =
  "Usage: worker ingest medicare acquire|import --year 2026|2027 [--family landscape|pbp|stars|crosswalk|service_area] [--service-area-month YYYY-MM]\n" +
  "       worker ingest medicare part-d acquire --url URL | import --kind quarterly|monthly [--tables t1,t2]";

/** Part D files: acquisition by catalog URL, import of the newest cached archive of a kind. */
export async function runPartD(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory: string,
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  if (args.filter((arg) => arg === "--dry-run").length > 1) {
    output.error(usage);
    return 1;
  }
  args = args.filter((arg) => arg !== "--dry-run");
  const [action, flag, value, tablesFlag, tablesValue] = args;
  const tables = (
    tablesFlag === "--tables" ? (tablesValue ?? "").split(",") : [...coreTables]
  ) as SpufTable[];
  const known = new Set<string>([...coreTables, ...largeTables]);
  if (
    action === "acquire" &&
    args.length === 3 &&
    flag === "--url" &&
    value &&
    parseSpufUrl(value)
  ) {
    const archive = parseSpufUrl(value)!;
    const work = planAnnualWork(
      `partd-${archive.kind}`,
      [archive.year],
      "medicare",
    );
    if (work.skipped.length || dryRun) {
      output.out(
        JSON.stringify({
          planned: work.years.map((year) => ({
            dataset: `partd-${archive.kind}`,
            year,
          })),
          skipped: work.skipped,
        }),
      );
      return 0;
    }
    const admission = medicareSession();
    if (!admission) {
      output.error(
        "worker ingest medicare part-d acquire needs OPENPLANS_ACCESS_MANIFEST with a reviewed data.cms.gov entry",
      );
      return 1;
    }
    try {
      const result = await acquireSpuf(parseSpufUrl(value)!, { admission });
      output.out(JSON.stringify({ url: value, outcome: result.outcome }));
      return 0;
    } catch {
      output.error(
        "worker ingest medicare part-d acquire failed; check the access manifest, robots and terms review",
      );
      return 1;
    }
  }
  if (
    action !== "import" ||
    !(args.length === 3 || (args.length === 5 && tablesFlag === "--tables")) ||
    flag !== "--kind" ||
    (value !== "quarterly" && value !== "monthly") ||
    tables.some((t) => !known.has(t))
  ) {
    output.error(usage);
    return 1;
  }
  let db: Database | undefined,
    code = 0;
  try {
    const dataDir = dataDirectory();
    const cached = (await cachedSpuf(value as SpufKind, dataDir))[0];
    if (!cached) throw new Error(`No cached ${value} Part D archive`);
    const work = planAnnualWork(
      `partd-${cached.archive.kind}`,
      [cached.archive.year],
      "medicare",
    );
    if (work.skipped.length || dryRun) {
      output.out(
        JSON.stringify({
          planned: work.years.map((year) => ({
            dataset: `partd-${cached.archive.kind}`,
            year,
          })),
          skipped: work.skipped,
        }),
      );
      return 0;
    }
    db = openDatabase();
    await migrate(db, directory);
    output.out(
      JSON.stringify(
        await importSpuf(
          db,
          await ensureCachedPayload(dataDir, cached),
          tables,
        ),
      ),
    );
  } catch (error) {
    output.error(
      `worker ingest medicare part-d import failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
    );
    code = 1;
  } finally {
    await db?.close().catch(() => {
      code = 1;
    });
  }
  return code;
}

interface Options {
  action: "acquire" | "import";
  year: number;
  family?: MedicareFamily;
  month?: string;
}
export function parseOptions(args: string[]): Options | null {
  const [action, ...rest] = args;
  if (action !== "acquire" && action !== "import") return null;
  const options: Partial<Options> = { action };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i],
      value = rest[i + 1];
    if (value === undefined) return null;
    if (flag === "--year" && /^20\d{2}$/.test(value))
      options.year = Number(value);
    else if (
      flag === "--family" &&
      (families as readonly string[]).includes(value)
    )
      options.family = value as MedicareFamily;
    else if (flag === "--service-area-month" && /^\d{4}-\d{2}$/.test(value))
      options.month = value;
    else return null;
  }
  if (!options.year) return null;
  return options as Options;
}

/** Network step: discovery pages and archives through one reviewed admission session. */
export async function acquireMedicare(
  options: Options,
  context: AcquireContext = {},
): Promise<CachedArchive[]> {
  requireImportYear("medicare", options.year, "medicare");
  const out: CachedArchive[] = [];
  const wanted = options.family ? [options.family] : families;
  for (const family of wanted) {
    if (family === "service_area") {
      if (!options.month) continue;
      for (const kind of ["pdp", "ma"] as const)
        out.push(
          await acquireArchive(
            serviceAreaArchive(kind, options.month),
            context,
          ),
        );
      continue;
    }
    out.push(
      await acquireArchive(
        await discover(family, options.year, context),
        context,
      ),
    );
  }
  return out;
}

/**
 * CMS publishes contract service-area files monthly, so a contract year can start before any file
 * dated in that year exists. Use the same year's newest release when cached, otherwise the newest
 * earlier one. A release dated after the contract year is never used. With nothing eligible,
 * nothing is chosen, and the Landscape import refuses for lack of a county map.
 */
export function serviceAreaFor(
  cached: readonly CachedArchive[],
  kind: "pdp" | "ma",
  contractYear: number,
): CachedArchive | undefined {
  // cachedArchives sorts by label, newest first, and labels are `<kind>-YYYY-MM`.
  return cached.find(
    (entry) =>
      entry.archive.label.startsWith(`${kind}-`) &&
      entry.archive.year <= contractYear,
  );
}

/** Offline step: the newest cached archive per family; service areas first (county map). */
export async function importMedicare(
  db: Database,
  options: Pick<Options, "year" | "family">,
  dataDir = dataDirectory(),
): Promise<ReleaseReport[]> {
  requireImportYear("medicare", options.year, "medicare");
  const reports: ReleaseReport[] = [];
  const wanted = options.family ? [options.family] : families;
  if (wanted.includes("service_area")) {
    const cached = await cachedArchives("service_area", dataDir);
    for (const kind of ["pdp", "ma"] as const) {
      const chosen = serviceAreaFor(cached, kind, options.year);
      if (chosen)
        reports.push({
          ...(await importServiceArea(
            db,
            await ensureCachedPayload(dataDir, chosen),
          )),
          serves_contract_year: options.year,
        });
    }
  }
  const importers: Partial<
    Record<
      MedicareFamily,
      (db: Database, cached: CachedArchive) => Promise<ReleaseReport>
    >
  > = {
    landscape: importLandscape,
    pbp: importPbp,
    stars: importStars,
    crosswalk: importCrosswalk,
  };
  for (const family of wanted) {
    const run = importers[family];
    if (!run) continue;
    const newest = (await cachedArchives(family, dataDir)).find(
      (entry) => entry.archive.year === options.year,
    );
    if (!newest)
      throw new Error(`No cached ${family} archive for ${options.year}`);
    reports.push(await run(db, await ensureCachedPayload(dataDir, newest)));
  }
  return reports;
}

export async function runMedicare(
  args: string[],
  openDatabase: () => Database,
  output: { out(message: string): void; error(message: string): void },
  directory = migrationsDirectory,
): Promise<number> {
  if (args[0] === "part-d")
    return runPartD(args.slice(1), openDatabase, output, directory);
  const options = parseOptions(args);
  if (!options) {
    output.error(usage);
    return 1;
  }
  if (skipAnnualCommand("medicare", options.year, output, "medicare")) return 0;
  if (options.action === "acquire") {
    try {
      const admission = medicareSession();
      if (!admission) {
        output.error(
          "worker ingest medicare acquire needs OPENPLANS_ACCESS_MANIFEST with a reviewed www.cms.gov entry",
        );
        return 1;
      }
      const acquired = await acquireMedicare(options, { admission });
      output.out(
        JSON.stringify(
          acquired.map((entry) => ({
            family: entry.archive.family,
            url: entry.archive.url,
            sha256: entry.metadata.sha256,
            bytes: entry.metadata.bytes,
          })),
        ),
      );
      return 0;
    } catch (error) {
      if (reportImportSkip(error, output)) return 0;
      output.error(
        "worker ingest medicare acquire failed; check the access manifest, robots and terms review, and cache",
      );
      return 1;
    }
  }
  let db: Database | undefined,
    code = 0;
  try {
    db = openDatabase();
    await migrate(db, directory);
    output.out(JSON.stringify(await importMedicare(db, options)));
  } catch (error) {
    // Messages name the file family or layout check, never source bytes or credentials.
    output.error(
      `worker ingest medicare import failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`,
    );
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
