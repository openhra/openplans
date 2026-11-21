import { PGlite } from "@electric-sql/pglite";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { FeedSource } from "@openplans/plugin-sdk";
import type { Database } from "../../src/db/database.js";
import { migrate } from "../../src/db/migrate.js";
import type {
  AdmissionManifest,
  AdmissionReceipt,
} from "../../src/fetch/index.js";
import { installDataPackage } from "../../src/registry/data/install.js";
import { runPackageFeed } from "../../src/plugins/sources/package-feed.js";
import { runFeedSource } from "../../src/plugins/sources/feed.js";
import type { FeedRunOptions } from "../../src/plugins/sources/feed.js";
import { feedWorkerCommands } from "../../src/plugins/sources/index.js";
import { runWorker } from "../../src/worker/commands.js";
import { withDataPolicy } from "../../src/services/data-window.js";
import { verifyDirectory } from "../../src/plugins/package/verify.js";
import { sha256 } from "../../src/plugins/package/files.js";
import { writeArchive } from "../../src/plugins/package/archive.js";
import { installRegistryData } from "../../src/plugins/registry/client.js";
import { runPackageCommand } from "../../src/worker/commands/plugin-package-cli.js";
import { SyntheticRegistry } from "./registry-fixture.js";
import { plantMutant } from "../../src/plugins/testing/index.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { packagePufSource } from "../../src/registry/data/puf.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { IMPORT_KINDS } from "../../src/ingest/puf/import-source.js";
import { runCorePackageIngest } from "../../src/worker/commands/package-ingest.js";
import { syntheticPackagePufs } from "./package-puf-fixture.js";
import { seal, syntheticDataManifest } from "./package-fixture.js";

vi.mock("../../src/fetch/limiter.js", () => ({
  leaseHost: async () => async () => {},
}));
const fixture = new URL("../fixtures/plugins/synthetic-feed/", import.meta.url);
const { source: base } = (await import(new URL("index.mjs", fixture).href)) as {
  source: FeedSource;
};
const HOST = "feed.synthetic.test";
const FILE_URL = `https://${HOST}/feed/items.json`;
const retrievedAt = "2026-10-01T00:00:00Z";
const at = () => new Date("2026-11-19T00:00:00Z");
const robots = "User-agent: *\nAllow: /\n";
const terms = "Synthetic collection and redistribution evidence. No real data.";
let scratch: string;
let pg: PGlite;
let db: Database;
let cleanup: () => Promise<void>;
let output: string[];
let requests: string[];
let access: string;
let caseNumber = 0;

