import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../../../src/api/app.js";
import { migrate } from "../../../src/db/migrate.js";
import { importPufs } from "../../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../../src/ingest/puf/import-source.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { ingestRatingRules } from "../../../src/ingest/rating-rules/index.js";
import { importRxnorm } from "../../../src/ingest/rxnorm/import.js";
import { fixtureFiles as geoFiles } from "../../ingest/geo/helpers.js";
import { fixture, zip, metadata } from "../../ingest/rxnorm/helpers.js";
import { writeFile } from "node:fs/promises";
import { coreMigrations, testDatabase } from "../../pglite.js";

export const TOKEN = "synthetic-facade-test-token";
export const BASE = "/compat/v1";
export const searchBody = (extra = {}) => ({
  fips_code: "48201",
  market: "individual",
  applicants: [{ age: 35, smoker: false, child: false }],
  enrollment_date: "2026-01-01",
  per_page: 1000,
  ...extra,
});
export const headers = {
  "content-type": "application/json",
  "X-Api-Key": TOKEN,
};

export async function setup() {
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
  const db = testDatabase(new PGlite()),
    core = await coreMigrations(),
    directory = await mkdtemp(join(tmpdir(), "openplans-facade-"));
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  const root = fileURLToPath(new URL("./fixtures/", import.meta.url));
  const manifest = JSON.parse(
    await readFile(join(root, "provenance.json"), "utf8"),
  );
  const files = [];
  for (const kind of IMPORT_KINDS) {
    let path = join(root, `${kind}.csv`);
    const file = manifest.files.find((f: { kind: string }) => f.kind === kind);
    let bytes: Buffer;
    if (file.parts?.length) {
      const parts: Buffer[] = [];
      for (const part of file.parts) {
        const data = await readFile(join(root, part.file));
        if (createHash("sha256").update(data).digest("hex") !== part.sha256)
          throw new Error("Fixture part hash mismatch");
        parts.push(parts.length ? data.subarray(data.indexOf(10) + 1) : data);
      }
      bytes = Buffer.concat(parts);
      path = join(directory, `${kind}.csv`);
      await writeFile(path, bytes);
    } else bytes = await readFile(path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== file.cut_sha256) throw new Error("Fixture hash mismatch");
    files.push({
      kind,
      path,
      sha256,
      bytes: bytes.length,
      url: file.url,
      retrievedAt: "2026-11-07T07:33:40.115Z",
      format: "csv" as const,
    });
  }
  const report = await importPufs(db, {
    year: 2026,
    state: "TX",
    files,
    dataDir: directory,
  });
  if (report.status !== "ACTIVE")
    throw new Error(`Fixture import failed: ${JSON.stringify(report)}`);
  await ingestRatingRules(db);
  const archive = zip(await fixture()),
    path = join(directory, "rxnorm-real-cut.zip");
  await writeFile(path, archive);
  await importRxnorm(db, {
    version: "2026-11-02",
    path,
    metadata: metadata(archive),
  });
  return {
    db,
    app: createApp(db, { premiumToken: TOKEN }),
    report,
    close: async () => {
      await db.close();
      await core.cleanup();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
