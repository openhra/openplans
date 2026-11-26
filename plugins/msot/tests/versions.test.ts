import { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database, WorkerContext } from "@openplans/plugin-sdk";
import { pluginManifestSchema } from "@openplans/plugin-sdk";
import plugin, { applicationState } from "../src/index.js";
import { parseFiles } from "../src/files.js";
import { compileSource } from "../src/resolver.js";
import { Repository } from "../src/repository.js";
import { VersionService } from "../src/service.js";
import type { Metadata } from "../src/service.js";
import {
  coreMigrations,
  migratedTemplate,
  testDatabase,
} from "../../../tests/pglite.js";
import { loadPluginMigrations, migrate } from "../../../src/db/migrate.js";
import {
  schemaViolations,
  receiptViolations,
} from "../../../src/db/row-provenance-check.js";
import { checkCatalogTriggers } from "../../../src/plugins/testing/checks.js";
import { createEventBus } from "../../../src/plugins/events.js";
import { loadConfig } from "../../../src/config/index.js";
import { loadPlugins } from "../../../tests/plugins/approval-helpers.js";
import { createApp } from "../../../src/api/app.js";
import { loadForTest } from "../../../src/plugins/testing/load.js";
import { backupExcludedTables } from "../../../src/worker/backup-args.js";
import { source, reader, input } from "./fixtures.js";

// Synthetic operator rules and identities; every database is disposable and offline.
let template: Awaited<ReturnType<typeof migratedTemplate>>;
let core: Awaited<ReturnType<typeof coreMigrations>>;
let db: Database;
const migrationSource = {
  plugin: plugin.manifest.name,
  tablePrefix: "msot",
  applicationState,
  directory: fileURLToPath(new URL("../migrations/", import.meta.url)),
};
const service = new VersionService(reader);
const signal = new AbortController().signal;
const meta = (key: string): Metadata => ({
  actor: "operator-demo",
  reason: "test_workflow",
  idempotency_key: key,
});
const candidate = (version = 1, value = true) =>
  parseFiles(
    JSON.stringify({
      ...source,
      version,
      rules: [{ ...source.rules[0], value: { state: "known", value } }],
    }),
    "operator-demo",
    "2026-11-16T00:00:00Z",
    reader,
  );
const events = () =>
  createEventBus({ db, log: () => {} }).registry({
    kind: "plugin",
    manifest: plugin.manifest,
  });
async function publish(version = 1, value = true) {
  const imported = await service.import(
    db,
    await candidate(version, value),
    meta(`import-${version}`),
  );
  const preview = await service.previewDraft(
    db,
    imported.draft_id,
    input,
    signal,
    meta(`preview-${version}`),
  );
  const published = await service.publish(
    db,
    preview.preview_id,
    preview.expected,
    meta(`publish-${version}`),
    events(),
    signal,
  );
  return { ...published, preview };
}
const count = async (table: string) =>
  (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))
    .rows[0]!.n;
beforeAll(async () => {
  template = await migratedTemplate();
  core = await coreMigrations();
});
afterAll(async () => {
  await template.close();
  await core.cleanup();
});
beforeEach(async () => {
  db = await template.fresh();
  await migrate(
    db,
    core.directory,
    await loadPluginMigrations([migrationSource]),
  );
});
afterEach(async () => {
  await db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await loadPlugins(loadConfig({}, { version: 1 }), "api", { env: {} });
});

