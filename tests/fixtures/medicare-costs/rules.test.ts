import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PARAMETERS,
  YEARS,
  documentErrors,
  documentsFile,
  dollarsToCents,
  oracleErrors,
  oraclesFile,
  parameterErrors,
  parametersFile,
  pinErrors,
} from "../../../scripts/medicare-costs/check.mjs";

interface Citation {
  document: string;
  section: string;
  page?: number;
  quote: string;
}
interface Parameter {
  value: number;
  citations: Citation[];
}
interface Doc {
  id: string;
  url: string;
  sha256: string;
  bytes: number;
  contentType: string;
}
interface Manifest {
  schemaVersion: number;
  cacheSource: string;
  documents: Doc[];
}
interface Parameters {
  schemaVersion: number;
  years: Record<string, Record<string, Parameter>>;
}

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8")) as T;
const manifest = read<Manifest>(documentsFile);
const parameters = read<Parameters>(parametersFile);
const oracles = read<Record<string, unknown>>(oraclesFile);
const copy = <T>(value: T): T => structuredClone(value);

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("pinned Part D rule parameters", () => {
  it("pass the structural, citation and table checks", () => {
    expect(documentErrors(manifest)).toEqual([]);
    expect(parameterErrors(parameters, manifest)).toEqual([]);
    expect(oracleErrors(parameters, oracles, manifest)).toEqual([]);
    const run = spawnSync(
      process.execPath,
      ["scripts/medicare-costs/check.mjs"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("PASS");
  });

  it("covers exactly 2026 and 2027 and cites a pinned document for every value", () => {
    expect(Object.keys(parameters.years).sort()).toEqual(YEARS);
    const ids = new Set(manifest.documents.map((doc) => doc.id));
    for (const year of YEARS)
      for (const name of PARAMETERS) {
        const item = parameters.years[year]![name]!;
        expect(item.citations.length, `${year}.${name}`).toBeGreaterThan(0);
        for (const citation of item.citations) {
          expect(ids.has(citation.document), `${year}.${name}`).toBe(true);
          expect(citation.section.trim(), `${year}.${name}`).not.toBe("");
          expect(citation.quote.trim(), `${year}.${name}`).not.toBe("");
        }
      }
  });

  it("holds the finalized defined standard figures", () => {
    const value = (year: string, name: string) =>
      parameters.years[year]![name]!.value;
    expect([
      value("2026", "standardDeductibleCents"),
      value("2027", "standardDeductibleCents"),
    ]).toEqual([61500, 70000]);
    expect([
      value("2026", "outOfPocketThresholdCents"),
      value("2027", "outOfPocketThresholdCents"),
    ]).toEqual([210000, 240000]);
    for (const year of YEARS) {
      expect(value(year, "deductibleCostSharingBasisPoints")).toBe(10000);
      expect(value(year, "initialCoverageCostSharingBasisPoints")).toBe(2500);
      expect(value(year, "catastrophicCostSharingBasisPoints")).toBe(0);
    }
    expect(dollarsToCents("$2,400")).toBe(240000);
    expect(dollarsToCents("2400")).toBeNull();
  });

  it("fails a missing citation, an unknown document or a PDF citation without a page", () => {
    const uncited = copy(parameters);
    uncited.years["2027"]!.outOfPocketThresholdCents!.citations = [];
    expect(parameterErrors(uncited, manifest)).toContain(
      "2027.outOfPocketThresholdCents: needs at least one citation",
    );
    const unknown = copy(parameters);
    unknown.years["2026"]!.standardDeductibleCents!.citations[0]!.document =
      "C99";
    expect(parameterErrors(unknown, manifest).join("\n")).toMatch(
      /unknown document C99/,
    );
    const pageless = copy(parameters);
    delete pageless.years["2026"]!.standardDeductibleCents!.citations[0]!.page;
    expect(parameterErrors(pageless, manifest).join("\n")).toMatch(
      /PDF without a page/,
    );
    const extraYear = copy(parameters);
    extraYear.years["2028"] = copy(parameters.years["2027"]!);
    expect(parameterErrors(extraYear, manifest).join("\n")).toMatch(
      /years must be exactly/,
    );
  });

  it("fails when the 2026 and 2027 figures are swapped", () => {
    const swapped = copy(parameters);
    const a = swapped.years["2026"]!.outOfPocketThresholdCents!.value;
    swapped.years["2026"]!.outOfPocketThresholdCents!.value =
      swapped.years["2027"]!.outOfPocketThresholdCents!.value;
    swapped.years["2027"]!.outOfPocketThresholdCents!.value = a;
    expect(oracleErrors(swapped, oracles, manifest)).toHaveLength(2);
    const whole = copy(parameters);
    whole.years = {
      "2026": parameters.years["2027"]!,
      "2027": parameters.years["2026"]!,
    };
    expect(oracleErrors(whole, oracles, manifest)).toHaveLength(4);
    expect(parameterErrors(whole, manifest).join("\n")).toMatch(
      /another year's column/,
    );
  });
});

describe("document pins", () => {
  // SYNTHETIC bytes stand in for a cached document so the check runs without network or cache.
  function cache(bytes: Buffer) {
    const dir = mkdtempSync(join(tmpdir(), "medicare-pins-"));
    temporary.push(dir);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const doc: Doc = {
      id: "C1",
      url: "https://www.cms.gov/files/document/synthetic.pdf",
      sha256,
      bytes: bytes.length,
      contentType: "application/pdf",
    };
    const base = join(dir, "raw", "cms-partd-rules", sha256);
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "payload"), bytes);
    writeFileSync(
      `${base}.meta.json`,
      JSON.stringify({
        url: doc.url,
        final_url: doc.url,
        sha256,
        bytes: bytes.length,
        access_policy: { hosts: [] },
      }),
    );
    return {
      dir,
      base,
      pins: { cacheSource: "cms-partd-rules", documents: [doc] },
    };
  }
  const synthetic = Buffer.from("%PDF-1.7 synthetic pin fixture\n");

  it("verify matching cached bytes", async () => {
    const { dir, pins } = cache(synthetic);
    expect(await pinErrors(pins, dir)).toEqual([]);
  });

  it("fail when one byte is changed", async () => {
    const { dir, base, pins } = cache(synthetic);
    const tampered = Buffer.from(synthetic);
    tampered[10] = tampered[10]! ^ 1;
    writeFileSync(join(base, "payload"), tampered);
    expect((await pinErrors(pins, dir)).join("\n")).toMatch(
      /C1: sha256 [0-9a-f]{64} differs from pin/,
    );
  });

  it("fail on truncation, a missing file or a different source URL", async () => {
    const truncated = cache(synthetic);
    writeFileSync(join(truncated.base, "payload"), synthetic.subarray(1));
    expect((await pinErrors(truncated.pins, truncated.dir)).join("\n")).toMatch(
      /size .* differs/,
    );
    const missing = cache(synthetic);
    rmSync(join(missing.base, "payload"));
    expect((await pinErrors(missing.pins, missing.dir)).join("\n")).toMatch(
      /not cached/,
    );
    const moved = cache(synthetic);
    moved.pins.documents[0]!.url =
      "https://www.cms.gov/files/document/other.pdf";
    expect((await pinErrors(moved.pins, moved.dir)).join("\n")).toMatch(
      /cached copy came from/,
    );
  });

  const dataDir = process.env.OPENPLANS_DATA_DIR;
  const cached =
    !!dataDir &&
    existsSync(
      join(
        dataDir,
        "raw",
        manifest.cacheSource,
        manifest.documents[0]!.sha256,
        "payload",
      ),
    );
  it.skipIf(!cached)(
    "match the documents in the local cache when present",
    async () => {
      expect(await pinErrors(manifest, dataDir!)).toEqual([]);
    },
  );
});
