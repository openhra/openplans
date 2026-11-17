import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applicationStateCatalogImpact,
  pluginManifestSchema,
} from "@openplans/plugin-sdk";
import type { Database } from "@openplans/plugin-sdk";
import plugin, { applicationState } from "../../../plugins/msot/src/index.js";
import { parseFiles } from "../../../plugins/msot/src/files.js";
import { VersionService } from "../../../plugins/msot/src/service.js";
import { input, reader, source } from "../../../plugins/msot/tests/fixtures.js";
import {
  loadPluginMigrations,
  migrate,
  PluginMigrationRefusal,
} from "../../../src/db/migrate.js";
import type { PluginMigration } from "../../../src/db/migrate.js";
import {
  schemaViolations,
  receiptViolations,
} from "../../../src/db/row-provenance-check.js";
import {
  rowJson,
  withoutRowProvenance,
  ROW_PROVENANCE_COLUMNS,
} from "../../../src/db/row-provenance.js";
import { createApp } from "../../../src/api/app.js";
import { ingestGeo } from "../../../src/ingest/geo/index.js";
import { fixtureFiles } from "../../ingest/geo/helpers.js";
import { dataGeneration } from "../../../src/api/cache/generation.js";
import { MemoryCache } from "../../../src/api/cache/store.js";
import { createEventBus } from "../../../src/plugins/events.js";
import { checkCatalogTriggers } from "../../../src/plugins/testing/checks.js";
import { plantMutant } from "../../../src/plugins/testing/artifacts.js";
import { responseDigest } from "../../plugins/admin-support/digests.js";
import { coreMigrations, migratedTemplate } from "../../pglite.js";

// Synthetic operator instructions in disposable offline databases.
let template: Awaited<ReturnType<typeof migratedTemplate>>;
let core: Awaited<ReturnType<typeof coreMigrations>>;
let db: Database;
let migrations: PluginMigration[];
const migrationSource = {
  plugin: plugin.manifest.name,
  tablePrefix: "msot",
  applicationState,
  directory: fileURLToPath(
    new URL("../../../plugins/msot/migrations/", import.meta.url),
  ),
};
const service = new VersionService(reader);
const signal = new AbortController().signal;
const meta = (key: string) => ({
  actor: "operator-demo",
  reason: "synthetic_test",
  idempotency_key: key,
});
const candidate = () =>
  parseFiles(
    JSON.stringify(source),
    "operator-demo",
    "2026-11-16T00:00:00Z",
    reader,
  );
const importDraft = async () =>
  service.import(db, await candidate(), meta("import"));
const generationUnchanged = async (before: string) =>
  expect(await dataGeneration(db)).toBe(before);

beforeAll(async () => {
  template = await migratedTemplate();
  core = await coreMigrations();
  migrations = await loadPluginMigrations([migrationSource]);
});
afterAll(async () => {
  await template?.close();
  await core?.cleanup();
});
beforeEach(async () => {
  db = await template.fresh();
  await migrate(db, core.directory, migrations);
});
afterEach(async () => {
  await db?.close();
});

it("keeps drafts, receipts, refusals and cleanup outside generation and warmed HTTP answers", async () => {
  await ingestGeo(db, { files: await fixtureFiles() });
  const app = createApp(db, {}, { store: new MemoryCache(1024 * 1024) });
  const path = "/v1/zip-counties?zip=77002";
  expect((await app.request(path)).headers.get("x-cache")).toBe("miss");
  const warm = await responseDigest(await app.request(path));
  expect(warm.headers["x-cache"]).toBe("hit");
  const before = await dataGeneration(db);
  const imported = await importDraft();
  await generationUnchanged(before);
  await service.previewDraft(
    db,
    imported.draft_id,
    input,
    signal,
    meta("preview"),
  );
  await generationUnchanged(before);
  await expect(
    service.import(db, await candidate(), {
      ...meta("refusal"),
      actor: "synthetic-wrong-actor",
    }),
  ).rejects.toThrow("MSOT_ACTOR_MISMATCH");
  await generationUnchanged(before);
  await db.exec(
    "UPDATE plg_msot_draft SET actor=actor; UPDATE plg_msot_preview SET input=input; DELETE FROM plg_msot_preview; DELETE FROM plg_msot_draft; TRUNCATE plg_msot_audit",
  );
  await generationUnchanged(before);
  expect(await responseDigest(await app.request(path))).toEqual(warm);
  expect(await schemaViolations(db)).toEqual([]);
  expect(await receiptViolations(db)).toEqual([]);
  expect(await checkCatalogTriggers(db)).toEqual([]);
});