// Labelled synthetic rates test the input path only; these are never served as plan premiums.
const source: FeedSource = {
  ...base,
  async plan() {
    return {
      files: [{ url: FILE_URL, expectedContent: "json", maxBytes: 4096 }],
      requireRows: ["synthetic_feed_item"],
    };
  },
  async validate(_ctx, tx) {
    const { rows } = await tx.query<{ label: string }>(
      "SELECT label FROM synthetic_feed_item",
    );
    return rows.every((row) => /^\d+$/.test(row.label))
      ? { ok: true }
      : { ok: false, reasonCode: "synthetic_rate_invalid" };
  },
};
const options = (): FeedRunOptions => ({
  declaredHosts: [HOST],
  dataDir: scratch,
  manifestPaths: [access],
  now: at,
  lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  sleep: async () => {},
  maxAttempts: 1,
  transport: async (url) => {
    requests.push(url.href);
    const { Readable } = await import("node:stream");
    const body = (
      { "/robots.txt": robots, "/terms": terms } as Record<string, string>
    )[url.pathname];
    if (!body)
      throw new Error("Synthetic test forbids upstream data downloads");
    return { status: 200, headers: {}, body: Readable.from([body]) };
  },
  output: {
    out: (line) => output.push(line),
    error: (line) => output.push(line),
  },
});
async function makePackage(label = "12000", years = [2026]) {
  const root = join(scratch, `input-${++caseNumber}`);
  await mkdir(join(root, "chunks"), { recursive: true });
  await mkdir(join(root, "evidence"));
  const manifest = syntheticDataManifest();
  manifest.planYears = years;
  const body = Buffer.from(JSON.stringify([{ code: "SYNTHETIC-RATE", label }]));
  const receipt: AdmissionReceipt = {
    manifestSha256: sha256(await readFile(access)),
    hosts: [
      {
        host: HOST,
        state: "allowed",
        termsSha256: sha256(terms),
        termsUrl: `https://${HOST}/terms`,
        robots: {
          url: `https://${HOST}/robots.txt`,
          status: 200,
          sha256: sha256(robots),
          checkedAt: retrievedAt,
        },
      },
    ],
  };
  const admission = Buffer.from(JSON.stringify(receipt));
  const file = manifest.data.files[0]!;
  file.path = "original/synthetic-rates.json";
  file.bytes = file.expandedBytes = body.length;
  file.sha256 = sha256(body);
  file.origin = {
    url: FILE_URL,
    sha256: file.sha256,
    retrievedAt,
    admission: { path: "evidence/admission.json", sha256: sha256(admission) },
  };
  file.redistribution = {
    status: "allowed",
    termsUrl: `https://${HOST}/terms`,
    evidence: { path: "evidence/rights.txt", sha256: sha256(terms) },
  };
  file.chunks = [{ sha256: file.sha256, bytes: file.bytes }];
  await writeFile(join(root, "chunks", file.sha256), body);
  await writeFile(join(root, file.origin.admission.path), admission);
  await writeFile(join(root, file.redistribution.evidence.path), terms);
  await seal(root, manifest);
  const reviewPath = join(scratch, `review-${caseNumber}.json`);
  const review = {
    schemaVersion: 1,
    manifestSha256: (await verifyDirectory(root)).manifestSha256,
    source: source.id,
    sourceArgs: ["--case", "happy"],
    scope: years.length ? "annual" : "snapshot",
    domain: "individual",
    planYears: years,
    reviewedAt: at().toISOString(),
    files: [
      {
        url: FILE_URL,
        upstreamSha256: file.sha256,
        retrievedAt,
        response: {
          status: 200,
          finalUrl: FILE_URL,
          redirectChain: [],
          contentType: "application/json",
          etag: null,
          lastModified: null,
        },
        admissionSha256: file.origin.admission.sha256,
        redistribution: {
          status: "allowed",
          termsUrl: file.redistribution.termsUrl,
          evidenceSha256: file.redistribution.evidence.sha256,
        },
      },
    ],
  };
  await writeFile(reviewPath, JSON.stringify(review));
  return { root, manifest, review, reviewPath };
}
async function makePufPackage(poisoned = false) {
  const input = await makePackage();
  const template = input.manifest.data.files[0]!;
  await rm(join(input.root, "chunks", template.sha256));
  const files = syntheticPackagePufs(poisoned);
  input.manifest.data.files = await Promise.all(
    IMPORT_KINDS.map(async (kind) => {
      const body = Buffer.from(files[kind]);
      const hash = sha256(body);
      await writeFile(join(input.root, "chunks", hash), body);
      return {
        ...template,
        path: `original/${kind}.csv`,
        bytes: body.length,
        expandedBytes: body.length,
        sha256: hash,
        origin: {
          ...template.origin,
          url: `https://${HOST}/feed/${kind}.csv`,
          sha256: hash,
        },
        chunks: [{ sha256: hash, bytes: body.length }],
      };
    }),
  );
  await seal(input.root, input.manifest);
  input.review.manifestSha256 = (
    await verifyDirectory(input.root)
  ).manifestSha256;
  input.review.source = "cms-exchange-puf-package";
  input.review.sourceArgs = ["--year", "2026", "--state", "TX"];
  const templateReview = input.review.files[0]!;
  input.review.files = input.manifest.data.files.map((file) => ({
    ...templateReview,
    url: file.origin.url,
    upstreamSha256: file.sha256,
    response: {
      ...templateReview.response,
      finalUrl: file.origin.url,
      contentType: "text/csv",
    },
  }));
  await writeFile(input.reviewPath, JSON.stringify(input.review));
  return input;
}

