import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../../../src/api/app.js";
import { migrate } from "../../../src/db/migrate.js";
import { importRxnorm } from "../../../src/ingest/rxnorm/import.js";
import { createRxnormRepository } from "../../../src/ingest/rxnorm/repository.js";
import { fixture, metadata, zip } from "../../ingest/rxnorm/helpers.js";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { BASE, headers, TOKEN } from "./helpers.js";
import { assertShape } from "./shape.js";

const db = testDatabase(new PGlite()),
  app = createApp(db),
  rx = createRxnormRepository(db);
let directory: string, missing: Response;
let sourceNdcs: { rxcui: string; ndc: string }[];
beforeAll(async () => {
  process.env.OPENPLANS_COMPAT_API_KEY = TOKEN;
  const core = await coreMigrations();
  try {
    await migrate(db, core.directory);
  } finally {
    await core.cleanup();
  }
  directory = await mkdtemp(join(tmpdir(), "openplans-drug-search-"));
  missing = await app.request(BASE + "/drugs?search_term=metformin", {
    headers,
  });
  expect(await rx.activeRelease()).toBeNull();
  const files = await fixture(),
    archive = zip(files),
    path = join(directory, "rxnorm-real-cut.zip");
  sourceNdcs = files["RXNSAT.RRF"]
    .trim()
    .split("\n")
    .map((line) => line.split("|"))
    .filter((row) => row[8] === "NDC" && row[9] === "RXNORM" && row[11] === "N")
    .map((row) => ({ rxcui: row[0]!, ndc: row[10]! }));
  await writeFile(path, archive);
  await importRxnorm(db, {
    version: "2026-11-02",
    path,
    metadata: metadata(archive),
  });
});
afterAll(async () => {
  await db.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function search(term: string, extra = "") {
  const response = await app.request(
    `${BASE}/drugs?search_term=${encodeURIComponent(term)}${extra}`,
    { headers },
  );
  expect(response.status).toBe(200);
  return { response, body: (await response.json()) as any };
}
const packageId = (ndc: string) =>
  `${ndc.slice(0, 5)}-${ndc.slice(5, 9)}-${ndc.slice(9)}`;

function packageContract(value: unknown) {
  assert.ok(value !== null && typeof value === "object");
  const row = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(row).sort(), [
    "description",
    "id",
    "med_id",
    "rx_cui_id",
  ]);
  assert.equal(typeof row.id, "string");
  assert.match(String(row.id), /^\d{5}-\d{4}-\d{2}$/);
  assert.equal(typeof row.rx_cui_id, "string");
  // NDC associations establish neither a package description nor a product ID.
  assert.equal(row.description, null);
  assert.equal(row.med_id, null);
}

it("keeps required package nulls even when the package count differs from the concept count", async () => {
  const { body } = await search("metformin");
  expect(body.drug_packages.length).toBeGreaterThan(0);
  expect(body.drug_packages.length).not.toBe(body.drugs.length);
  for (const value of body.drug_packages) packageContract(value);
  const original = body.drug_packages[0] as Record<string, unknown>;
  for (const field of ["description", "med_id"]) {
    const absent = { ...original };
    delete absent[field];
    expect(() => packageContract(absent), field).toThrow();
    const invented = { ...original, [field]: "synthetic unknown value" };
    expect(() => packageContract(invented), field).toThrow();
  }
});

it("distinguishes an unloaded terminology database from an unknown search after bootstrap", async () => {
  expect(missing.status).toBe(200);
  expect(await missing.json()).toEqual({
    meta: { total: 0 },
    drugs: [],
    drug_packages: [],
  });
  expect(missing.headers.get("x-openplans-gaps")).toContain(
    "rxnorm_terminology_unavailable",
  );
  expect(await rx.activeRelease()).toMatchObject({
    source_version: "2026-11-02",
    snapshot_id: expect.any(String),
  });
  const loaded = await search("metformin"),
    unknown = await search("zzzznotadrug");
  expect(loaded.body.drugs.length).toBeGreaterThan(0);
  expect(loaded.response.headers.get("x-openplans-gaps")).not.toContain(
    "rxnorm_terminology_unavailable",
  );
  expect(unknown.body).toEqual({
    meta: { total: 0 },
    drugs: [],
    drug_packages: [],
  });
  expect(unknown.response.headers.get("x-openplans-gaps")).not.toContain(
    "rxnorm_terminology_unavailable",
  );
});

it.each(["metformin", "lisinopril", "lipitor"])(
  "returns %s with literal case-insensitive search and source-backed packages",
  async (term) => {
    const { body, response } = await search(term);
    expect((await search(term.toUpperCase())).body).toEqual(body);
    expect((await search(`  ${term}  `)).body).toEqual(body);
    expect((await search(term.slice(2))).body.meta.total).toBe(body.meta.total);
    expect(body.meta.total).toBeGreaterThan(1);
    expect(body.drug_packages.length).toBeGreaterThan(0); // Must not pass vacuously with a missing NDC join.
    expect(Object.keys(body).sort()).toEqual([
      "drug_packages",
      "drugs",
      "meta",
    ]);
    expect(new Set(body.drugs.map((drug: any) => drug.id)).size).toBe(
      body.drugs.length,
    );
    const expectedPackages = [];
    for (const drug of body.drugs) {
      expect(Object.keys(drug).sort()).toEqual([
        "active_ingredient_strength",
        "drug_package_ids",
        "id",
        "non_proprietary_name",
        "proprietary_name",
      ]);
      expect(drug.id).toMatch(/^rxnorm:\d+$/);
      const rxcui = drug.id.slice(7);
      const ndcs = [
        ...new Set(
          sourceNdcs.filter((row) => row.rxcui === rxcui).map((row) => row.ndc),
        ),
      ].sort();
      expect(drug.drug_package_ids).toEqual(ndcs.map(packageId));
      expectedPackages.push(
        ...ndcs.map((ndc) => ({
          id: packageId(ndc),
          description: null,
          med_id: null,
          rx_cui_id: rxcui,
        })),
      );
    }
    expect(body.drug_packages).toEqual(expectedPackages);
    expect(response.headers.get("x-openplans-gaps")).toContain(
      "ndc_package_descriptions_and_med_ids_unavailable",
    );
    const root = process.env.OPENPLANS_REFERENCE_CAPTURES_DIR;
    if (root)
      assertShape(
        JSON.parse(await readFile(join(root, "drugs", term + ".json"), "utf8")),
        body,
        "$",
        true,
      );
  },
);

it("paginates distinct concepts before attaching only their own exact NDC associations", async () => {
  const { body } = await search("metformin");
  for (let page = 1; page <= body.drugs.length; page++) {
    const result = (await search("metformin", `&per_page=1&page=${page}`)).body;
    expect(result.meta.total).toBe(body.meta.total);
    expect(result.drugs).toEqual(body.drugs.slice(page - 1, page));
    expect(result.drug_packages).toEqual(
      body.drug_packages.filter(
        (p: any) => p.rx_cui_id === result.drugs[0].id.slice(7),
      ),
    );
  }
  const beyond = (
    await search("metformin", `&per_page=1&page=${body.meta.total + 1}`)
  ).body;
  expect(beyond).toEqual({ meta: body.meta, drugs: [], drug_packages: [] });
  for (const literal of ["metformin%", "metformin_"])
    expect((await search(literal)).body.meta.total).toBe(0);
});

it("excludes suppressed NDC mappings and quarantined terminology without substituting other concepts", async () => {
  const marker = new Error(
    "rollback synthetic suppression of real source rows",
  );
  await expect(
    db.transaction(async (tx) => {
      const { rxcui, ndc } = sourceNdcs.find((row) => row.ndc.startsWith("0"))!;
      await tx.query(
        "UPDATE rx_ndc SET suppress='Y' WHERE rxcui=$1 AND ndc=$2",
        [rxcui, ndc],
      );
      expect(
        await createRxnormRepository(tx).ndcsForRxcui(rxcui),
      ).not.toContain(ndc);
      await tx.exec(
        "UPDATE snapshot SET validation_state='QUARANTINED' WHERE source_id='nlm-rxnorm-prescribe'",
      );
      expect(await createRxnormRepository(tx).activeRelease()).toBeNull();
      const response = await createApp(tx).request(
        BASE + "/drugs?search_term=metformin",
        { headers },
      );
      expect(await response.json()).toEqual({
        meta: { total: 0 },
        drugs: [],
        drug_packages: [],
      });
      expect(response.headers.get("x-openplans-gaps")).toContain(
        "rxnorm_terminology_unavailable",
      );
      throw marker;
    }),
  ).rejects.toBe(marker);
});

it("negative controls: the same contracts reject removal of NDC lookup and case-sensitive search", async () => {
  const source = await readFile(
    new URL("../../../src/ingest/rxnorm/repository.ts", import.meta.url),
    "utf8",
  );
  const contract = async (repo: ReturnType<typeof createRxnormRepository>) => {
    const lower = await repo.searchDrugs("metformin"),
      upper = await repo.searchDrugs("MeTfOrMiN");
    assert.ok(lower.length > 0);
    assert.deepEqual(upper, lower);
    const { rxcui } = sourceNdcs.find((row) => row.ndc.startsWith("0"))!;
    assert.deepEqual(
      await repo.ndcsForRxcui(rxcui),
      [
        ...new Set(
          sourceNdcs.filter((row) => row.rxcui === rxcui).map((row) => row.ndc),
        ),
      ].sort(),
    );
  };
  await contract(rx);
  const start = source.indexOf("    async ndcsForRxcui("),
    end = source.indexOf("    async ingredientsOf(");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const mutants = {
    "ndc-lookup":
      source.slice(0, start) +
      "    async ndcsForRxcui() { return []; },\n" +
      source.slice(end),
    "case-sensitive": source.replace(
      "strpos(lower(name),lower($1))>0",
      "strpos(name,$1)>0",
    ),
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    expect(mutant).not.toBe(source);
    const path = join(directory, `synthetic-${name}-mutant.cjs`);
    await writeFile(
      path,
      ts.transpileModule(mutant, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    );
    const repository = createRequire(import.meta.url)(
      path,
    ).createRxnormRepository(db);
    await expect(contract(repository), name).rejects.toThrow();
  }
});
