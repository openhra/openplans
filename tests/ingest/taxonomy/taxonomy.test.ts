import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../../../src/db/migrate.js";
import { importTaxonomy } from "../../../src/ingest/taxonomy/import.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

describe("NUCC taxonomy import", () => {
  const db = testDatabase(new PGlite());
  const path = fileURLToPath(
    new URL("../../fixtures/taxonomy/nucc.csv", import.meta.url),
  );
  let core: Awaited<ReturnType<typeof coreMigrations>>;
  let bytes: Buffer, sha256: string;
  beforeAll(async () => {
    bytes = await readFile(path);
    sha256 = (await import("node:crypto"))
      .createHash("sha256")
      .update(bytes)
      .digest("hex");
    core = await coreMigrations();
    await migrate(db, core.directory);
  });
  afterAll(async () => {
    await db.close();
    await core.cleanup();
  });

  it("imports published classification/display names and preserves version provenance", async () => {
    const result = await importTaxonomy(db, {
      version: "26.1",
      url: "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv",
      path,
      metadata: {
        snapshot_id: sha256,
        source: "nucc-provider-taxonomy",
        url: "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv",
        final_url:
          "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv",
        redirect_chain: [],
        status: 200,
        content_type: "text/csv",
        etag: null,
        last_modified: null,
        sha256,
        bytes: bytes.length,
        fetched_at: "2026-11-07T00:00:00Z",
      },
    });
    expect(result).toMatchObject({ version: "26.1", codes: 3 });
    const row = (
      await db.query(`SELECT * FROM provider_taxonomy WHERE code='207Q00000X'`)
    ).rows[0];
    expect(row).toMatchObject({
      classification: "Family Medicine",
      display_name: "Family Medicine Physician",
      specialization: null,
      version: "26.1",
    });
  });

  it("discovers the version attached to the current official download link", async () => {
    const { discoverRelease } =
      await import("../../../src/ingest/taxonomy/acquire.js");
    const page =
      '<p>current</p><a href="/images/stories/CSV/nucc_taxonomy_261.csv">Version 26.1 7/1/26</a>' +
      '<a href="/images/stories/CSV/nucc_taxonomy_251.csv">Version 25.1</a>';
    expect(discoverRelease(page)).toMatchObject({
      version: "26.1",
      url: "https://www.nucc.org/images/stories/CSV/nucc_taxonomy_261.csv",
    });
  });
});