const snapshots = async () =>
  (
    await db.query<{ snapshot_id: string; validation_state: string }>(
      "SELECT snapshot_id,validation_state FROM snapshot WHERE source_id='synthetic-feed' ORDER BY snapshot_id",
    )
  ).rows;
const ingest = (
  root: string,
  review: string,
  feed = source,
  settings = options(),
) =>
  withDataPolicy(
    { historyYears: 3 },
    () => runPackageFeed(root, review, feed, ["--case", "happy"], db, settings),
    at(),
  );

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "openplans-synthetic-package-feed-"));
  access = join(scratch, "access.json");
  const manifest: AdmissionManifest = {
    version: 1,
    publishers: [
      {
        host: HOST,
        state: "allowed",
        evidence: [
          {
            url: `https://${HOST}/terms`,
            observedAt: at().toISOString(),
            status: 200,
          },
        ],
        scope: { products: ["synthetic"], states: ["TX"], years: [2026] },
        discoveryUrls: [FILE_URL],
        permittedPaths: ["/feed"],
        delegates: [],
        attribution: "Synthetic fixture",
        updatePolicy: "Recheck daily",
        delayMs: 5000,
        jobCaps: { maxRequests: 100, maxTransferBytes: 100000 },
        robots: {
          url: `https://${HOST}/robots.txt`,
          status: 200,
          sha256: sha256(robots),
          checkedAt: at().toISOString(),
        },
        terms: {
          url: `https://${HOST}/terms`,
          disposition: "allowed",
          sha256: sha256(terms),
          reviewedAt: "2026-01-01T00:00:00Z",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      },
    ],
  };
  await writeFile(access, JSON.stringify(manifest));
  const core = await coreMigrations();
  cleanup = core.cleanup;
  await cp(
    fileURLToPath(new URL("migration.sql", fixture)),
    join(core.directory, "9000_synthetic_feed.sql"),
  );
  await writeFile(
    join(core.directory, "INDEX"),
    (await readFile(join(core.directory, "INDEX"), "utf8")) +
      "9000_synthetic_feed.sql\n",
  );
  pg = new PGlite();
  db = testDatabase(pg);
  await migrate(db, core.directory);
}, 120000);
beforeEach(async () => {
  output = [];
  requests = [];
  await rm(join(scratch, "data-packages"), { recursive: true, force: true });
  await db.exec(
    "DELETE FROM synthetic_feed_item; DELETE FROM quality_issue WHERE source_id='synthetic-feed'; DELETE FROM snapshot WHERE source_id='synthetic-feed'; DELETE FROM plugin_event_outbox;",
  );
});
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await pg?.close();
  await cleanup?.();
  await rm(scratch, { recursive: true, force: true });
});

