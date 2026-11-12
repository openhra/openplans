import { rebaseImports, replaceSyntax } from "../../source-mutation.js";
import { PGlite } from "@electric-sql/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createApp } from "../../../src/api/app.js";
import { createResponseCache } from "../../../src/api/cache/index.js";
import { dataGeneration } from "../../../src/api/cache/generation.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { migrate } from "../../../src/db/migrate.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { zipToCounties } from "../../../src/ingest/geo/repository.js";
import { fixtureFiles } from "../../ingest/geo/helpers.js";
import { coreMigrations, testDatabase } from "../../pglite.js";

const NON_CATALOG_TABLES: Record<string, string> = {
  plugin_event_outbox: "application event log; never feeds catalog responses",
  plugin_event_delivery:
    "subscriber delivery state; never feeds catalog responses",
  plugin_state: "durable plugin state; never feeds catalog responses",
  passthrough_budget:
    "pass-through request budget; never feeds catalog responses",
  passthrough_attempt: "pass-through call log; never feeds catalog responses",
  passthrough_conflict:
    "stored answers checked against loaded files; never feeds catalog responses",
  ingest_run_snapshot:
    "which ingest run wrote each snapshot; never feeds catalog responses",
  rate_plan_count:
    "rate-row counts kept from immutable rate files; responses read the same values from rate",
};

