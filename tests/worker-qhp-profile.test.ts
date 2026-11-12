import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { fetchToCache } from "../src/fetch/index.js";
import {
  preparedQhpFetcher,
  preparedQhpOutcome,
  readQhpProfile,
} from "../src/worker/qhp-profile.js";

describe("prepared QHP profile", () => {
  it("reuses pinned bytes across issuer/year cache names and rejects missing or quarantined inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openplans-prepared-qhp-"));
    try {
      const url = "https://prepared.example/index.json";
      const cached = await fetchToCache(url, {
        dataDir: directory,
        source: "qhp-11111-2026-index",
        allowHosts: ["prepared.example"],
        expectedContent: "json",
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        transport: async () => ({
          status: 200,
          headers: {},
          body: Readable.from(['{"provider_urls":[]}']),
        }),
      });
      if (cached.outcome === "not_modified")
        throw new Error("synthetic cache seed failed");
      const path = join(directory, "inputs.json");
      const input = {
        schema: 1,
        providers: true,
        drugs: false,
        taxonomy_names: false,
        scopes: [{ state: "TX", year: 2027 }],
        provider_feeds: [
          { issuer: "22222", state: "TX", set: "qhp-11111-2026-index" },
        ],
        feed_raw: [
          {
            source: "qhp-11111-2026-index",
            sha256: cached.metadata.sha256,
            bytes: cached.metadata.bytes,
            url,
          },
        ],
      };
      await writeFile(path, JSON.stringify(input));
      const profile = await readQhpProfile(path);
      const fetcher = preparedQhpFetcher(profile);
      const options = {
        dataDir: directory,
        source: "qhp-22222-2027-index",
        allowHosts: ["prepared.example"],
        expectedContent: "json" as const,
      };
      expect(await fetcher(url, options)).toMatchObject({
        outcome: "reused",
        path: cached.path,
      });
      await expect(
        fetcher("https://prepared.example/unlisted.json", options),
      ).rejects.toMatchObject({ code: "cache_error" });
      // Disposable mutants never become downloads or admitted snapshots.
      profile.feed_raw[0]!.bytes++;
      await expect(fetcher(url, options)).rejects.toMatchObject({
        code: "cache_error",
      });
      profile.feed_raw[0]!.bytes--;
      const hash = profile.feed_raw[0]!.sha256;
      profile.feed_raw[0]!.sha256 = "0".repeat(64);
      await expect(fetcher(url, options)).rejects.toThrow();
      profile.feed_raw[0]!.sha256 = hash;
      await writeFile(
        join(directory, "raw", input.feed_raw[0]!.source, "QUARANTINE.json"),
        JSON.stringify({ snapshots: [cached.metadata.snapshot_id] }),
      );
      await expect(fetcher(url, options)).rejects.toMatchObject({
        code: "admission_denied",
      });
      input.provider_feeds[0]!.set = "qhp-99999-2026-index";
      await writeFile(path, JSON.stringify(input));
      await expect(readQhpProfile(path)).rejects.toThrow(
        "Invalid prepared QHP profile pins",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts source quarantine with a reason while retaining operational failures", () => {
    expect(preparedQhpOutcome({ completeness: "complete" })).toBe(true);
    expect(
      preparedQhpOutcome({
        status: "QUARANTINED",
        completeness: "partial",
        reason: "invalid_source_records",
      }),
    ).toBe(true);
    expect(
      preparedQhpOutcome({
        status: "QUARANTINED",
        completeness: "unknown",
        reason: "index_not_cached",
      }),
    ).toBe(true);
    expect(
      preparedQhpOutcome({
        status: "QUARANTINED",
        completeness: "failed",
        reason: "issuer_import_failed",
      }),
    ).toBe(false);
    expect(
      preparedQhpOutcome({ status: "QUARANTINED", completeness: "unknown" }),
    ).toBe(false);
    expect(
      preparedQhpOutcome({
        status: "QUARANTINED",
        completeness: "partial",
        reason: "invalid_source_records,run_budget_exceeded",
      }),
    ).toBe(false);
  });

  // Synthetic outcomes: only an ACTIVE set whose sole partial reason is rejected records passes.
  const partialCases: [string, Record<string, unknown>, boolean][] = [
    [
      "ACTIVE partial, rejected records only",
      {
        status: "ACTIVE",
        completeness: "partial",
        reason: "source_records_rejected",
      },
      true,
    ],
    [
      "ACTIVE partial, another reason",
      {
        status: "ACTIVE",
        completeness: "partial",
        reason: "catalog_plan_year_not_in_definitions",
      },
      false,
    ],
    [
      "ACTIVE partial, rejected records plus another reason",
      {
        status: "ACTIVE",
        completeness: "partial",
        reason: "catalog_plan_year_not_in_definitions,source_records_rejected",
      },
      false,
    ],
    [
      "ACTIVE partial, rejected records plus an operational failure",
      {
        status: "ACTIVE",
        completeness: "partial",
        reason: "run_budget_exceeded,source_records_rejected",
      },
      false,
    ],
    [
      "ACTIVE partial without a reason",
      { status: "ACTIVE", completeness: "partial" },
      false,
    ],
    [
      "ACTIVE partial with an empty reason",
      { status: "ACTIVE", completeness: "partial", reason: "" },
      false,
    ],
    [
      "ACTIVE failed, rejected records",
      {
        status: "ACTIVE",
        completeness: "failed",
        reason: "source_records_rejected",
      },
      false,
    ],
    [
      "status missing, partial, rejected records",
      { completeness: "partial", reason: "source_records_rejected" },
      false,
    ],
  ];

  it.each(partialCases)("partial outcome: %s", (_name, report, expected) => {
    expect(preparedQhpOutcome(report)).toBe(expected);
  });

  it("planted mutant that accepts any partial is caught", () => {
    const mutant = (report: Record<string, unknown>) =>
      report.completeness === "partial" || preparedQhpOutcome(report);
    const caught = partialCases.filter(
      ([, report, expected]) => mutant(report) !== expected,
    );
    expect(caught.map(([name]) => name)).toEqual([
      "ACTIVE partial, another reason",
      "ACTIVE partial, rejected records plus another reason",
      "ACTIVE partial, rejected records plus an operational failure",
      "ACTIVE partial without a reason",
      "ACTIVE partial with an empty reason",
      "status missing, partial, rejected records",
    ]);
  });
});