it("preserves application provenance and strips it from both SQL JSON and selected rows", async () => {
  await importDraft();
  const row = (await db.query("SELECT * FROM plg_msot_draft")).rows[0]!;
  expect(row).toMatchObject({
    sourced_by: "openplans",
    sourced_at: null,
    sourced_slug: "app:plugin-msot:plg_msot_draft",
    record_policy: "app_state",
    record_ttl: null,
    expired_at: null,
  });
  const projected = (
    await db.query<{ value: Record<string, unknown> }>(
      `SELECT ${rowJson("d")} AS value FROM plg_msot_draft d`,
    )
  ).rows[0]!.value;
  const stripped = withoutRowProvenance(row);
  expect(projected).toEqual(stripped);
  for (const name of ROW_PROVENANCE_COLUMNS)
    expect(stripped).not.toHaveProperty(name);
});

it("keeps published versions, activation and all other MSoT catalog tables invalidating", async () => {
  const imported = await importDraft();
  const preview = await service.previewDraft(
    db,
    imported.draft_id,
    input,
    signal,
    meta("preview"),
  );
  await ingestGeo(db, { files: await fixtureFiles() });
  const app = createApp(db, {}, { store: new MemoryCache(1024 * 1024) });
  const path = "/v1/zip-counties?zip=77002";
  await app.request(path);
  expect((await app.request(path)).headers.get("x-cache")).toBe("hit");
  const before = await dataGeneration(db);
  const events = createEventBus({ db, log: () => {} }).registry({
    kind: "plugin",
    manifest: plugin.manifest,
  });
  await service.publish(
    db,
    preview.preview_id,
    preview.expected,
    meta("publish"),
    events,
    signal,
  );
  expect(await dataGeneration(db)).not.toBe(before);
  expect((await app.request(path)).headers.get("x-cache")).toBe("miss");
  await service.activate(
    db,
    source.source_id,
    1,
    { version: null, activation: 0 },
    meta("activate"),
    events,
  );
  for (const entry of applicationState.filter(
    ({ table }) =>
      applicationStateCatalogImpact(plugin.manifest.name, "msot", table) ===
      "catalog",
  )) {
    const previous = await dataGeneration(db);
    // Statement-level invalidation remains conservative, including an empty update.
    await db.exec(
      `UPDATE ${entry.table} SET sourced_by=sourced_by WHERE false`,
    );
    expect(await dataGeneration(db), entry.table).not.toBe(previous);
  }
  expect(await receiptViolations(db)).toEqual([]);
});

it("reconciles an already-journaled installation without changing its warmed generation; replay is inert", async () => {
  for (const table of [
    "plg_msot_draft",
    "plg_msot_preview",
    "plg_msot_audit",
  ]) {
    await db.exec(
      `DROP TRIGGER api_data_changed ON ${table}; CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()`,
    );
  }
  const before = await dataGeneration(db);
  expect(await migrate(db, core.directory, migrations)).toEqual([]);
  await generationUnchanged(before);
  await importDraft();
  await generationUnchanged(before);
  expect(await migrate(db, core.directory, migrations)).toEqual([]);
  await generationUnchanged(before);
  // Disabling the owning plugin leaves its existing state and classification untouched.
  expect(await migrate(db, core.directory)).toEqual([]);
  await generationUnchanged(before);
});

