import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { ingestQhpBatch } from "../../../src/ingest/qhp/formulary-batch.js";
import {
  acquireProviders,
  ingestProviders,
} from "../../../src/ingest/qhp/provider-acquire.js";
import { fetchToCache } from "../../../src/fetch/index.js";
import { importProviders } from "../../../src/ingest/qhp/provider.js";
import { runWorker } from "../../../src/worker/commands.js";
import { fixture, scope, setup, insert } from "./provider-helpers.js";

describe("all readable issuers: synthetic isolation and acquisition mutants", () => {
  let h: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    h = await setup();
  });
  afterAll(async () => {
    await h?.close();
  });
  it("downloads shared children once, scopes both issuer edges, and quarantines only the HTML issuer", async () => {
    const provider = (await fixture("records"))[0],
      original = h.catalog.plans[0];
    const sharedPlan = "12345" + original.base_plan_id.slice(5),
      badPlan = "00001" + original.base_plan_id.slice(5);
    // Labelled synthetic catalog/index/associations: no invented coverage enters real data.
    provider.plans = [original.base_plan_id, sharedPlan, badPlan].map(
      (plan_id) => ({
        plan_id,
        plan_id_type: "HIOS-PLAN-ID",
        years: [2026],
        network_tier: "SYNTHETIC-UNRESOLVED",
      }),
    );
    const rawId = await h.replace([provider]);
    const definition = (await fixture("plans"))[0];
    await h.child(
      [sharedPlan, badPlan].map((plan_id) => ({ ...definition, plan_id })),
      "plan_urls",
    );
    for (const [issuer, plan] of [
      ["12345", sharedPlan],
      ["00001", badPlan],
    ]) {
      await insert(h.db, "plan", {
        ...original,
        base_plan_id: plan,
        issuer_id: issuer,
        snapshot_id: "catalog",
      });
      await h.db.query(
        `INSERT INTO qhp_index(qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,registry_row,snapshot_id,status)
        VALUES ($1,$1,$2,2026,'TX','registry',1,'index','ok')`,
        [issuer, issuer],
      );
      await h.db.query(
        `INSERT INTO qhp_child_url(qhp_index_id,issuer_id,plan_year,kind,url,published_url,url_sha256,
        host_evidence,index_snapshot_id,snapshot_id,status)
        SELECT $1,$1,plan_year,kind,url,published_url,url_sha256,host_evidence,index_snapshot_id,snapshot_id,status
        FROM qhp_child_url WHERE qhp_index_id=(SELECT qhp_index_id FROM qhp_child_url WHERE snapshot_id=$2 LIMIT 1)`,
        [issuer, rawId],
      );
    }
    await h.db.query(
      `UPDATE qhp_child_url SET status='discovered',snapshot_id=NULL WHERE kind='provider_urls'`,
    );
    await h.db.query(
      `UPDATE qhp_child_url SET url='https://issuer.example/synthetic-html.json',url_sha256=$1
      WHERE issuer_id='00001' AND kind='provider_urls'`,
      ["b".repeat(64)],
    );
    const raw = (
      await h.db.query("SELECT * FROM snapshot WHERE snapshot_id=$1", [rawId])
    ).rows[0]!;
    const calls: string[] = [];
    const batch = await ingestQhpBatch(h.db, "providers", {
      year: 2026,
      state: "TX",
      fetcher: async (url, options) => {
        calls.push(String(url));
        if (String(url).includes("synthetic-html"))
          return fetchToCache(url, {
            ...options,
            dataDir: h.directory,
            allowHosts: ["issuer.example"],
            lookup: async () => [{ address: "8.8.8.8", family: 4 }],
            transport: async () => ({
              status: 200,
              headers: { "content-type": "text/html" },
              body: Readable.from(["<html>synthetic error</html>"]),
            }),
          });
        return {
          outcome: "reused",
          snapshotId: String(raw.sha256),
          path: String(raw.raw_path),
          metadataPath: "synthetic",
          metadata: {
            snapshot_id: String(raw.sha256),
            source: options.source,
            url: String(url),
            final_url: String(url),
            redirect_chain: [],
            fetched_at: "2026-11-07T00:00:00Z",
            status: 200,
            content_type: "application/json",
            etag: null,
            last_modified: null,
            bytes: Buffer.byteLength(await readFile(String(raw.raw_path))),
            sha256: String(raw.sha256),
          },
        };
      },
    });
    expect(calls).toHaveLength(2); // one shared download + one HTML failure, not three
    const provenance = (
      await h.db
        .query(`SELECT DISTINCT s.issuer_scope FROM source s JOIN snapshot r USING(source_id)
      JOIN qhp_child_url c ON c.snapshot_id=r.snapshot_id WHERE c.kind='provider_urls' AND c.status='downloaded'`)
    ).rows;
    expect(provenance).toEqual([
      { issuer_scope: expect.arrayContaining(["12345", "00010"]) },
    ]);
    expect(batch.issuers.find((r) => r.issuer === "00001")).toMatchObject({
      status: "QUARANTINED",
      completeness: "failed",
      issues: { html_error_page: 1 },
    });
    for (const issuer of ["12345", "00010"]) {
      const report = batch.issuers.find((r) => r.issuer === issuer)!;
      expect(report).toMatchObject({ status: "ACTIVE", edges: 1 });
      const plans = (
        await h.db.query(
          `SELECT DISTINCT base_hios_id FROM qhp_provider_plan p
        JOIN provider_shard s USING(snapshot_id) WHERE s.source_set_id=$1`,
          [report.snapshot_id],
        )
      ).rows;
      expect(plans).toEqual([
        { base_hios_id: issuer + original.base_plan_id.slice(5) },
      ]);
    }
    expect(
      (
        await h.db.query(
          "SELECT issuer_id,status FROM qhp_coverage_manifest ORDER BY issuer_id",
        )
      ).rows,
    ).toEqual([
      { issuer_id: "00001", status: "failed" },
      { issuer_id: "00010", status: "complete" },
      { issuer_id: "12345", status: "complete" },
    ]);
  });
  it("D1: real fetcher rejects an over-cap provider file before ingestion, records too_large and partial", async () => {
    await h.replace(await fixture("records"));
    await h.db.query(
      `UPDATE qhp_child_url SET status='discovered',snapshot_id=NULL WHERE issuer_id='00010' AND kind='provider_urls'`,
    );
    await h.db.query(
      `UPDATE qhp_index SET child_hosts='["issuer.example"]' WHERE issuer_id='00010'`,
    );
    let calls = 0;
    await acquireProviders(h.db, scope, {
      fetchOptions: {
        dataDir: h.directory,
        maxBytes: 32,
        maxAttempts: 1,
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        transport: async () => {
          calls++;
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body: Readable.from(["[" + " ".repeat(98) + "]"]),
          };
        },
      },
    });
    expect(calls).toBe(1);
    const report = await importProviders(h.db, scope);
    expect(report).toMatchObject({
      status: "QUARANTINED",
      completeness: "partial",
      records: 0,
      edges: 0,
      issues: { too_large: 1 },
    });
    const shards = (
      await h.db.query(
        "SELECT raw_snapshot_id,record_count,reason FROM provider_shard WHERE source_set_id=$1",
        [report.snapshot_id],
      )
    ).rows;
    expect(shards).toEqual([
      { raw_snapshot_id: null, record_count: 0, reason: "too_large" },
    ]);
    // A truncated-and-loaded mutant violates the exact zero-record contract.
    const contract = (records: number) => expect(records).toBe(0);
    contract(report.records);
    expect(() => contract(1)).toThrow();
  });
  it("CLI all-readable records denied indexes and unknown absent kinds without fetching or losing healthy issuers", async () => {
    for (const issuer of ["00010", "00001"])
      await h.db.query(
        `INSERT INTO qhp_index
      (qhp_index_id,discovery_id,issuer_id,plan_year,state,registry_snapshot_id,registry_row,status,discovered_at)
      VALUES ($1,$1,$2,2026,'TX','registry',1,'access_denied',clock_timestamp())`,
        ["denied-" + issuer, issuer],
      );
    const output: string[] = [];
    let closed = false;
    expect(
      await runWorker(
        [
          "ingest",
          "qhp",
          "providers",
          "--year",
          "2026",
          "--state",
          "TX",
          "--all-readable",
        ],
        () => ({
          ...h.db,
          close: async () => {
            closed = true;
          },
        }),
        {
          out: (s) => output.push(s),
          error: () => {
            throw new Error("unexpected CLI failure");
          },
        },
        h.core.directory,
      ),
    ).toBe(1);
    expect(closed).toBe(true);
    const batch = JSON.parse(output[0]!);
    expect(batch.issuers).toHaveLength(3);
    expect(batch.issuers.find((r: any) => r.issuer === "12345").status).toBe(
      "ACTIVE",
    );
    expect(
      batch.issuers.find((r: { issuer: string }) => r.issuer === "00010"),
    ).toMatchObject({
      completeness: "access_denied",
      reason: expect.stringContaining("index_access_denied"),
    });
    output.length = 0;
    expect(
      await runWorker(
        [
          "ingest",
          "qhp",
          "formulary",
          "--year",
          "2026",
          "--state",
          "TX",
          "--all-readable",
        ],
        () => ({ ...h.db, close: async () => {} }),
        {
          out: (s) => output.push(s),
          error: () => {
            throw new Error("unexpected CLI failure");
          },
        },
        h.core.directory,
      ),
    ).toBe(1);
    expect(
      JSON.parse(output[0]!).issuers.find((r: any) => r.issuer === "12345"),
    ).toMatchObject({ completeness: "unknown", expected_children: 0 });
  });

  it("an unexpected issuer transaction failure writes a failed manifest and does not stop siblings", async () => {
    let broken = false;
    const wrapper = {
      ...h.db,
      query: (async (sql: string, args?: unknown[]) => {
        if (
          !broken &&
          sql.includes("SELECT discovery_id,status FROM qhp_index") &&
          args?.[0] === "00001"
        ) {
          broken = true;
          throw new Error("synthetic issuer query failure");
        }
        return h.db.query(sql, args);
      }) as typeof h.db.query,
    };
    const result = await ingestQhpBatch(wrapper, "providers", {
      year: 2026,
      state: "TX",
    });
    expect(broken).toBe(true);
    expect(result.issuers.find((r) => r.issuer === "00001")).toMatchObject({
      completeness: "failed",
      reason: "issuer_import_failed",
    });
    expect(result.issuers.find((r) => r.issuer === "12345")).toMatchObject({
      status: "ACTIVE",
      edges: 1,
    });
    expect(
      (
        await h.db.query(
          "SELECT status,reason FROM qhp_coverage_manifest WHERE issuer_id='00001' AND kind='provider'",
        )
      ).rows,
    ).toEqual([{ status: "failed", reason: "issuer_import_failed" }]);
  });

  it("a run budget interrupts a stalled body and parsing, quarantining rather than publishing a short feed", async () => {
    await h.replace(await fixture("records"));
    await h.db.query(
      `UPDATE qhp_child_url SET status='discovered',snapshot_id=NULL WHERE issuer_id='00010' AND kind='provider_urls'`,
    );
    await h.db.query(
      `UPDATE qhp_index SET child_hosts='["issuer.example"]' WHERE issuer_id='00010'`,
    );
    const deadline = Date.now() + 500;
    let stalled: Readable | undefined;
    await acquireProviders(h.db, scope, {
      deadline,
      fetchOptions: {
        dataDir: h.directory,
        maxAttempts: 1,
        lookup: async () => [{ address: "8.8.8.8", family: 4 }],
        transport: async () => {
          const body = new Readable({ read() {} });
          body.push("[");
          stalled = body;
          return {
            status: 200,
            headers: { "content-type": "application/json" },
            body,
          };
        },
      },
    });
    expect(stalled?.destroyed).toBe(true);
    const budget = await importProviders(h.db, scope);
    expect(budget).toMatchObject({
      status: "QUARANTINED",
      completeness: "partial",
      records: 0,
      edges: 0,
      issues: { run_budget_exceeded: 1 },
    });
    // Aborting parsing of already cached bytes also cannot produce a complete empty source set.
    await h.replace(await fixture("records"));
    const controller = new AbortController();
    controller.abort();
    const interrupted = await importProviders(h.db, scope, {
      signal: controller.signal,
    });
    expect(interrupted).toMatchObject({
      status: "QUARANTINED",
      edges: 0,
      reason: expect.stringContaining("run_budget_exceeded"),
    });
    expect(interrupted.reason).not.toContain(
      "catalog_plan_year_not_in_definitions",
    );
  });

  it("parses a cached child before acquiring a later stalled child, and retains that validated shard privately", async () => {
    await h.replace([(await fixture("records"))[0]]);
    const later = await h.child([]);
    await h.db.query(
      `UPDATE qhp_child_url SET status='discovered',snapshot_id=NULL WHERE snapshot_id=$1`,
      [later],
    );
    const order: string[] = [];
    const report = await ingestProviders(h.db, scope, {
      onShard: (shard) => {
        order.push(shard.status);
      },
      fetcher: async () => {
        // Synthetic failure of the next download must occur after the first child reached EOF.
        order.push("download-next");
        expect(order[0]).toBe("complete");
        throw new Error("synthetic stalled child");
      },
    });
    expect(order).toEqual(["complete", "download-next", "failed"]);
    expect(report).toMatchObject({
      status: "QUARANTINED",
      completeness: "partial",
      records: 1,
      complete_children: 1,
    });
  });

  it("unstarted issuers still get explicit unknown manifest rows when the budget expires", async () => {
    const run = await ingestQhpBatch(h.db, "providers", {
      year: 2026,
      state: "TX",
      deadline: Date.now() - 1,
    });
    expect(run.issuers).toEqual([]);
    expect(run.not_run.sort()).toEqual(["00001", "00010", "12345"]);
    expect(
      (
        await h.db.query(
          "SELECT DISTINCT status,reason FROM qhp_coverage_manifest WHERE kind='provider'",
        )
      ).rows,
    ).toEqual([{ status: "unknown", reason: "not_run_budget" }]);
  });

  it("native runner rejects malformed or remote developer URLs without exposing synthetic credentials", () => {
    const sentinel = "SYNTHETIC-CREDENTIAL-SENTINEL";
    for (const url of [
      `postgresql://synthetic:${sentinel}@`,
      `postgresql://synthetic:${sentinel}\u0040db.example.invalid/openplans`,
    ]) {
      const run = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../../dist/ingest/qhp/formulary-all-postgres.js",
              import.meta.url,
            ),
          ),
          "providers",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, OPENPLANS_QHP_DATABASE_URL: url },
        },
      );
      expect(run.status).toBe(1);
      expect(run.stdout + run.stderr).toContain(
        "Explicit loopback developer database required",
      );
      expect(run.stdout + run.stderr).not.toContain(sentinel);
    }
  });
});