it("keeps imported drafts and previews inactive, then publishes and atomically activates with history", async () => {
  const imported = await service.import(db, await candidate(), meta("import"));
  const before = await count("plugin_event_outbox");
  const preview = await service.previewDraft(
    db,
    imported.draft_id,
    input,
    signal,
    meta("preview"),
  );
  expect(
    (await new Repository(db).head(source.source_id)).active_version,
  ).toBeNull();
  expect(await count("plg_msot_source")).toBe(0);
  expect(await count("plg_msot_version")).toBe(0);
  expect(await count("plugin_event_outbox")).toBe(before);
  expect(preview.groups).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        issuer_id: "issuer-demo-a",
        market_segment: "off_exchange",
        unknown_to_known: 1,
      }),
    ]),
  );
  expect(preview.after.msot.provenance[0]?.set_by).toBe("operator-demo");
  await service.publish(
    db,
    preview.preview_id,
    preview.expected,
    meta("publish"),
    events(),
    signal,
  );
  expect(
    (await new Repository(db).head(source.source_id)).active_version,
  ).toBeNull();
  expect(await count("plg_msot_version")).toBe(1);
  await service.activate(
    db,
    source.source_id,
    1,
    { version: null, activation: 0 },
    meta("activate"),
    events(),
  );
  expect(await new Repository(db).head(source.source_id)).toEqual({
    active_version: 1,
    activation_sequence: 1,
  });
  expect(await count("plg_msot_activation")).toBe(1);
  expect(await count("plg_msot_audit")).toBe(4);
  const outbox = (
    await db.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM plugin_event_outbox WHERE event_type='msot.changed' ORDER BY payload->>'operation'",
    )
  ).rows;
  expect(outbox).toHaveLength(2);
  expect(outbox.map((r) => r.payload.operation).sort()).toEqual([
    "activate",
    "publish",
  ]);
  expect(JSON.stringify(outbox)).not.toContain("operator-demo");
  expect(JSON.stringify(outbox)).not.toContain("value");
  const saved = await new Repository(db).inspection(source.source_id);
  expect(saved.lineage).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        entity_ref: "rule:payment-tx-off",
        row_ref: "/rules/0",
        actor_class: "shell_asserted",
      }),
    ]),
  );
});

it("rollback appends history, preserves newer versions and retirement refuses reactivation", async () => {
  const first = await publish();
  await service.activate(
    db,
    source.source_id,
    1,
    { version: null, activation: 0 },
    meta("activate1"),
    events(),
  );
  const second = await publish(2, false);
  expect(second.preview.groups.some((g) => g.true_to_false === 1)).toBe(true);
  await service.activate(
    db,
    source.source_id,
    2,
    { version: 1, activation: 1 },
    meta("activate2"),
    events(),
  );
  await service.activate(
    db,
    source.source_id,
    1,
    { version: 2, activation: 2 },
    meta("rollback"),
    events(),
    "rollback",
  );
  expect(await new Repository(db).head(source.source_id)).toEqual({
    active_version: 1,
    activation_sequence: 3,
  });
  expect((await new Repository(db).version(source.source_id, 1)).hash).toBe(
    first.version_hash,
  );
  expect(await count("plg_msot_version")).toBe(2);
  const inspection = await new Repository(db).inspection(source.source_id);
  expect(inspection.activations[0]?.operation).toBe("rollback");
  await service.activate(
    db,
    source.source_id,
    1,
    { version: 1, activation: 3 },
    meta("retire"),
    events(),
    "retire",
  );
  await expect(
    service.activate(
      db,
      source.source_id,
      1,
      { version: null, activation: 4 },
      meta("revive"),
      events(),
    ),
  ).rejects.toThrow("msot_version_unavailable");
  expect(await count("plg_msot_activation")).toBe(4);
});