it("reconciles and replays operational classification through the concurrent-index runner", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openplans-storage-concurrent-"),
  );
  try {
    await cp(
      join(migrationSource.directory, "001_versions.sql"),
      join(directory, "001_versions.sql"),
    );
    await writeFile(
      join(directory, "002_preview_index.sql"),
      "CREATE INDEX CONCURRENTLY plg_msot_preview_source ON plg_msot_preview(source_id)",
    );
    const loaded = await loadPluginMigrations([
      { ...migrationSource, directory },
    ]);
    await db.exec(
      "DROP TRIGGER api_data_changed ON plg_msot_draft; CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON plg_msot_draft FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()",
    );
    const before = await dataGeneration(db);
    expect(await migrate(db, core.directory, loaded)).toEqual([
      "plugin:@openplans/plugin-msot/002_preview_index.sql",
    ]);
    await generationUnchanged(before);
    await importDraft();
    await generationUnchanged(before);
    expect(await migrate(db, core.directory, loaded)).toEqual([]);
    await generationUnchanged(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("fails closed when declarations disappear, restoring catalog invalidation", async () => {
  const before = await dataGeneration(db);
  await migrate(
    db,
    core.directory,
    migrations.map((migration) => ({
      ...migration,
      applicationState: undefined,
    })),
  );
  expect(await dataGeneration(db)).not.toBe(before);
  const restored = await dataGeneration(db);
  await importDraft();
  expect(await dataGeneration(db)).not.toBe(restored);
});

it.each([
  { table: "plan", reason: "synthetic", catalogImpact: "operational" },
  { table: "plg_msot_rule", reason: "synthetic", catalogImpact: "operational" },
  {
    table: "plg_msot_source",
    reason: "synthetic",
    catalogImpact: "operational",
  },
  {
    table: "plg_msot_activation",
    reason: "synthetic",
    catalogImpact: "operational",
  },
  {
    table: "plg_other_draft",
    reason: "synthetic",
    catalogImpact: "operational",
  },
  { table: "plg_msot_draft", reason: " " },
  { table: "plg_msot_draft", reason: "synthetic", disposable: true },
])(
  "rejects forbidden declarations before migration effects: $table",
  async (entry) => {
    expect(
      pluginManifestSchema.safeParse({
        ...plugin.manifest,
        applicationState: [entry],
      }).success,
    ).toBe(false);
    await expect(
      loadPluginMigrations([
        {
          ...migrationSource,
          applicationState: [entry],
        } as typeof migrationSource,
      ]),
    ).rejects.toBeInstanceOf(PluginMigrationRefusal);
    const before = await dataGeneration(db);
    await expect(
      migrate(
        db,
        core.directory,
        migrations.map((migration) => ({
          ...migration,
          applicationState: [entry],
        })) as PluginMigration[],
      ),
    ).rejects.toBeInstanceOf(PluginMigrationRefusal);
    await generationUnchanged(before);
  },
);

it("does not accept an unowned prefix exemption, duplicate ownership or duplicate declarations", async () => {
  expect(
    pluginManifestSchema.safeParse({
      ...plugin.manifest,
      name: "@synthetic/other",
      applicationState: [
        {
          table: "plg_msot_draft",
          reason: "synthetic",
          catalogImpact: "operational",
        },
      ],
    }).success,
  ).toBe(false);
  await expect(
    loadPluginMigrations([
      {
        ...migrationSource,
        applicationState: [applicationState[0]!, applicationState[0]!],
      },
    ]),
  ).rejects.toBeInstanceOf(PluginMigrationRefusal);
  await expect(
    loadPluginMigrations([
      migrationSource,
      { ...migrationSource, plugin: "@synthetic/other" },
    ]),
  ).rejects.toBeInstanceOf(PluginMigrationRefusal);
});

it("does not treat arbitrary owned application state as operational", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "openplans-storage-synthetic-"),
  );
  try {
    await writeFile(
      join(directory, "001_state.sql"),
      "CREATE TABLE plg_synthetic_draft(id integer PRIMARY KEY)",
    );
    const loaded = await loadPluginMigrations([
      {
        plugin: "@synthetic/storage",
        tablePrefix: "synthetic",
        directory,
        applicationState: [
          {
            table: "plg_synthetic_draft",
            reason: "Synthetic application state",
          },
        ],
      },
    ]);
    await migrate(db, core.directory, loaded);
    const before = await dataGeneration(db);
    await db.exec("INSERT INTO plg_synthetic_draft(id) VALUES (1)");
    expect(await dataGeneration(db)).not.toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rolls back provenance conflicts and missing-table declarations without partial migration state", async () => {
  const before = await dataGeneration(db);
  await expect(
    migrate(
      db,
      core.directory,
      migrations.map((migration) => ({
        ...migration,
        applicationState: [
          ...applicationState,
          { table: "plg_msot_missing", reason: "Synthetic missing table" },
        ],
      })),
    ),
  ).rejects.toThrow("Plugin application table missing");
  await generationUnchanged(before);
  await db.exec(
    "UPDATE row_provenance_rule SET fixed_by='synthetic-wrong-owner' WHERE table_name='plg_msot_draft'",
  );
  await expect(migrate(db, core.directory, migrations)).rejects.toThrow(
    "Plugin application provenance conflict",
  );
});

