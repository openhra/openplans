import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import { importSbe } from "../../../src/ingest/sbe/import.js";
import {
  cachedGeorgiaAccess,
  georgiaAccessSelectable,
} from "../../../src/ingest/sbe/georgia.js";
import { sbeRulesFile } from "../../../src/ingest/sbe/rules.js";
import { CsvError, readCsv } from "../../../src/ingest/csv/index.js";
import type { ImportFile } from "../../../src/ingest/puf/import-source.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/sbe/georgia-2027/", import.meta.url),
);
interface Provenance {
  files: { kind: string; name: string; url: string; sha256: string }[];
}
const provenance = async () =>
  JSON.parse(
    await readFile(join(fixture, "provenance.json"), "utf8"),
  ) as Provenance;

/** A data directory laid out like an admitted cache, holding the real cuts. */
async function cache(
  root: string,
  edit: (kind: string, text: string) => string = (_k, t) => t,
  policy: string | null = "allowed",
) {
  const directory = join(root, "raw", "georgia-access-puf");
  await mkdir(directory, { recursive: true });
  for (const file of (await provenance()).files) {
    const bytes = Buffer.from(
      edit(file.kind, await readFile(join(fixture, file.name), "utf8")),
    );
    const sha = createHash("sha256").update(bytes).digest("hex");
    await mkdir(join(directory, sha), { recursive: true });
    await writeFile(join(directory, sha, "payload"), bytes);
    await writeFile(
      join(directory, `${sha}.meta.json`),
      JSON.stringify({
        snapshot_id: sha,
        source: "georgia-access-puf",
        url: file.url,
        final_url: file.url,
        redirect_chain: [],
        status: 200,
        content_type: "text/csv",
        etag: null,
        last_modified: null,
        sha256: sha,
        bytes: bytes.length,
        fetched_at: "2026-11-09T03:20:38.200Z",
        ...(policy
          ? {
              access_policy: {
                hosts: [{ host: "georgiaaccess.gov", state: policy }],
              },
            }
          : {}),
      }),
    );
  }
  return root;
}
async function* one(text: string) {
  yield text;
}
async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

describe("CSV recovery options (opt-in)", () => {
  it("drops one trailing empty field and nothing else", async () => {
    const rows = await collect(
      readCsv(one('"a","b"\n"1","2",\n'), { trailingEmptyField: true }),
    );
    expect(rows[0]!.values).toEqual({ a: "1", b: "2" });
    await expect(
      collect(
        readCsv(one('"a","b"\n"1","2","x"\n'), { trailingEmptyField: true }),
      ),
    ).rejects.toThrow(CsvError);
  });
  it("rejects an unescaped quote by default and reads it literally only when asked", async () => {
    const text =
      '"a","b"\n"see the "Schedule of Benefits."","2"\n"ok ""x"" y","3"\n';
    await expect(collect(readCsv(one(text)))).rejects.toMatchObject({
      code: "invalid_quote",
    });
    const rows = await collect(
      readCsv(one(text), { recoverUnescapedQuotes: true }),
    );
    expect(rows.map((r) => [r.values.a, r.recoveredQuotes])).toEqual([
      ['see the "Schedule of Benefits."', 1],
      ['ok "x" y', undefined],
    ]);
  });
  it("keeps the field count check after recovery (a stray quote before a comma still fails closed)", async () => {
    await expect(
      collect(
        readCsv(one('"a","b"\n"the "X", more","2"\n'), {
          recoverUnescapedQuotes: true,
        }),
      ),
    ).rejects.toThrow(CsvError);
  });
});