it("JSON and CSV keep identifiers, booleans, explicit unknown and artifact row lineage", async () => {
  const json = JSON.stringify({ ...source, rules: [] });
  const csv =
    "id,issuer_id,state,market_segment,field,value_state,value,valid_from,valid_until,reason_code\r\n" +
    "payment,00123,DC,off_exchange,custom_payment_allowed,known,false,2026-11-15,,payment_disabled\r\n" +
    "unknown,00123,DC,on_exchange,custom_payment_allowed,unknown,,2026-11-15,,pending\r\n";
  const parsed = await parseFiles(
    json,
    "operator-demo",
    "2026-11-16T00:00:00Z",
    reader,
    csv,
  );
  expect(parsed.source.rules[0]?.scope.issuer_id).toBe("00123");
  expect(parsed.source.rules[0]?.value).toEqual({
    state: "known",
    value: false,
  });
  expect(parsed.source.rules[1]?.value).toEqual({
    state: "unknown",
    value: null,
  });
  expect(parsed.rowRefs["rule:payment"]).toEqual({
    input_hash: parsed.artifacts[1]!.sha256,
    row_ref: "line:2",
  });
  const imported = await service.import(db, parsed, meta("import-csv"));
  const restored = await new Repository(db).draft(imported.draft_id);
  expect(restored.artifacts[1]?.text).toBe(csv);
  expect(restored.source).toEqual(parsed.source);
  expect(restored.hash).toBe(compileSource(restored.source, reader).hash);
});