it("negative control: a catalog declaration mutated to operational fails the contract", async () => {
  const mutant = await plantMutant(
    new URL("../../../plugins/sdk/src/application-state.ts", import.meta.url),
    'return plugin === "@openplans/plugin-msot" && tablePrefix === "msot" && ["plg_msot_draft", "plg_msot_preview", "plg_msot_audit"].includes(table) ? "operational" : "catalog";',
    'return "operational";',
  );
  try {
    const changed = (await import(pathToFileURL(mutant.path).href)) as {
      applicationStateCatalogImpact: typeof applicationStateCatalogImpact;
    };
    expect(() =>
      expect(
        changed.applicationStateCatalogImpact(
          "@synthetic/other",
          "other",
          "plg_other_catalog",
        ),
      ).toBe("catalog"),
    ).toThrow();
  } finally {
    await mutant.cleanup();
  }
});

it("negative control: draft bookkeeping that bumps generation fails the isolation assertion", async () => {
  await db.exec(
    "DROP TRIGGER api_data_changed ON plg_msot_draft; CREATE TRIGGER api_data_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON plg_msot_draft FOR EACH STATEMENT EXECUTE FUNCTION bump_api_data_generation()",
  );
  const before = await dataGeneration(db);
  await importDraft();
  await expect(generationUnchanged(before)).rejects.toThrow();
});

it("negative control: losing application provenance fails the receipt check", async () => {
  await importDraft();
  await db.exec(
    "ALTER TABLE plg_msot_draft DISABLE TRIGGER row_provenance; UPDATE plg_msot_draft SET sourced_by='unknown',sourced_slug='unknown'",
  );
  expect(await receiptViolations(db)).toContain(
    "plg_msot_draft: 1 app rows without app:plugin-msot:plg_msot_draft",
  );
});

it("negative control: one-byte response and stable-header changes are rejected", async () => {
  const expected = await responseDigest(
    new Response("synthetic", { headers: { "cache-control": "no-store" } }),
  );
  const body = await responseDigest(
    new Response("synthetic ", { headers: { "cache-control": "no-store" } }),
  );
  const header = await responseDigest(
    new Response("synthetic", { headers: { "cache-control": "public" } }),
  );
  expect(() => expect(body).toEqual(expected)).toThrow();
  expect(() => expect(header).toEqual(expected)).toThrow();
});
