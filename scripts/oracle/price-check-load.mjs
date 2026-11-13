#!/usr/bin/env node
/**
 * Loads the price-check database: the year's PBP release and the sample subset of the newest
 * cached quarterly Part D archive, with its pricing and dispensing-fee tables. Cache only.
 * `build-price-check-db.sh` runs it; DATABASE_URL names the database.
 *
 * Usage: DATABASE_URL=... node scripts/oracle/price-check-load.mjs --year 2026 --work DIR
 *
 * It cuts the subset with price-check-subset.py into DIR (reused when the archive and cases are
 * unchanged), then imports through the application's importers, which do nothing for a release
 * already loaded from the same bytes. The subset is stored as its own snapshot: its SHA-256 is
 * the subset's, and DIR/subset.json maps it to the CMS archive and the hash of each member read.
 * DIR/load.json records the import outcomes, the elapsed time and the database size.
 */
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: DATABASE_URL=... node scripts/oracle/price-check-load.mjs --year 2026 --work DIR";
const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const year = Number(option("--year"));
const work = option("--work");
if (year !== 2026 || !work || args.length !== 4 || !process.env.DATABASE_URL) {
  console.error(usage);
  process.exit(2);
}
const here = fileURLToPath(new URL(".", import.meta.url));
const casesFile = join(here, "medicare-part-d-price-cases.json");
const started = Date.now();

const { cachedSpuf, coreTables, importSpuf } =
  await import("../../dist/ingest/medicare/spuf.js");
const { ensureCachedPayload } = await import("../../dist/fetch/index.js");
const { dataDirectory } = await import("../../dist/ingest/medicare/acquire.js");
const cached = (await cachedSpuf("quarterly")).find(
  (item) => item.archive.year === year,
);
if (!cached) {
  console.error(`No cached quarterly Part D archive for ${year}`);
  process.exit(1);
}
const { cases } = JSON.parse(await readFile(casesFile, "utf8"));
if (cases.some((item) => item.contract_year !== year)) {
  console.error(`The price-check sample is not all ${year} cases`);
  process.exit(1);
}
// Verifies the cached bytes against the cache's recorded size and SHA-256.
const source = await ensureCachedPayload(dataDirectory(), cached);
const cut = spawnSync(
  "python3",
  [
    "-I",
    join(here, "price-check-subset.py"),
    source.path,
    "--cases",
    casesFile,
    "--output",
    work,
    "--source-sha256",
    cached.metadata.sha256,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (cut.status !== 0) {
  console.error("price-check-subset.py failed");
  process.exit(1);
}
const manifest = JSON.parse(await readFile(join(work, "subset.json"), "utf8"));
const subsetPath = join(work, "subset.zip");
const input = {
  ...cached,
  path: subsetPath,
  metadata: {
    ...cached.metadata,
    sha256: manifest.subset.sha256,
    bytes: (await stat(subsetPath)).size,
  },
};

const { createDatabase } = await import("../../dist/db/database.js");
const { migrate } = await import("../../dist/db/migrate.js");
const { importMedicare } =
  await import("../../dist/ingest/medicare/command.js");
const db = createDatabase(process.env.DATABASE_URL);
let code = 0;
try {
  await migrate(db);
  const pbp = await importMedicare(db, { year, family: "pbp" });
  const spuf = await importSpuf(db, input, [
    ...coreTables,
    "pricing",
    "dispensing_fee",
  ]);
  const size = (
    await db.query("SELECT pg_database_size(current_database())::bigint AS b")
  ).rows[0].b;
  const report = {
    year,
    source_archive: manifest.source,
    subset: manifest.subset,
    members: manifest.members.map(({ member, sha256, action }) => ({
      member,
      sha256,
      action,
    })),
    pbp: pbp.map(({ snapshot_id, outcome }) => ({ snapshot_id, outcome })),
    spuf: {
      snapshot_id: spuf.snapshot_id,
      outcome: spuf.outcome,
      counts: spuf.counts,
    },
    database_bytes: Number(size),
    elapsed_ms: Date.now() - started,
  };
  await writeFile(
    join(work, "load.json"),
    `${JSON.stringify(report, null, 1)}\n`,
  );
  console.error(
    `price-check database: PBP ${pbp.map((r) => r.outcome).join(",")}, Part D ${spuf.outcome}, ${report.database_bytes} bytes, ${report.elapsed_ms} ms`,
  );
} catch (error) {
  console.error(`price-check load failed: ${error.message}`);
  code = 1;
} finally {
  await db.close();
}
process.exit(code);