describe("publication rejection controls", () => {
  it("rejects a blank known boolean and forged author in fixture uploads", async () => {
    const json = JSON.stringify({ ...source, rules: [] });
    const csv =
      "id,issuer_id,state,market_segment,field,value_state,value,valid_from,valid_until,reason_code\n" +
      "blank,00123,DC,off_exchange,custom_payment_allowed,known,,2026-11-15,,pending\n";
    await expect(
      parseFiles(json, "operator-demo", "2026-11-16T00:00:00Z", reader, csv),
    ).rejects.toThrow("msot_csv_boolean_required");
    await expect(
      parseFiles(
        JSON.stringify(source),
        "forged-actor",
        "2026-11-16T00:00:00Z",
        reader,
      ),
    ).rejects.toThrow("msot_actor_mismatch");
  });
  it("refuses an equal-rank time overlap before any draft is imported", async () => {
    const invalid = {
      ...source,
      rules: [source.rules[0], { ...source.rules[0], id: "collision" }],
    };
    await expect(
      parseFiles(
        JSON.stringify(invalid),
        "operator-demo",
        "2026-11-16T00:00:00Z",
        reader,
      ),
    ).rejects.toThrow("msot_equal_rank_overlap");
    expect(await count("plg_msot_draft")).toBe(0);
  });
  it("refuses stale public generation, changed input hash and an expected-version conflict", async () => {
    let generation = "synthetic-g1";
    const changing = new VersionService({
      ...reader,
      plans: async (...args) => ({
        ...(await reader.plans(...args)),
        catalog_generation: generation,
      }),
    });
    const imported = await changing.import(
      db,
      await candidate(),
      meta("import"),
    );
    const preview = await changing.previewDraft(
      db,
      imported.draft_id,
      input,
      signal,
      meta("preview"),
    );
    generation = "synthetic-g2";
    await expect(
      changing.publish(
        db,
        preview.preview_id,
        preview.expected,
        meta("publish-stale"),
        events(),
        signal,
      ),
    ).rejects.toThrow("msot_preview_stale");
    generation = "synthetic-g1";
    await expect(
      changing.publish(
        db,
        preview.preview_id,
        { version: 3, activation: 0 },
        meta("publish-conflict"),
        events(),
        signal,
      ),
    ).rejects.toThrow("msot_expected_version_conflict");
    await db.query(
      "UPDATE plg_msot_draft SET version_hash=$1 WHERE draft_id=$2",
      ["f".repeat(64), imported.draft_id],
    );
    await expect(
      changing.publish(
        db,
        preview.preview_id,
        preview.expected,
        meta("publish-mutated"),
        events(),
        signal,
      ),
    ).rejects.toThrow("msot_input_changed");
    expect(await count("plg_msot_version")).toBe(0);
    expect(await count("plugin_event_outbox")).toBe(0);
  });
  it("rejects an activation race and a reused predecessor after rollback", async () => {
    await publish();
    await service.activate(
      db,
      source.source_id,
      1,
      { version: null, activation: 0 },
      meta("activate"),
      events(),
    );
    await expect(
      service.activate(
        db,
        source.source_id,
        1,
        { version: null, activation: 0 },
        meta("racing"),
        events(),
      ),
    ).rejects.toThrow("msot_expected_version_conflict");
    expect(await count("plg_msot_activation")).toBe(1);
  });
  it.each(["outbox", "audit"])(
    "rolls back the pointer and history when the %s write fails",
    async (target) => {
      await publish();
      const originalAudit = await count("plg_msot_audit");
      const table =
        target === "outbox" ? "plugin_event_outbox" : "plg_msot_audit";
      await db.exec(`CREATE FUNCTION synthetic_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic write failure'; END $$;
      CREATE TRIGGER synthetic_refuse BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_refuse()`);
      await expect(
        service.activate(
          db,
          source.source_id,
          1,
          { version: null, activation: 0 },
          meta("activate-fail"),
          events(),
        ),
      ).rejects.toThrow();
      expect(
        await new Repository(db).head(source.source_id),
        "partially_committed_activation",
      ).toEqual({ active_version: null, activation_sequence: 0 });
      expect(
        await count("plg_msot_activation"),
        "partially_committed_activation",
      ).toBe(0);
      expect(await count("plg_msot_audit")).toBe(
        originalAudit + (target === "outbox" ? 1 : 0),
      );
      expect(await count("plugin_event_outbox")).toBe(1);
    },
  );
  it("rejects an out-of-prefix application-state declaration and migration", async () => {
    expect(
      pluginManifestSchema.safeParse({
        ...plugin.manifest,
        applicationState: [{ table: "plg_other_policy", reason: "synthetic" }],
      }).success,
    ).toBe(false);
    await expect(
      loadPluginMigrations([
        {
          ...migrationSource,
          applicationState: [{ table: "plan", reason: "synthetic" }],
        },
      ]),
    ).rejects.toThrow("plugin_migration_scope");
    const dir = await mkdtemp(join(tmpdir(), "msot-invalid-"));
    try {
      await writeFile(
        join(dir, "001_invalid.sql"),
        "CREATE TABLE outside_prefix (id text);",
      );
      await expect(
        loadPluginMigrations([{ ...migrationSource, directory: dir }]),
      ).rejects.toThrow("plugin_migration_scope");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("installs app-state provenance and generation triggers; missing declaration fails the schema check", async () => {
  expect(await schemaViolations(db)).toEqual([]);
  expect(await receiptViolations(db)).toEqual([]);
  expect(await checkCatalogTriggers(db)).toEqual([]);
  const imported = await service.import(db, await candidate(), meta("import"));
  const row = (
    await db.query(
      "SELECT sourced_by,sourced_at,sourced_slug,record_policy,record_ttl FROM plg_msot_draft WHERE draft_id=$1",
      [imported.draft_id],
    )
  ).rows[0];
  expect(row).toEqual({
    sourced_by: "openplans",
    sourced_at: null,
    sourced_slug: "app:plugin-msot:plg_msot_draft",
    record_policy: "app_state",
    record_ttl: null,
  });
  const missing = await template.fresh();
  try {
    await migrate(
      missing,
      core.directory,
      await loadPluginMigrations([
        { ...migrationSource, applicationState: undefined },
      ]),
    );
    await expect(
      service.import(missing, await candidate(), meta("missing-provenance")),
    ).rejects.toThrow("msot_application_state_required");
    expect(
      await schemaViolations(missing),
      "missing_app_state_provenance",
    ).toContain(
      "plg_msot_draft: no receipt reference; add a row_provenance_rule",
    );
  } finally {
    await missing.close();
  }
});

it("backup restoration retains immutable explanations, audit, private artifacts and activation history", async () => {
  const pg = new PGlite();
  const backupDb = testDatabase(pg);
  try {
    await migrate(
      backupDb,
      core.directory,
      await loadPluginMigrations([migrationSource]),
    );
    const bus = createEventBus({ db: backupDb, log: () => {} }).registry({
      kind: "plugin",
      manifest: plugin.manifest,
    });
    const imported = await service.import(
      backupDb,
      await candidate(),
      meta("import"),
    );
    const preview = await service.previewDraft(
      backupDb,
      imported.draft_id,
      input,
      signal,
      meta("preview"),
    );
    await service.publish(
      backupDb,
      preview.preview_id,
      preview.expected,
      meta("publish"),
      bus,
      signal,
    );
    await service.activate(
      backupDb,
      source.source_id,
      1,
      preview.expected,
      meta("activate"),
      bus,
    );
    const expected = await new Repository(backupDb).inspection(
      source.source_id,
    );
    expect(
      backupExcludedTables([]).some((t) => t.startsWith("plg_msot_")),
    ).toBe(false);
    const restoredPg = new PGlite({ loadDataDir: await pg.dumpDataDir() });
    const restored = testDatabase(restoredPg);
    try {
      expect(
        await new Repository(restored).inspection(source.source_id),
      ).toEqual(expected);
      const saved = await new Repository(restored).version(source.source_id, 1);
      const explanation = await compileSource(saved.source, reader).resolve(
        input,
        { db: restored, signal },
      );
      expect(explanation).toEqual(preview.after);
      expect(
        await new Repository(restored).audit(source.source_id),
      ).toHaveLength(4);
      expect(await receiptViolations(restored)).toEqual([]);
    } finally {
      await restored.close();
    }
  } finally {
    await backupDb.close();
  }
});

it("protects inspection and read-only preview with the operator token and readable-source set", async () => {
  await publish();
  const config = loadConfig(
    {},
    {
      version: 1,
      plugins: {
        entries: [
          {
            package: "@openplans/plugin-msot",
            options: { readableSources: [source.source_id] },
          },
        ],
      },
    },
  );
  const loaded = await loadPlugins(config, "api", {
    env: {},
    canonicalReader: reader,
  });
  const app = createApp(db, undefined, { plugins: loaded.registries });
  vi.stubEnv("OPENPLANS_OPERATOR_TOKEN", undefined);
  expect(
    (await app.request(`/msot/versions?source_id=${source.source_id}`)).status,
  ).toBe(404);
  vi.stubEnv("OPENPLANS_OPERATOR_TOKEN", "synthetic-operator-token");
  expect(
    (await app.request(`/msot/versions?source_id=${source.source_id}`)).status,
  ).toBe(401);
  const headers = {
    authorization: "Bearer synthetic-operator-token",
    "content-type": "application/json",
  };
  const response = await app.request(
    `/msot/inspect?source_id=${source.source_id}&version=1`,
    { headers },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(
    (await app.request("/msot/versions?source_id=another-source", { headers }))
      .status,
  ).toBe(400);
  const countBefore = await count("plg_msot_audit");
  const preview = await app.request("/msot/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ source, input }),
  });
  expect(preview.status).toBe(200);
  expect(await count("plg_msot_audit")).toBe(countBefore);
  expect(await count("plg_msot_activation")).toBe(0);
});

it("runs file authoring commands through the existing worker registry", async () => {
  const kit = await loadForTest(plugin, {
    packageRoot: new URL("../", import.meta.url),
    canonicalReader: reader,
  });
  const dir = await mkdtemp(join(tmpdir(), "msot-worker-"));
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const file = join(dir, "source.json");
    await writeFile(file, JSON.stringify(source));
    const registered = kit.registrations.workerCommands;
    const run: WorkerContext = {
      ...kit.context,
      events: events(),
      state: {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
      },
      signal,
      db: { reader: db, writer: db },
    };
    const validate = registered.find((c) => c.argv[1] === "validate")!;
    expect(
      await validate.run(["--file", file, "--actor", "operator-demo"], run),
    ).toBe(0);
    const imported = registered.find((c) => c.argv[1] === "import")!;
    expect(
      await imported.run(["--file", file, "--actor", "operator-demo"], run),
    ).toBe(0);
    expect(await count("plg_msot_draft")).toBe(1);
    expect(await imported.run(["--file", file, "--actor", "spoof"], run)).toBe(
      1,
    );
    const importedResult = JSON.parse(String(output.mock.calls.at(-1)![0])) as {
      draft_id: string;
    };
    const previewFile = join(dir, "input.json");
    await writeFile(previewFile, JSON.stringify(input));
    const invoke = async (name: string, args: string[]) => {
      const command = registered.find((c) => c.argv[1] === name)!;
      expect(await command.run(args, run), `worker_${name}`).toBe(0);
      return JSON.parse(String(output.mock.calls.at(-1)![0])) as Record<
        string,
        unknown
      >;
    };
    const previewResult = await invoke("preview", [
      "--draft",
      importedResult.draft_id,
      "--input",
      previewFile,
      "--actor",
      "operator-demo",
    ]);
    await invoke("publish", [
      "--preview",
      String(previewResult.preview_id),
      "--expected-version",
      "none",
      "--expected-activation",
      "0",
      "--actor",
      "operator-demo",
    ]);
    await invoke("activate", [
      "--source",
      source.source_id,
      "--version",
      "1",
      "--expected-version",
      "none",
      "--expected-activation",
      "0",
      "--actor",
      "operator-demo",
    ]);
    const exported = await invoke("export", ["--source", source.source_id]);
    expect(exported).toEqual(source);
    await invoke("inspect", ["--source", source.source_id]);
    await invoke("retire", [
      "--source",
      source.source_id,
      "--version",
      "1",
      "--expected-version",
      "1",
      "--expected-activation",
      "1",
      "--actor",
      "operator-demo",
    ]);
    expect(output.mock.calls.length).toBe(8);
    expect(registered.map((c) => c.argv[1]).sort()).toEqual([
      "activate",
      "export",
      "import",
      "inspect",
      "preview",
      "publish",
      "retire",
      "validate",
    ]);
  } finally {
    await kit.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("pins production public facts across receipt writes and resolves only an activated persisted version", async () => {
  const { digestFixture } = await import("../../../tests/plugins/fixture.js");
  const { canonicalReader } =
    await import("../../../src/plugins/canonical-reader.js");
  const fixture = await digestFixture();
  try {
    await migrate(
      fixture.db,
      core.directory,
      await loadPluginMigrations([migrationSource]),
    );
    const plan = (
      await fixture.db.query<{
        base_plan_id: string;
        issuer_id: string;
        state: string;
      }>(
        "SELECT base_plan_id,issuer_id,state FROM plan WHERE off_exchange IS TRUE LIMIT 1",
      )
    ).rows[0]!;
    const authored = structuredClone(source);
    authored.rules[0]!.scope = {
      issuer_id: plan.issuer_id,
      state: plan.state,
      market_segment: "off_exchange",
    };
    const prepared = await parseFiles(
      JSON.stringify(authored),
      "operator-demo",
      "2026-11-16T00:00:00Z",
      canonicalReader,
    );
    const current = new VersionService(canonicalReader);
    const context = { db: fixture.db, signal };
    const request = { ...input, plan_ids: [plan.base_plan_id] };
    const imported = await current.import(fixture.db, prepared, meta("import"));
    const preview = await current.previewDraft(
      fixture.db,
      imported.draft_id,
      request,
      signal,
      meta("preview"),
    );
    const bus = createEventBus({ db: fixture.db, log: () => {} }).registry({
      kind: "plugin",
      manifest: plugin.manifest,
    });
    await current.publish(
      fixture.db,
      preview.preview_id,
      preview.expected,
      meta("publish"),
      bus,
      signal,
    );
    const loaded = await loadPlugins(
      loadConfig(
        {},
        {
          version: 1,
          plugins: {
            entries: [
              {
                package: "@openplans/plugin-msot",
                options: { readableSources: [source.source_id] },
              },
            ],
          },
        },
      ),
      "api",
      { env: {} },
    );
    const provider = loaded.registries.catalogPolicies.msot!.spec;
    await expect(provider.resolve(request, context)).rejects.toThrow(
      "msot_version_unavailable",
    );
    await current.activate(
      fixture.db,
      source.source_id,
      1,
      { version: null, activation: 0 },
      meta("activate"),
      bus,
    );
    const resolved = await provider.resolve(request, context);
    expect(resolved.msot.version_hash).toBe(preview.candidate_hash);
    expect(resolved.msot.catalog_generation).toBe(preview.catalog_generation);
    expect(
      resolved.plans[0]?.msot.by_market_segment.off_exchange?.fields
        .custom_payment_allowed?.value,
    ).toBe(true);
    const invalid = structuredClone(authored);
    invalid.version = 2;
    invalid.rules[0]!.scope.issuer_id = "unregistered-issuer";
    const invalidCandidate = await parseFiles(
      JSON.stringify(invalid),
      "operator-demo",
      "2026-11-16T00:00:00Z",
      canonicalReader,
    );
    await expect(
      current.preview(invalidCandidate, request, context),
    ).rejects.toThrow("msot_scope_identity_unknown");
    const second = await current.import(
      fixture.db,
      await parseFiles(
        JSON.stringify({ ...authored, version: 2 }),
        "operator-demo",
        "2026-11-16T00:00:00Z",
        canonicalReader,
      ),
      meta("import2"),
    );
    const stale = await current.previewDraft(
      fixture.db,
      second.draft_id,
      request,
      signal,
      meta("preview2"),
    );
    await fixture.db.query(
      "UPDATE plan SET plan_name='Synthetic changed display' WHERE base_plan_id=$1",
      [plan.base_plan_id],
    );
    await expect(
      current.publish(
        fixture.db,
        stale.preview_id,
        stale.expected,
        meta("publish-stale"),
        bus,
        signal,
      ),
    ).rejects.toThrow("msot_preview_stale");
  } finally {
    await fixture.close();
  }
});

it("refuses an outbox key collision instead of committing an activation without its event", async () => {
  await publish();
  await events().emit({
    type: "msot.review_required",
    idempotencyKey: "msot:collision",
    payload: {
      sourceId: source.source_id,
      versionHash: "a".repeat(64),
      changedCount: 1,
      reasonCode: "synthetic",
    },
  });
  await expect(
    service.activate(
      db,
      source.source_id,
      1,
      { version: null, activation: 0 },
      meta("collision"),
      events(),
    ),
  ).rejects.toThrow();
  expect(await new Repository(db).head(source.source_id)).toEqual({
    active_version: null,
    activation_sequence: 0,
  });
  expect(await count("plg_msot_activation")).toBe(0);
  expect(await new Repository(db).audit(source.source_id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        operation: "rejected:activate",
        attempt_key: "collision",
      }),
    ]),
  );
});

it("pins one UTC date for both sides of an undated preview across midnight", async () => {
  await publish();
  await service.activate(
    db,
    source.source_id,
    1,
    { version: null, activation: 0 },
    meta("activate"),
    events(),
  );
  const prepared = await candidate(2, false);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T23:59:59Z"));
  try {
    const crossing = new VersionService({
      ...reader,
      plans: async (...args) => {
        const result = await reader.plans(...args);
        vi.setSystemTime(new Date("2026-11-17T00:00:01Z"));
        return result;
      },
    });
    const { as_of: _date, ...undated } = input;
    const preview = await crossing.preview(prepared, undated, { db, signal });
    expect(preview.after.msot.as_of).toBe("2026-11-16");
    expect(preview.before?.msot.as_of, "preview_date_is_pinned").toBe(
      preview.after.msot.as_of,
    );
  } finally {
    vi.useRealTimers();
  }
});