describe("Georgia Access PY2027 catalog from real cuts", () => {
  let root: string, migration: Awaited<ReturnType<typeof coreMigrations>>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "openplans-ga27-"));
    migration = await coreMigrations();
  });
  afterAll(async () => {
    await migration?.cleanup();
    await rm(root, { recursive: true, force: true });
  });
  async function run(files: ImportFile[], dataDir: string) {
    const db = testDatabase(new PGlite());
    await migrate(db, migration.directory);
    const report = await importSbe(db, {
      year: 2027,
      state: "GA",
      dataDir,
      files,
    });
    return { db, report };
  }

  it("selects only a year CMS has not published for Georgia", () => {
    const cms = { state: "GA", year: 2026, url: "https://www.cms.gov/x.zip" };
    expect(georgiaAccessSelectable([cms], 2026)).toBe(false);
    expect(georgiaAccessSelectable([cms], 2027)).toBe(true);
  });

  it("refuses bytes fetched without an admission receipt", async () => {
    const dataDir = await cache(join(root, "unadmitted"), undefined, null);
    await expect(cachedGeorgiaAccess(dataDir, 2027)).rejects.toThrow(
      /exactly one admitted/,
    );
    const held = await cache(join(root, "held"), undefined, "held");
    await expect(cachedGeorgiaAccess(held, 2027)).rejects.toThrow(
      /exactly one admitted/,
    );
  });

  it("refuses a second published file for the same kind", async () => {
    const dataDir = await cache(join(root, "twice"));
    const directory = join(dataDir, "raw", "georgia-access-puf");
    const plan = (await provenance()).files.find(
      (f) => f.kind === "plan-attributes",
    )!;
    const meta = JSON.parse(
      await readFile(
        join(
          directory,
          `${createHash("sha256")
            .update(await readFile(join(fixture, plan.name)))
            .digest("hex")}.meta.json`,
        ),
        "utf8",
      ),
    );
    await writeFile(
      join(directory, "other.meta.json"),
      JSON.stringify({
        ...meta,
        url: plan.url.replace("20261015105252", "20261101000000"),
      }),
    );
    await expect(cachedGeorgiaAccess(dataDir, 2027)).rejects.toThrow(
      /exactly one admitted plan-attributes/,
    );
  });

  it("quarantines by default: the publisher's unescaped quotes stop the benefits file", async () => {
    const dataDir = await cache(join(root, "default"));
    const { db, report } = await run(
      await cachedGeorgiaAccess(dataDir, 2027),
      dataDir,
    );
    expect(report.status).toBe("QUARANTINED");
    expect(report.serving).toBe(false);
    expect(
      report.files.map((f) => [f.kind, f.stored_rows === f.input_rows]),
    ).toContainEqual(["benefits-and-cost-sharing", false]);
    expect(
      (await db.query("SELECT count(*)::int n FROM puf_active_catalog")).rows,
    ).toEqual([{ n: 0 }]);
    await db.close();
  });

  it("with recovery: loads, records every recovered row and keeps the quotes", async () => {
    const dataDir = await cache(join(root, "recovered"));
    const { db, report } = await run(
      await cachedGeorgiaAccess(dataDir, 2027, {
        recoverUnescapedQuotes: true,
      }),
      dataDir,
    );
    expect(report.status, JSON.stringify(report.checks)).toBe("ACTIVE");
    expect(report.source).toBe("georgia_access_puf");
    const issues = (
      await db.query<{ source_record: number }>(
        "SELECT source_record FROM quality_issue WHERE issue_code='csv_unescaped_quote_recovered' ORDER BY 1",
      )
    ).rows
      .map((r) => Number(r.source_record))
      .sort((a, b) => a - b);
    expect(issues).toEqual([31, 98, 165]);
    const text = (
      await db.query<{ raw: Record<string, string> }>(
        "SELECT raw FROM plan_benefit WHERE source_row=31",
      )
    ).rows[0]!.raw.Explanation;
    expect(text).toBe(
      'Habilitative services apply toward the "Physical medicine and rehabilitative services" maximum number of visits specified in the "Schedule of Benefits."',
    );
    // Georgia Access names each variant; a base name exists only when all agree.
    const names = (
      await db.query<{ base_plan_id: string; plan_name: string }>(
        "SELECT base_plan_id,plan_name FROM plan ORDER BY 1",
      )
    ).rows;
    expect(names).toEqual([
      {
        base_plan_id: "13535GA0140001",
        plan_name: "Smile Now Georgia - No Waiting Period PPO",
      },
      { base_plan_id: "58081GA0010005", plan_name: "unknown" },
    ]);
    const catalog = (
      await db.query<{ source: string; bundle_url: string }>(
        "SELECT source,bundle_url FROM sbe_catalog",
      )
    ).rows;
    expect(catalog).toEqual([
      {
        source: "georgia_access_puf",
        bundle_url: "https://georgiaaccess.gov/public-use-files/",
      },
    ]);
    await db.close();
  });

  it("negative control: a recovered row that splits into an extra field quarantines", async () => {
    const dataDir = await cache(join(root, "mutant"), (kind, text) =>
      kind === "benefits-and-cost-sharing"
        ? text.replace(
            'rehabilitative services" maximum',
            'rehabilitative services", maximum',
          )
        : text,
    );
    const { db, report } = await run(
      await cachedGeorgiaAccess(dataDir, 2027, {
        recoverUnescapedQuotes: true,
      }),
      dataDir,
    );
    expect(report.status).toBe("QUARANTINED");
    await db.close();
  });

  it("PY2027 rules add a separately reviewed Georgia row and keep every federal row", async () => {
    const dataDir = join(root, "rules");
    const path = await sbeRulesFile(dataDir, 2027);
    const document = JSON.parse(await readFile(path, "utf8"));
    const original = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL("../../../data/rating-rules/2027.json", import.meta.url),
        ),
        "utf8",
      ),
    );
    expect(document.rules.length).toBe(original.rules.length + 1);
    const ga = document.rules.find((r: { state: string }) => r.state === "GA");
    expect(ga.citation).toMatch(/reviewed for PY2027 on 2026-11-09/);
  });
});
