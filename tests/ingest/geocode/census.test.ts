import { it, expect } from "vitest";
import { Readable } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireBatch,
  geographyEndpoint,
} from "../../../src/ingest/geocode/census.js";
import type { Transport } from "../../../src/fetch/index.js";
it("reuses request-keyed raw snapshot; respects Retry-After and preserves CSV bytes", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openplans-census-cache-"));
  let calls = 0;
  const sleeps: number[] = [];
  const transport: Transport = async () => {
    calls++;
    return calls === 1
      ? {
          status: 429,
          headers: { "retry-after": "2" },
          body: Readable.from("busy"),
        }
      : {
          status: 200,
          headers: { "content-type": "text/csv" },
          body: Readable.from('"1","input","No_Match"\n'),
        };
  };
  const options = {
    dataDir,
    transport,
    lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  try {
    const first = await acquireBatch(
      "1,901 Bagby St,Houston,TX,77002\n",
      options,
    );
    expect(first.requests).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(await readFile(first.file.path, "utf8")).toContain("No_Match");
    const again = await acquireBatch(
      "1,901 Bagby St,Houston,TX,77002\n",
      options,
    );
    expect(again.requests).toBe(0);
    expect(calls).toBe(2);
    expect(again.file.path).toBe(first.file.path);
    await expect(
      acquireBatch("1,x,x,TX,77002\n".repeat(10001), options),
    ).rejects.toThrow("1–10000");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("keeps geography/vintage request identities separate from cached locations and forbids endpoint redirects", async () => {
  const dataDir = await mkdtemp(
      join(tmpdir(), "openplans-census-geographies-"),
    ),
    urls: string[] = [];
  const options = {
    dataDir,
    lookup: async () => [{ address: "8.8.8.8", family: 4 as const }],
    transport: async (url: URL) => {
      urls.push(url.href);
      return {
        status: 200,
        headers: { "content-type": "text/csv" },
        body: Readable.from('"1","input","No_Match"\n'),
      };
    },
  };
  const csv = "1,901 Bagby St,Houston,TX,77002\n";
  try {
    expect((await acquireBatch(csv, options)).requests).toBe(1);
    expect(
      (await acquireBatch(csv, { ...options, geographies: true })).requests,
    ).toBe(1);
    expect(urls[1]).toBe(geographyEndpoint);
    expect(
      (
        await acquireBatch(csv, {
          ...options,
          geographies: true,
          transport: async () => {
            throw new Error("Network forbidden");
          },
        })
      ).requests,
    ).toBe(0);
    await expect(
      acquireBatch("1,changed,Houston,TX,77002\n", {
        ...options,
        geographies: true,
        transport: async () => ({
          status: 302,
          headers: {
            location:
              "https://geocoding.geo.census.gov/geocoder/locations/addressbatch",
          },
          body: Readable.from(""),
        }),
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
it("negative control: HTML success responses cannot be mistaken for unmatched addresses", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openplans-census-html-"));
  try {
    await expect(
      acquireBatch("1,x,x,TX,77002\n", {
        dataDir,
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        transport: async () => ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: Readable.from("<html>request rejected</html>"),
        }),
      }),
    ).rejects.toMatchObject({ code: "html_error_page" });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