async function missingGenerationTriggers() {
  const { rows } = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename NOT IN ('api_data_generation','schema_migrations','spatial_ref_sys')
      AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=('public.' || quote_ident(tablename))::regclass
        AND tgname='api_data_changed' AND tgenabled <> 'D') ORDER BY tablename`,
  );
  return rows.filter(({ tablename }) => !NON_CATALOG_TABLES[tablename]);
}

const db = testDatabase(new PGlite());
let core: Awaited<ReturnType<typeof coreMigrations>>, directory: string;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-cache-generation-"));
  core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await fixtureFiles() });
});
afterAll(async () => {
  await db.close();
  await core.cleanup();
  await rm(directory, { recursive: true, force: true });
});

describe("transactional catalog generations", () => {
  it("a real fixture import bumps generation and the next native request misses", async () => {
    const app = createApp(db, {}, { store: new MemoryCache(1024 * 1024) });
    const path = "/v1/zip-counties?zip=77002",
      before = await dataGeneration(db);
    expect((await app.request(path)).headers.get("X-Cache")).toBe("miss");
    expect((await app.request(path)).headers.get("X-Cache")).toBe("hit");
    await ingestGeo(db, { files: await fixtureFiles() });
    expect(await dataGeneration(db)).not.toBe(before);
    const after = await app.request(path);
    expect(after.status).toBe(200);
    expect(after.headers.get("X-Cache")).toBe("miss");
    const health = await app.request("/healthz");
    expect(health.headers.get("X-Cache")).toBe("bypass");
    expect(await (await app.request("/v1/cache-stats")).json()).toMatchObject({
      hits: 1,
      misses: 2,
      bytes: expect.any(Number),
    });
  });
  it("rollbacks preserve generation; multiple statements increment once per table/transaction", async () => {
    const before = await dataGeneration(db),
      marker = Error("synthetic rollback");
    await expect(
      db.transaction(async (tx) => {
        await tx.query("UPDATE geo_import SET imported_at=imported_at");
        expect(await dataGeneration(tx)).not.toBe(before);
        throw marker;
      }),
    ).rejects.toBe(marker);
    expect(await dataGeneration(db)).toBe(before);
    const revision = async () =>
      (
        await db.query<{ revision: string }>(
          "SELECT revision::text FROM api_data_generation WHERE table_name='geo_import'",
        )
      ).rows[0]!.revision;
    const old = BigInt(await revision());
    await db.transaction(async (tx) => {
      await tx.query("UPDATE geo_import SET imported_at=imported_at");
      await tx.query("UPDATE geo_import SET imported_at=imported_at");
    });
    expect(BigInt(await revision())).toBe(old + 1n);
  });
  it("real compatibility auth rejects bad keys even after an authorized ZIP response is cached", async () => {
    vi.stubEnv("OPENPLANS_COMPAT_API_KEY", "synthetic-generation-auth-key");
    try {
      const app = createApp(db, {}, { store: new MemoryCache(1024 * 1024) });
      const path = "/compat/v1/zip_counties?zip_prefix=77002";
      const headers = { "X-Api-Key": "synthetic-generation-auth-key" };
      expect(
        (await app.request(path, { headers })).headers.get("X-Cache"),
      ).toBe("miss");
      expect(
        (await app.request(path, { headers })).headers.get("X-Cache"),
      ).toBe("hit");
      const denied = await app.request(path, {
        headers: { "X-Api-Key": "synthetic-wrong-key" },
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get("X-Cache")).toBe("bypass");
      const malformed = await app.request(
        "/compat/v1/zip_counties?zip_prefix=bad",
        { headers },
      );
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("X-Cache")).toBe("bypass");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("registers every existing public import table and invalidates on truncate", async () => {
    expect(await missingGenerationTriggers()).toEqual([]);
    const { rows: pluginTriggers } = await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgname='api_data_changed'
        AND tgrelid IN (SELECT oid FROM pg_class WHERE relname=ANY($1::text[]))`,
      [Object.keys(NON_CATALOG_TABLES)],
    );
    expect(pluginTriggers).toEqual([]);
    await db.exec("CREATE TEMP TABLE synthetic_generation_copy(i integer)");
    await db.exec(`CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON synthetic_generation_copy
      FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation();
      INSERT INTO api_data_generation(table_name) VALUES ('synthetic_generation_copy')`);
    const before = await dataGeneration(db);
    await db.exec("INSERT INTO synthetic_generation_copy VALUES (1)");
    expect(await dataGeneration(db)).not.toBe(before);
    const inserted = await dataGeneration(db);
    await db.exec("TRUNCATE synthetic_generation_copy");
    expect(await dataGeneration(db)).not.toBe(inserted);
  });
  it("negative control: a public table without a generation trigger fails the guard", async () => {
    await db.exec("CREATE TABLE synthetic_missing_generation(id integer)");
    try {
      const problems = await missingGenerationTriggers();
      expect(() => expect(problems).toEqual([])).toThrow();
      expect(problems).toEqual([{ tablename: "synthetic_missing_generation" }]);
    } finally {
      await db.exec("DROP TABLE synthetic_missing_generation");
    }
  });
  it("negative control: an actual middleware mutant omitting generation serves stale data and fails freshness", async () => {
    // Compile a temporary module tree; the real sources remain untouched.
    for (const folder of ["src/api/cache", "src/compat/v1"])
      await mkdir(join(directory, folder), { recursive: true });
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    for (const file of await readdir(
      new URL("../../../src/api/cache/", import.meta.url),
    )) {
      if (!file.endsWith(".ts")) continue;
      let source = await readFile(
        new URL(`../../../src/api/cache/${file}`, import.meta.url),
        "utf8",
      );
      if (file === "index.ts") {
        source = replaceSyntax(
          source,
          "[...url.searchParams], body, generation",
          "[...url.searchParams], body, 'generation-omitted'",
        );
      }
      source = rebaseImports(
        source,
        new URL(
          `../../../dist/api/cache/${file.replace(".ts", ".js")}`,
          import.meta.url,
        ),
      );
      await writeFile(
        join(directory, "src/api/cache", file.replace(".ts", ".js")),
        ts.transpileModule(source, {
          compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ES2022,
          },
        }).outputText,
      );
    }
    const auth = await readFile(
      new URL("../../../src/compat/v1/auth.ts", import.meta.url),
      "utf8",
    );
    await writeFile(
      join(directory, "src/compat/v1/auth.js"),
      ts.transpileModule(auth, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText,
    );
    const mutant = (await import(
      pathToFileURL(join(directory, "src/api/cache/index.js")).href
    )) as { createResponseCache: typeof createResponseCache };
    function app(factory: typeof createResponseCache) {
      const h = new Hono(),
        cache = factory(db, undefined, { store: new MemoryCache(1024 * 1024) });
      h.use("*", cache.middleware);
      h.get("/v1/zip-counties", async (c) =>
        c.json(await zipToCounties(db, "77002")),
      );
      return h;
    }
    const healthy = app(createResponseCache),
      broken = app(mutant.createResponseCache);
    const before = await dataGeneration(db);
    const path = "/v1/zip-counties?zip=77002";
    const old = (await (await healthy.request(path)).json()) as {
      counties: { county_name: string }[];
    };
    await broken.request(path);
    await ingestGeo(db, { files: await fixtureFiles() });
    // Labelled synthetic mutation in this disposable fixture database, never a source file.
    const expected = "Synthetic cache generation control";
    await db.query("UPDATE zcta_county SET county_name=$1 WHERE zcta='77002'", [
      expected,
    ]);
    expect(await dataGeneration(db)).not.toBe(before);
    const assertFresh = (name: string) => expect(name).toBe(expected);
    const fresh = await healthy.request(path);
    expect(fresh.headers.get("X-Cache")).toBe("miss");
    assertFresh(
      ((await fresh.json()) as { counties: { county_name: string }[] })
        .counties[0]!.county_name,
    );
    const stale = await broken.request(path);
    expect(stale.headers.get("X-Cache")).toBe("hit");
    const staleName = (
      (await stale.json()) as { counties: { county_name: string }[] }
    ).counties[0]!.county_name;
    expect(() => assertFresh(staleName)).toThrow();
    expect(staleName).toBe(old.counties[0]!.county_name);
  });
});