describe("data packages through normal feed activation", () => {
  it("installs without database writes; explicit ingest keeps origins, row provenance and an audit record", async () => {
    const input = await makePackage();
    const installed = await installDataPackage(input.root, scratch);
    expect(installed).toMatchObject({
      activation: "not_requested",
      evidence: "complete",
    });
    expect(await snapshots()).toEqual([]);
    expect(await ingest(installed.directory, input.reviewPath)).toBe(0);
    const [snapshot] = await snapshots();
    expect(snapshot?.validation_state).toBe("ACTIVE");
    const { rows } = await db.query(
      "SELECT requested_url,sha256,retrieved_at::text FROM snapshot WHERE snapshot_id=$1",
      [snapshot!.snapshot_id],
    );
    expect(rows[0]).toMatchObject({
      requested_url: FILE_URL,
      sha256: input.manifest.data.files[0]!.sha256,
      retrieved_at: "2026-10-01 00:00:00+00",
    });
    const result = (
      await db.query(
        "SELECT sourced_by,sourced_slug,label FROM synthetic_feed_item",
      )
    ).rows[0];
    expect(result).toMatchObject({
      sourced_by: source.id,
      sourced_slug: snapshot!.snapshot_id,
      label: "12000",
    });
    const audit = JSON.parse(
      (
        await db.query<{ explanation: string }>(
          "SELECT explanation FROM quality_issue WHERE issue_code='data_package_input'",
        )
      ).rows[0]!.explanation,
    ) as Record<string, unknown>;
    expect(audit).toMatchObject({
      via: "registry:@synthetic/data@1.0.0",
      manifestSha256: installed.manifestSha256,
      reviewSha256: sha256(await readFile(input.reviewPath)),
      origins: input.manifest.data.files,
    });
    expect(
      requests.every(
        (url) => url.endsWith("/robots.txt") || url.endsWith("/terms"),
      ),
    ).toBe(true);
  });

  it("produces the same synthetic response digest and provenance shape as the direct feed path", async () => {
    const input = await makePackage();
    const body = await readFile(
      join(input.root, "chunks", input.manifest.data.files[0]!.sha256),
    );
    const direct = options();
    const policyTransport = direct.transport!;
    direct.transport = async (url, settings) => {
      if (url.href !== FILE_URL) return policyTransport(url, settings);
      const { Readable } = await import("node:stream");
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Readable.from([body]),
      };
    };
    expect(await runFeedSource(source, ["--case", "happy"], db, direct)).toBe(
      0,
    );
    const read = async () =>
      (
        await db.query(
          "SELECT item_code,label,sourced_by FROM synthetic_feed_item ORDER BY item_code",
        )
      ).rows;
    const directDigest = sha256(JSON.stringify(await read()));
    expect(await ingest(input.root, input.reviewPath)).toBe(0);
    expect(sha256(JSON.stringify(await read()))).toBe(directDigest);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM synthetic_feed_item r JOIN snapshot s ON s.snapshot_id=r.sourced_slug WHERE s.validation_state='ACTIVE' AND r.sourced_by=s.source_id",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it("installs a small signed local-registry data artifact and the local data CLI without activating either", async () => {
    const input = await makePackage();
    const repository = await new SyntheticRegistry(
      join(scratch, "signed-data-registry"),
      input.manifest.name,
    ).initialize();
    const archive = join(scratch, "synthetic-data-package.tgz");
    await writeArchive(
      input.root,
      (await verifyDirectory(input.root)).files,
      archive,
    );
    repository.body = await readFile(archive);
    await repository.publish({ version: 2 });
    await repository.trust(scratch);
    const installed = await installRegistryData(
      `${input.manifest.name}@1.0.0`,
      { url: repository.url, dataDir: scratch },
    );
    expect(installed.activation).toBe("not_requested");
    expect(JSON.parse(await readFile(installed.receipt, "utf8"))).toMatchObject(
      { origin: `registry:${repository.url}`, activation: "not_requested" },
    );
    const cliData = join(scratch, "local-cli-data");
    expect(
      await runPackageCommand(
        ["plugin", "install", "--data", input.root],
        options().output!,
        { OPENPLANS_DATA_DIR: cliData },
      ),
    ).toBe(0);
    const registryCliData = join(scratch, "registry-cli-data");
    const registryCliConfig = join(scratch, "registry-cli-config.json");
    const registryCliLock = join(registryCliData, "plugins.lock.json");
    await writeFile(
      registryCliConfig,
      JSON.stringify({ version: 1, plugins: { lockfile: registryCliLock } }),
    );
    expect(
      await runPackageCommand(
        [
          "plugin",
          "install",
          "--data",
          `${input.manifest.name}@1.0.0`,
          "--registry",
          repository.url,
        ],
        options().output!,
        {
          OPENPLANS_DATA_DIR: registryCliData,
          OPENPLANS_CONFIG: registryCliConfig,
          OPENPLANS_REGISTRY_TRUST: join(scratch, "registries/trust.json"),
        },
      ),
    ).toBe(0);
    expect(JSON.parse(output.at(-1)!) as unknown).toMatchObject({
      activation: "not_requested",
      name: input.manifest.name,
    });
    await expect(readFile(registryCliLock)).rejects.toThrow();
    expect(await snapshots()).toEqual([]);
    await expect(
      readFile(join(cliData, "plugins", "plugins.lock.json")),
    ).rejects.toThrow();
  });

  it("quarantines poisoned synthetic rates and preserves the prior active rows", async () => {
    const good = await makePackage();
    expect(await ingest(good.root, good.reviewPath)).toBe(0);
    const earlier = await snapshots();
    const poisoned = await makePackage("-1");
    expect(await ingest(poisoned.root, poisoned.reviewPath)).toBe(1);
    expect(output.join("\n")).toContain("synthetic_rate_invalid");
    expect(await snapshots()).toEqual(
      expect.arrayContaining([
        ...earlier,
        expect.objectContaining({ validation_state: "QUARANTINED" }),
      ]),
    );
    expect(
      (await db.query("SELECT label FROM synthetic_feed_item")).rows,
    ).toEqual([{ label: "12000" }]);
  });

  it("refuses an incomplete shard set even with a matching local review", async () => {
    const input = await makePackage();
    const incomplete: FeedSource = {
      ...source,
      async plan() {
        const plan = await source.plan({} as never, []);
        plan.files.push({
          ...plan.files[0]!,
          url: `https://${HOST}/feed/required-shard.json`,
        });
        return plan;
      },
    };
    expect(await ingest(input.root, input.reviewPath, incomplete)).toBe(1);
    expect(await snapshots()).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("keeps missing licence evidence unknown and blocks activation", async () => {
    const input = await makePackage();
    await rm(
      join(
        input.root,
        input.manifest.data.files[0]!.redistribution.evidence.path,
      ),
    );
    await seal(input.root, input.manifest);
    expect((await verifyDirectory(input.root)).evidence).toBe("unknown");
    expect((await installDataPackage(input.root, scratch)).evidence).toBe(
      "unknown",
    );
    expect(await ingest(input.root, input.reviewPath)).toBe(1);
    expect(output.join("\n")).toContain("package_evidence_unknown");
    expect(await snapshots()).toEqual([]);
  });

  it.each([[2024], [2027]])(
    "refuses unserved year %j before any acquisition",
    async (year) => {
      const input = await makePackage("12000", [year]);
      expect(await ingest(input.root, input.reviewPath)).toBe(1);
      expect(output.join("\n")).toContain("package_year_outside_window");
      expect(await snapshots()).toEqual([]);
      expect(requests).toEqual([]);
    },
  );

  it("rechecks the year policy after staging at a calendar rollover", async () => {
    const input = await makePackage("12000", [2025]);
    let now = at();
    const changing: FeedSource = {
      ...source,
      async stage(...args) {
        const result = await source.stage(...args);
        now = new Date("2027-01-01T00:00:00Z");
        return result;
      },
    };
    expect(
      await ingest(input.root, input.reviewPath, changing, {
        ...options(),
        now: () => now,
      }),
    ).toBe(1);
    expect(await snapshots()).toEqual([
      expect.objectContaining({ validation_state: "QUARANTINED" }),
    ]);
    expect((await db.query("SELECT * FROM synthetic_feed_item")).rows).toEqual(
      [],
    );
  });

  it("refuses re-sealed bytes that differ from an independently pinned upstream hash", async () => {
    const input = await makePackage();
    const changed = await makePackage("99999");
    // Simulate a publisher re-signing poisoned data and its own claimed origin; the local acquisition pin survives.
    input.review.manifestSha256 = (
      await verifyDirectory(changed.root)
    ).manifestSha256;
    await writeFile(input.reviewPath, JSON.stringify(input.review));
    expect(await ingest(changed.root, input.reviewPath)).toBe(1);
    expect(output.join("\n")).toContain("package_origin_mismatch");
    expect(await snapshots()).toEqual([]);
  });

  it("refuses a substituted origin, a fake collector receipt and a bundled review", async () => {
    for (const mutation of ["origin", "receipt", "review"]) {
      const input = await makePackage();
      if (mutation === "review") {
        await cp(input.reviewPath, join(input.root, "review.json"));
        expect(await ingest(input.root, join(input.root, "review.json"))).toBe(
          1,
        );
      } else {
        if (mutation === "origin")
          input.manifest.data.files[0]!.origin.url = `https://${HOST}/feed/other.json`;
        else {
          const file = input.manifest.data.files[0]!;
          const bytes = JSON.stringify({ synthetic: true, result: "allowed" });
          file.origin.admission.sha256 = sha256(bytes);
          input.review.files[0]!.admissionSha256 = sha256(bytes);
          await writeFile(join(input.root, file.origin.admission.path), bytes);
        }
        await seal(input.root, input.manifest);
        input.review.manifestSha256 = (
          await verifyDirectory(input.root)
        ).manifestSha256;
        await writeFile(input.reviewPath, JSON.stringify(input.review));
        expect(await ingest(input.root, input.reviewPath)).toBe(1);
      }
    }
    expect(await snapshots()).toEqual([]);
  });

  it("dispatches an explicit package ingest only for a registered staging writer", async () => {
    const input = await makePackage();
    const registrations = [
      { plugin: "@synthetic/feed", spec: source, network: [HOST] },
    ];
    const commands = feedWorkerCommands(
      registrations,
      new Set(["@synthetic/feed"]),
      {} as never,
      options(),
    );
    const code = await withDataPolicy(
      { historyYears: 3 },
      () =>
        runWorker(
          [
            "ingest",
            "package",
            source.id,
            input.root,
            "--review",
            input.reviewPath,
            "--",
            "--case",
            "happy",
          ],
          () => ({ ...db, close: async () => {} }),
          options().output!,
          undefined,
          commands,
        ),
      at(),
    );
    expect(code).toBe(0);
    expect((await snapshots())[0]?.validation_state).toBe("ACTIVE");
  });

  it("imports all six synthetic PUF files through the shipped importer and records their feed parents", async () => {
    const input = await makePufPackage();
    const installed = await installDataPackage(input.root, scratch);
    expect((await db.query("SELECT * FROM puf_active_catalog")).rows).toEqual(
      [],
    );
    const code = await withDataPolicy(
      { historyYears: 3 },
      () =>
        runCorePackageIngest(
          [
            installed.directory,
            "--review",
            input.reviewPath,
            "--",
            "--year",
            "2026",
            "--state",
            "TX",
          ],
          db,
          options(),
        ),
      at(),
    );
    expect(output, "PUF feed diagnostics").not.toEqual(
      expect.arrayContaining([expect.stringContaining("feed_run_failed")]),
    );
    expect(code).toBe(0);
    const catalog = (
      await db.query<{ import_id: string }>(
        "SELECT import_id FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
      )
    ).rows[0]!;
    expect(catalog).toBeDefined();
    expect(
      (
        await db.query(
          "SELECT individual_rate_cents FROM rate WHERE snapshot_id=$1 ORDER BY source_row LIMIT 1",
          [`${catalog.import_id}:rate`],
        )
      ).rows,
    ).toEqual([{ individual_rate_cents: 12345 }]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM quality_issue WHERE issue_code='data_package_feed_parent'",
        )
      ).rows,
    ).toEqual([{ n: 7 }]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM quality_issue WHERE issue_code='data_package_input' AND source_id='cms-exchange-puf-package'",
        )
      ).rows,
    ).toEqual([{ n: 6 }]);
    // The ordinary cached-file import produces the same public rows using the same parser.
    const direct = await importPufs(db, {
      year: 2026,
      state: "TX",
      dataDir: scratch,
      writeReports: false,
      files: await Promise.all(
        IMPORT_KINDS.map(async (kind) => {
          const file = input.manifest.data.files.find(
            (entry) => entry.path === `original/${kind}.csv`,
          )!;
          return {
            kind,
            path: join(input.root, "chunks", file.sha256),
            format: "csv" as const,
            sha256: file.sha256,
            bytes: file.bytes,
            retrievedAt,
            url: file.origin.url,
          };
        }),
      ),
    });
    expect(direct.passed).toBe(true);
    const publicRows = async (id: string) =>
      (
        await db.query(
          "SELECT base_plan_id,individual_rate_cents,age_band FROM rate WHERE snapshot_id=$1 ORDER BY source_row",
          [`${id}:rate`],
        )
      ).rows;
    expect(sha256(JSON.stringify(await publicRows(catalog.import_id)))).toBe(
      sha256(JSON.stringify(await publicRows(direct.import_id))),
    );
    const bad = await makePufPackage(true);
    const failed = await withDataPolicy(
      { historyYears: 3 },
      () =>
        runCorePackageIngest(
          [
            bad.root,
            "--review",
            bad.reviewPath,
            "--",
            "--year",
            "2026",
            "--state",
            "TX",
          ],
          db,
          options(),
        ),
      at(),
    );
    expect(failed).toBe(1);
    expect(output.join("\n")).toContain("package_puf_reconciliation_failed");
    expect(
      (
        await db.query(
          "SELECT import_id FROM puf_active_catalog WHERE state='TX' AND plan_year=2026",
        )
      ).rows,
    ).toEqual([{ import_id: direct.import_id }]);
    expect(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM rate WHERE individual_rate_cents < 0",
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
    const incomplete = {
      ...input.manifest,
      data: {
        ...input.manifest.data,
        files: input.manifest.data.files.slice(1),
      },
    };
    expect(() => packagePufSource(incomplete)).toThrow(
      "package_puf_source_set_incomplete",
    );
  }, 120000);

  it("negative control: the install-without-activation assertion catches an activation mutant", async () => {
    const input = await makePackage();
    const mutant = await plantMutant(
      new URL("../../src/registry/data/install.ts", import.meta.url),
      "      await rename(temporary, destination);",
      "      await rename(temporary, destination);\n      await (globalThis as unknown as { syntheticActivateOnInstall(): Promise<void> }).syntheticActivateOnInstall();",
    );
    const globals = globalThis as unknown as {
      syntheticActivateOnInstall?: () => Promise<void>;
    };
    globals.syntheticActivateOnInstall = async () => {
      await db.query(
        "INSERT INTO source(source_id,publisher,source_kind) VALUES ('synthetic-feed','Synthetic fixture','feed') ON CONFLICT DO NOTHING",
      );
      await db.query(
        "INSERT INTO snapshot(snapshot_id,source_id,validation_state,expected_children,fetched_children,sha256,retrieved_at,activated_at) VALUES ('synthetic-install-mutant','synthetic-feed','ACTIVE',0,0,$1,now(),now())",
        ["0".repeat(64)],
      );
    };
    try {
      const altered = (await import(mutant.path)) as {
        installDataPackage: typeof installDataPackage;
      };
      await altered.installDataPackage(input.root, scratch);
      const installedSnapshots = await snapshots();
      expect(() => expect(installedSnapshots).toEqual([])).toThrow();
    } finally {
      delete globals.syntheticActivateOnInstall;
      await mutant.cleanup();
    }
  });
});
