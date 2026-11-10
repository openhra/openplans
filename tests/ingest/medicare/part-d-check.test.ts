import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  compare,
  negativeControls,
  readActual,
} from "../../../scripts/oracle/medicare-part-d-logic.mjs";
import type { PartDReference } from "../../../scripts/oracle/medicare-part-d-logic.mjs";
import { migrate } from "../../../src/db/migrate.js";
import { parsePlanKey } from "../../../src/domain/medicare/index.js";
import type { Transport } from "../../../src/fetch/index.js";
import {
  acquireSpuf,
  cachedSpuf,
  importSpuf,
  parseSpufUrl,
} from "../../../src/ingest/medicare/spuf.js";
import { partDDrug } from "../../../src/services/medicare-part-d.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { lookup, spufArchive, spufUrl } from "./helpers.js";

const referenceScript = fileURLToPath(
  new URL(
    "../../../scripts/oracle/medicare-part-d-reference.py",
    import.meta.url,
  ),
);
type Edit = Parameters<typeof spufArchive>[0];

/** Replaces text in one table of the fixture archive before it is imported. */
const edit =
  (table: RegExp, from: RegExp, to: string): Edit =>
  (name, inner) => {
    if (!table.test(name)) return;
    const key = Object.keys(inner)[0]!;
    const before = inner[key]!.toString("latin1");
    const after = before.replace(from, to);
    if (after === before) throw new Error(`edit of ${name} changed nothing`);
    inner[key] = Buffer.from(after, "latin1");
  };

describe("Part D check against an independent reading of the raw archive", () => {
  let directory: string;
  let expected: PartDReference;

  /** Imports the fixture archive, edited or not, and reads it back the way the check does. */
  async function imported(mutate?: Edit) {
    const migrations = await coreMigrations();
    const dataDir = await mkdtemp(join(directory, "cache-"));
    const db = testDatabase(new PGlite());
    try {
      await migrate(db, migrations.directory);
      const bytes = await spufArchive(mutate);
      const transport: Transport = async () => ({
        status: 200,
        headers: { "content-type": "application/zip" },
        body: Readable.from([bytes]),
      });
      await acquireSpuf(parseSpufUrl(spufUrl)!, {
        dataDir,
        dependencies: { lookup, transport },
      });
      const cached = (await cachedSpuf("quarterly", dataDir))[0]!;
      const report = await importSpuf(db, cached);
      return await readActual(db, report.snapshot_id, expected, (key, rxcui) =>
        partDDrug(db, parsePlanKey(key)!, 2026, rxcui),
      );
    } finally {
      await db.close();
      await migrations.cleanup();
    }
  }

  beforeAll(async () => {
    vi.stubEnv("OPENPLANS_MEDICARE_PART_D", "on");
    directory = await mkdtemp(join(tmpdir(), "part-d-check-"));
    const archive = join(directory, "reference.zip");
    await writeFile(archive, await spufArchive());
    const reference = spawnSync("python3", ["-I", referenceScript, archive], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    expect(reference.stderr).toBe("");
    expected = JSON.parse(reference.stdout) as PartDReference;
  }, 60_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("agrees with the raw archive, and catches every error planted in its own reading", async () => {
    const actual = await imported();
    expect(compare(expected, actual)).toEqual([]);
    expect(expected.rows).toMatchObject({ formulary: 15, plan: 63 });
    expect(expected.sample.some((item) => item.status === "listed")).toBe(true);
    expect(expected.sample.some((item) => item.status === "not_listed")).toBe(
      true,
    );
    const controls = negativeControls(expected, actual);
    expect(Object.keys(controls).length).toBeGreaterThanOrEqual(7);
    expect(Object.values(controls).every(Boolean)).toBe(true);
  }, 180_000);

  // Each case imports an archive with one value changed; the raw reading stays the original.
  it.each([
    [
      "a formulary tier one lower",
      edit(/^basic drugs/, /\|70010006310\|6\|/, "|70010006310|5|"),
      /^(formulary|drug) /,
    ],
    [
      "a prior authorization flag flipped",
      edit(/^basic drugs/, /\|N\|N\|N\r?\n/, "|Y|N|N\r\n"),
      /^(formulary|drug) /,
    ],
    [
      "a dropped formulary row",
      edit(/^basic drugs/, /\n[^\n]+\n/, "\n"),
      /^(rows formulary|formulary )/,
    ],
    [
      "a plan marked suppressed",
      edit(/^plan information/, /\|N\r?\n/, "|Y\r\n"),
      /^plan /,
    ],
    [
      "a dropped county",
      edit(/^geographic locator/, /\n[^\n]+\n/, "\n"),
      /^(rows county|county )/,
    ],
    [
      "a cost-sharing amount changed",
      edit(/^beneficiary cost/, /\|1\|10\|0\|0\|N\|N\r\n/, "|1|11|0|0|N|N\r\n"),
      /^beneficiary_cost /,
    ],
  ])(
    "reports %s",
    async (_name, mutate, pattern) => {
      const problems = compare(expected, await imported(mutate));
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.some((problem) => pattern.test(problem))).toBe(true);
    },
    180_000,
  );
});
