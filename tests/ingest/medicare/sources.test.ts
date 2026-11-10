import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSasLayout,
  assertHeaderMatches,
} from "../../../src/ingest/medicare/layout.js";
import { namedFields } from "../../../src/ingest/medicare/tabular.js";
import {
  acquireArchive,
  cachedArchives,
} from "../../../src/ingest/medicare/acquire.js";
import {
  discoverArchive,
  discoveryPage,
  labelDate,
  parseArchiveUrl,
  serviceAreaArchive,
} from "../../../src/ingest/medicare/sources.js";
import {
  fixtureArchives,
  fixtureDirectory,
  fixtureTransport,
  lookup,
} from "./helpers.js";

// Link markup as published on the CMS listing pages, 2026-11-09.
const landscapePage = `<a href="/files/zip/cy2006-cy2025-landscape-files.zip">archive</a>
<a href="/files/zip/cy2026-landscape-202609.zip">2026</a><a href="/files/zip/cy2027-landscape-202611.zip">2027</a>
<a href="/files/zip/cy2027-landscape-202610.zip">old</a><a href="/files/zip/cy2027-landscape-202612.zip?x=1">query</a>
<a href="https://evil.example/files/zip/cy2027-landscape-202699.zip">other host</a>`;

describe("CMS Medicare discovery", () => {
  it("picks the newest revision for the year and never a query, fragment or other host", () => {
    expect(discoverArchive("landscape", 2027, landscapePage)).toEqual({
      family: "landscape",
      year: 2027,
      url: "https://www.cms.gov/files/zip/cy2027-landscape-202611.zip",
      label: "202611",
    });
    expect(
      discoverArchive(
        "stars",
        2027,
        '<a href="/files/zip/2027-star-ratings-data-tables-oct-8-2026.zip">x</a>',
      ).label,
    ).toBe("oct-8-2026");
    expect(() => discoverArchive("pbp", 2030, landscapePage)).toThrow(
      "No pbp archive",
    );
  });
  it("discovery pages and archive URLs never carry a query string (robots Disallow: /*?)", () => {
    for (const family of ["landscape", "pbp", "stars", "crosswalk"] as const)
      for (const year of [2026, 2027])
        expect(discoveryPage(family, year)).not.toMatch(/[?#]/);
    expect(() => discoveryPage("service_area", 2026)).toThrow("query strings");
    expect(serviceAreaArchive("pdp", "2026-10").url).toBe(
      "https://www.cms.gov/files/zip/pdp-contract-service-area-state-county-october-2026.zip",
    );
    expect(() => serviceAreaArchive("ma", "2026-13")).toThrow();
  });
  it("recovers family, year and release dates from archive URLs", () => {
    expect(
      parseArchiveUrl(
        "https://www.cms.gov/files/zip/ma-contract-service-area-state-county-october-2026.zip",
      ),
    ).toMatchObject({
      family: "service_area",
      year: 2026,
      label: "ma-2026-10",
    });
    expect(
      parseArchiveUrl(
        "https://www.cms.gov/files/zip/pbp-benefits-2027.zip?a=1",
      ),
    ).toBeNull();
    expect(labelDate("202609", "x")).toBe("2026-09-01");
    expect(labelDate("oct-8-2026", "x")).toBe("2026-10-08");
    expect(labelDate("pdp-2026-10", "x")).toBe("2026-10-01");
    expect(labelDate("2026", "2025-10-28")).toBe("2025-10-28");
  });
  it("caches archives by hash and reuses them without a second request", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "medicare-acquire-"));
    const calls: string[] = [];
    try {
      const archives = await fixtureArchives();
      const url = "https://www.cms.gov/files/zip/cy2026-landscape-202609.zip";
      const deps = { lookup, transport: fixtureTransport(archives, calls) };
      const first = await acquireArchive(parseArchiveUrl(url)!, {
        dataDir,
        dependencies: deps,
      });
      const second = await acquireArchive(parseArchiveUrl(url)!, {
        dataDir,
        dependencies: deps,
      });
      expect(second.path).toBe(first.path);
      expect(calls).toEqual([url]);
      expect(await readFile(first.path)).toEqual(archives.get(url));
      expect(
        (await cachedArchives("landscape", dataDir)).map(
          (entry) => entry.archive.label,
        ),
      ).toEqual(["202609"]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("PBP layouts", () => {
  it("reads the real planArea layout with its repeated segment_id and informat modifiers", async () => {
    const layout = parseSasLayout(
      await readFile(join(fixtureDirectory, "pbp/planArea.sas"), "latin1"),
    );
    expect(layout.columns.filter((name) => name === "segment_id")).toHaveLength(
      2,
    );
    expect(layout.types.county_code).toEqual({ kind: "char", length: 5 });
    const modified = parseSasLayout(
      "length a $1;\ninput a b : ?? comma8. c;\n",
    );
    expect(modified.columns).toEqual(["a", "b", "c"]);
    expect(modified.types.b).toEqual({ kind: "num", length: 8 });
    expect(() => assertHeaderMatches(["a", "d"], modified, "t")).toThrow(
      "SAS layout",
    );
  });
  it("accepts a repeated column only when every copy agrees", () => {
    expect(namedFields(["a", "b", "a"], ["1", "2", "1"], 2)).toEqual({
      a: "1",
      b: "2",
    });
    expect(() => namedFields(["a", "b", "a"], ["1", "2", "3"], 2)).toThrow(
      "Repeated column a",
    );
  });
});
