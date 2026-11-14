import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../../src/db/database.js";
import type { CachedArchive } from "../../../src/ingest/medicare/acquire.js";
import * as releaseModule from "../../../src/ingest/medicare/release.js";
import {
  publisherReleaseDate,
  sourceIds,
} from "../../../src/ingest/medicare/sources.js";
import type { Archive } from "../../../src/ingest/medicare/sources.js";
import { plantMutantFile } from "../../mutant-file.js";
import { migratedTemplate } from "../../pglite.js";

type ImportRelease = typeof releaseModule.importRelease;

const releaseFile = new URL(
  "../../../src/ingest/medicare/release.ts",
  import.meta.url,
);

// Synthetic archive bytes and fetch metadata; the file names follow the real CMS patterns.
const fetchedAt = "2026-11-14T15:00:00.000Z";
const archives: Record<string, Archive> = {
  pbp: {
    family: "pbp",
    year: 2026,
    url: "https://www.cms.gov/files/zip/pbp-benefits-2026.zip",
    label: "2026",
  },
  landscape: {
    family: "landscape",
    year: 2026,
    url: "https://www.cms.gov/files/zip/cy2026-landscape-202609.zip",
    label: "202609",
  },
};

describe("Medicare release publisher date", () => {
  let template: Awaited<ReturnType<typeof migratedTemplate>>;
  let directory: string;
  beforeAll(async () => {
    template = await migratedTemplate();
    directory = await mkdtemp(join(tmpdir(), "medicare-publisher-date-"));
  }, 60_000);
  afterAll(async () => {
    await template?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function cachedArchive(
    archive: Archive,
    lastModified: string | null,
  ): Promise<CachedArchive> {
    const bytes = Buffer.from(`synthetic ${archive.url} ${lastModified}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const path = join(directory, `${sha256}.zip`);
    await writeFile(path, bytes);
    return {
      archive,
      path,
      metadata: {
        snapshot_id: sha256,
        source: sourceIds[archive.family],
        url: archive.url,
        final_url: archive.url,
        redirect_chain: [],
        status: 200,
        content_type: "application/zip",
        etag: null,
        last_modified: lastModified,
        sha256,
        bytes: bytes.length,
        fetched_at: fetchedAt,
      },
    };
  }

  /** Imports one synthetic release and reads back the snapshot and release dates. */
  async function imported(
    importRelease: ImportRelease,
    archive: Archive,
    lastModified: string | null,
  ) {
    const db: Database = await template.fresh();
    try {
      const report = await importRelease(
        db,
        await cachedArchive(archive, lastModified),
        "member.csv",
        async () => ({ rows: 0 }),
      );
      const { rows } = await db.query<{
        publisher_date: string | null;
        as_of: string;
      }>(
        `SELECT s.publisher_updated_at::date::text AS publisher_date,r.as_of::text AS as_of
         FROM snapshot s JOIN medicare_release r USING(snapshot_id) WHERE s.snapshot_id=$1`,
        [report.snapshot_id],
      );
      return rows[0]!;
    } finally {
      await db.close();
    }
  }

  it("takes the date from the label, then Last-Modified, and never from the fetch", () => {
    expect(publisherReleaseDate("202609", null)).toBe("2026-09-01");
    expect(publisherReleaseDate("oct-8-2026", null)).toBe("2026-10-08");
    expect(publisherReleaseDate("pdp-2026-10", null)).toBe("2026-10-01");
    // A label date wins over Last-Modified.
    expect(
      publisherReleaseDate("202609", "Tue, 21 Oct 2025 08:00:00 GMT"),
    ).toBe("2026-09-01");
    // A year-only label is a contract year, not a release date.
    expect(publisherReleaseDate("2026", "Tue, 21 Oct 2025 08:00:00 GMT")).toBe(
      "2025-10-21",
    );
    expect(publisherReleaseDate("2026", null)).toBeNull();
    expect(publisherReleaseDate("2026", "")).toBeNull();
    expect(publisherReleaseDate("2026", "not a date")).toBeNull();
  });

  it("stores the label date when the file name carries one", async () => {
    const row = await imported(
      releaseModule.importRelease,
      archives.landscape!,
      null,
    );
    expect(row).toEqual({ publisher_date: "2026-09-01", as_of: "2026-09-01" });
  });

  it("stores the Last-Modified date when the file name has none", async () => {
    const row = await imported(
      releaseModule.importRelease,
      archives.pbp!,
      "Tue, 21 Oct 2025 08:00:00 GMT",
    );
    expect(row).toEqual({ publisher_date: "2025-10-21", as_of: "2025-10-21" });
  });

  /** The check both the real import and the mutant face: no signal must mean null. */
  async function storesUnknown(importRelease: ImportRelease) {
    const row = await imported(importRelease, archives.pbp!, null);
    return row.publisher_date === null;
  }

  it("stores null with no dated file name and no Last-Modified", async () => {
    const row = await imported(
      releaseModule.importRelease,
      archives.pbp!,
      null,
    );
    // The release row still needs a date to order by; the snapshot keeps the unknown.
    expect(row).toEqual({ publisher_date: null, as_of: "2026-11-14" });
    expect(await storesUnknown(releaseModule.importRelease)).toBe(true);
  });

  it("planted mutant: storing the fetch day as the publisher date is caught", async () => {
    const source = await readFile(releaseFile, "utf8");
    const anchor = `      metadata.fetched_at,
      published,
      metadata.status,`;
    if (!source.includes(anchor)) throw new Error("mutant anchor missing");
    const mutant = await plantMutantFile(
      releaseFile,
      source.replace(
        anchor,
        `      metadata.fetched_at,
      published ?? metadata.fetched_at.slice(0, 10),
      metadata.status,`,
      ),
    );
    try {
      const planted = (await import(mutant.path)) as typeof releaseModule;
      expect(await storesUnknown(planted.importRelease)).toBe(false);
      const row = await imported(planted.importRelease, archives.pbp!, null);
      expect(row.publisher_date).toBe("2026-11-14");
    } finally {
      await mutant.cleanup();
    }
  });
});
