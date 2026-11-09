import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer, request } from "node:http";
import { createServer as createTcpServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { migrate } from "../../../src/db/migrate.js";
import type { Database } from "../../../src/db/database.js";
import { discoverQhp } from "../../../src/ingest/qhp/discover.js";
import {
  cachedRegistry,
  readRegistry,
} from "../../../src/ingest/qhp/discover-registry.js";
import type { RegistryInput } from "../../../src/ingest/qhp/discover-registry.js";
import type { Transport } from "../../../src/fetch/index.js";
import { FetchError, fetchToCache } from "../../../src/fetch/index.js";
import { httpsTransport } from "../../../src/fetch/transport.js";
import { runWorker } from "../../../src/worker/commands.js";
import { workbook } from "../../fixtures/qhp/generate.mjs";

let directory: string,
  db: Database,
  migration: Awaited<ReturnType<typeof coreMigrations>>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openplans-qhp-"));
  db = testDatabase(new PGlite());
  migration = await coreMigrations();
  await migrate(db, migration.directory);
});
afterEach(async () => {
  await db.close();
  await migration.cleanup();
  await rm(directory, { recursive: true, force: true });
});
async function registry(rows: string[][]): Promise<RegistryInput> {
  const sheet =
    "<worksheet><sheetData>" +
    [["State", "Issuer ID", "URL Submitted"], ...rows]
      .map(
        (row, number) =>
          `<row r="${number + 1}">${row.map((value) => `<c t="inlineStr"><is><t>${value}</t></is></c>`).join("")}</row>`,
      )
      .join("") +
    "</sheetData></worksheet>";
  const bytes = workbook({ sheet });
  const path = join(directory, "registry.xlsx");
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    path,
    metadata: {
      snapshot_id: sha256,
      source: "synthetic-registry",
      url: "https://cms.example/registry.zip",
      final_url: "https://cms.example/registry.zip",
      redirect_chain: [],
      status: 200,
      content_type: "application/zip",
      etag: null,
      last_modified: null,
      sha256,
      bytes: bytes.length,
      fetched_at: "2026-01-01T00:00:00Z",
    },
  };
}
const lookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

describe("registry-first QHP discovery", () => {
  it("negative HTML control: records per-issuer errors and continues; downloads Cigna plans/drugs only with child-host evidence", async () => {
    const input = await registry([
      ["TX", "11111", "https://html.example/index.json"],
      ["TX", "22222", "https://good.example/index.json"],
      ["TX", "33333", "https://redirect.example/index.json"],
      ["TX", "44444", "https://127.0.0.1/index.json"],
      ["TX", "55555", ""],
      ["TX", "66666", "https://absent.example/index.json"],
      ["TX", "76589", "https://cigna.example/index.json"],
      ["CA", "99999", "https://unused.example/index.json"],
    ]);
    const requests: { url: string; hosts: string; timeout: number }[] = [];
    const transport: Transport = async (url, context) => {
      requests.push({
        url: url.href,
        hosts: context.headers["accept-encoding"]!,
        timeout: context.connectTimeoutMs,
      });
      if (url.hostname === "html.example")
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: Readable.from(["<html>synthetic error</html>"]),
        };
      if (url.hostname === "redirect.example")
        return {
          status: 302,
          headers: { location: "https://unlisted.example/index.json" },
          body: Readable.from([]),
        };
      if (url.hostname === "absent.example")
        return { status: 404, headers: {}, body: Readable.from([]) };
      const body =
        url.pathname === "/index.json"
          ? JSON.stringify({
              plan_urls: ["http://plans.example/plans.json"],
              provider_urls: ["http://providers.example/huge.json"],
              formulary_urls: [
                {
                  url: "https://drugs.example/drugs.json",
                  plan_years: [2026, 2027],
                  last_updated_on: "2026-01-01",
                },
              ],
              last_updated_on: "2026-01-01",
            })
          : '[{"synthetic":true}]';
      return {
        status: 200,
        headers: { "content-type": "application/json", etag: '"synthetic"' },
        body: Readable.from([body]),
      };
    };
    const result = await discoverQhp(db, {
      year: 2026,
      state: "TX",
      registry: input,
      dataDir: directory,
      fetchOptions: { lookup, transport, maxAttempts: 1 },
    });
    expect(
      Object.fromEntries(result.issuers.map((row) => [row.issuer, row.status])),
    ).toEqual({
      "11111": "html_error_page",
      "22222": "ok",
      "33333": "host_not_allowed",
      "44444": "blocked_address",
      "55555": "not_published",
      "66666": "not_published",
      "76589": "ok",
    });
    expect(result.issuers.find((row) => row.issuer === "76589")).toMatchObject({
      plan_urls: 1,
      provider_urls: 1,
      formulary_urls: 1,
      downloaded: 2,
    });
    expect(requests.map((request) => request.url)).not.toContain(
      "https://providers.example/huge.json",
    );
    expect(requests.every((request) => request.url.startsWith("https:"))).toBe(
      true,
    );
    expect(
      requests
        .filter((request) => request.url.endsWith("/index.json"))
        .every((request) => request.timeout === 30_000),
    ).toBe(true);
    expect(
      requests
        .filter((request) => !request.url.endsWith("/index.json"))
        .every((request) => request.timeout === 10_000),
    ).toBe(true);
    expect(
      requests.some((request) =>
        /unlisted|unused|127\.0\.0\.1/.test(request.url),
      ),
    ).toBe(false);
    const index = (
      await db.query("SELECT * FROM qhp_index WHERE issuer_id=$1", ["76589"])
    ).rows[0]!;
    expect(index.puf_hosts).toEqual(["cigna.example"]);
    expect(index.child_hosts).toEqual([
      "drugs.example",
      "plans.example",
      "providers.example",
    ]);
    const children = (
      await db.query(
        "SELECT * FROM qhp_child_url WHERE issuer_id=$1 ORDER BY kind",
        ["76589"],
      )
    ).rows;
    expect(children.map((row) => row.status)).toEqual([
      "downloaded",
      "downloaded",
      "discovered",
    ]);
    expect(
      children.every(
        (row) =>
          row.host_evidence === "index_child" &&
          row.index_snapshot_id === index.snapshot_id,
      ),
    ).toBe(true);
    expect(children.find((row) => row.kind === "plan_urls")).toMatchObject({
      published_url: "http://plans.example/plans.json",
      url: "https://plans.example/plans.json",
    });
    expect(children[0]!.publisher_metadata).toEqual({
      plan_years: [2026, 2027],
      last_updated_on: "2026-01-01",
    });
    expect(
      (
        await db.query(
          "SELECT count(*) AS n FROM snapshot WHERE validation_state='ACTIVE'",
        )
      ).rows[0]!.n,
    ).toBe(0);
  });
  it("local server controls: a 403 is attempted once, two timeouts recover, the cap and redirect allowlist hold", async () => {
    const counts: Record<string, number> = {},
      identities: string[] = [],
      accepts: string[] = [];
    const server = createServer((req, res) => {
      const path = req.url!;
      counts[path] = (counts[path] ?? 0) + 1;
      identities.push(req.headers["user-agent"] ?? "");
      accepts.push(req.headers.accept ?? "");
      if (path === "/denied") {
        res.writeHead(403, {
          "content-type": "text/html",
          server: "synthetic-denial",
          "set-cookie": "sensitive-sentinel",
        });
        res.end("denied");
      } else if (path === "/not-acceptable") {
        res.writeHead(406);
        res.end();
      } else if (
        path === "/never" ||
        (path === "/flaky" && counts[path]! < 3)
      ) {
        // No response headers: the client connection deadline must terminate the request.
      } else if (path === "/redirect") {
        res.writeHead(302, {
          location: "https://unlisted.example/index?key=secret-sentinel",
        });
        res.end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end('{"plan_urls":[]}');
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const transport: Transport = (url, context) =>
      new Promise((resolve, reject) => {
        // Only the trusted test transport reaches loopback; production URL/DNS policy is unchanged.
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: url.pathname,
            headers: context.headers,
          },
          (res) => {
            clearTimeout(timer);
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: res,
            });
          },
        );
        const timer = setTimeout(
          () =>
            req.destroy(
              new FetchError(
                "connect_timeout",
                "Synthetic connection deadline",
              ),
            ),
          context.connectTimeoutMs,
        );
        req.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        req.end();
      });
    try {
      const input = await registry([
        ["TX", "11111", "https://publisher.example/denied"],
        ["TX", "22222", "https://publisher.example/flaky"],
        ["TX", "33333", "https://publisher.example/redirect"],
        ["TX", "44444", "https://publisher.example/never"],
        ["TX", "55555", "https://publisher.example/not-acceptable"],
      ]);
      const delays: number[] = [];
      const report = await discoverQhp(db, {
        year: 2026,
        state: "TX",
        registry: input,
        dataDir: directory,
        fetchOptions: {
          lookup,
          transport,
          connectTimeoutMs: 50,
          maxAttempts: 3,
          projectUrl: "https://project.example/openplans",
          random: () => 0.5,
          sleep: async (ms) => {
            delays.push(ms);
          },
        },
      });
      expect(report.issuers.map((row) => row.status)).toEqual([
        "access_denied",
        "ok",
        "host_not_allowed",
        "connect_timeout",
        "http_status",
      ]);
      expect(counts).toEqual({
        "/denied": 1,
        "/flaky": 3,
        "/redirect": 1,
        "/never": 3,
        "/not-acceptable": 1,
      });
      expect(delays).toEqual([250, 500, 250, 500]);
      expect(
        identities.every(
          (value) =>
            value ===
            "openplans/0.1 (public health-plan source discovery; +https://project.example/openplans)",
        ),
      ).toBe(true);
      expect(
        accepts.every((value) => value === "application/json, */*;q=0.1"),
      ).toBe(true);
      const denied = (
        await db.query("SELECT * FROM qhp_index WHERE issuer_id='11111'")
      ).rows[0]!;
      expect(denied).toMatchObject({
        status: "access_denied",
        http_status: 403,
        snapshot_id: null,
        publisher_metadata: {
          provider_status: "unknown",
          drug_status: "unknown",
          fetch_evidence: {
            attempts: 1,
            response_headers: {
              server: "synthetic-denial",
              "content-type": "text/html",
            },
          },
        },
      });
      expect(JSON.stringify(denied)).not.toContain("sensitive-sentinel");
      expect(
        (await db.query("SELECT * FROM qhp_index WHERE issuer_id='55555'"))
          .rows[0],
      ).toMatchObject({
        status: "http_status",
        http_status: 406,
        publisher_metadata: {
          drug_status: "unknown",
          provider_status: "unknown",
          fetch_evidence: { attempts: 1 },
        },
      });
      const redirected = (
        await db.query(
          "SELECT publisher_metadata FROM qhp_index WHERE issuer_id='33333'",
        )
      ).rows[0]!;
      expect(JSON.stringify(redirected)).not.toContain("secret-sentinel");
      expect(
        (
          await db.query(
            "SELECT publisher_metadata FROM qhp_index WHERE issuer_id='44444'",
          )
        ).rows[0]!.publisher_metadata,
      ).toMatchObject({ fetch_evidence: { attempts: 3 } });
      expect((await db.query("SELECT * FROM qhp_child_url")).rows).toEqual([]);
      // A deliberately smaller retry budget cannot reach the recovering third response.
      counts["/flaky"] = 0;
      await expect(
        fetchToCache("https://publisher.example/flaky", {
          source: "synthetic-cap",
          allowHosts: ["publisher.example"],
          expectedContent: "json",
          dataDir: directory,
          lookup,
          transport,
          connectTimeoutMs: 50,
          maxAttempts: 2,
          sleep: async () => {},
        }),
      ).rejects.toMatchObject({
        code: "connect_timeout",
        evidence: { attempts: 2 },
      });
      expect(counts["/flaky"]).toBe(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("rejects unsafe project identity configuration before issuing a request", async () => {
    for (const projectUrl of [
      "https://user:password\u0040project.example/",
      "https://project.example/?key=secret",
      "http://project.example/",
    ]) {
      await expect(
        fetchToCache("https://publisher.example/index", {
          source: "synthetic-identity",
          allowHosts: ["publisher.example"],
          expectedContent: "json",
          dataDir: directory,
          projectUrl,
          transport: async () => {
            throw new Error("must not request");
          },
        }),
      ).rejects.toMatchObject({ code: "invalid_options" });
    }
    const error = await fetchToCache("https://publisher.example/index", {
      source: "synthetic-redirect-credentials",
      allowHosts: ["publisher.example"],
      expectedContent: "json",
      dataDir: directory,
      lookup,
      transport: async () => ({
        status: 302,
        headers: {
          location:
            "https://user:password-sentinel\u0040publisher.example/index?key=query-sentinel",
        },
        body: Readable.from([]),
      }),
    }).catch((error) => error);
    expect(error).toMatchObject({
      code: "embedded_credentials",
      evidence: { attempts: 1 },
    });
    expect(JSON.stringify(error)).not.toMatch(
      /password-sentinel|query-sentinel|user@/,
    );
  });
  it("records a TLS-handshake timeout separately from DNS and TCP connection failure", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(
        fetchToCache("https://publisher.example/index", {
          source: "synthetic-tls-stall",
          allowHosts: ["publisher.example"],
          expectedContent: "json",
          dataDir: directory,
          lookup,
          maxAttempts: 1,
          connectTimeoutMs: 100,
          transport: (url, context) =>
            httpsTransport(
              new URL(`https://publisher.example:${port}${url.pathname}`),
              { ...context, address: { address: "127.0.0.1", family: 4 } },
            ),
        }),
      ).rejects.toMatchObject({
        code: "connect_timeout",
        evidence: { attempts: 1, connection: { phase: "tls_handshake" } },
      });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("quarantines malformed index JSON without dropping other issuers", async () => {
    const input = await registry([
      ["TX", "11111", "https://broken.example/index"],
      ["TX", "22222", "https://valid.example/index"],
    ]);
    const transport: Transport = async (url) => ({
      status: 200,
      headers: {},
      body: Readable.from([
        url.hostname === "broken.example"
          ? '{"plan_urls":['
          : '{"plan_urls":[]}',
      ]),
    });
    const result = await discoverQhp(db, {
      year: 2026,
      state: "TX",
      registry: input,
      dataDir: directory,
      fetchOptions: { lookup, transport },
    });
    expect(result.issuers.map((row) => row.status)).toEqual([
      "truncated",
      "ok",
    ]);
    expect(
      (
        await db.query(
          "SELECT validation_state FROM snapshot WHERE snapshot_id LIKE 'qhp:11111:%'",
        )
      ).rows,
    ).toEqual([{ validation_state: "QUARANTINED" }]);
  });
  it("reuses a 304 snapshot with hash verification and rejects a corrupted cache hit", async () => {
    const input = await registry([
      ["TX", "22222", "https://good.example/index"],
    ]);
    let requests = 0;
    const transport: Transport = async (_url, context) => {
      requests++;
      if (requests > 1) {
        expect(context.headers["if-none-match"]).toBe('"synthetic"');
        return { status: 304, headers: {}, body: Readable.from([]) };
      }
      return {
        status: 200,
        headers: { etag: '"synthetic"' },
        body: Readable.from(['{"plan_urls":[]}']),
      };
    };
    const options = {
      year: 2026,
      state: "TX",
      registry: input,
      dataDir: directory,
      fetchOptions: { lookup, transport, maxAttempts: 1 },
    };
    expect((await discoverQhp(db, options)).issuers[0]!.status).toBe("ok");
    expect((await discoverQhp(db, options)).issuers[0]!.status).toBe("ok");
    expect(requests).toBe(2);
    const snapshot = (
      await db.query(
        "SELECT raw_path FROM snapshot WHERE snapshot_id LIKE 'qhp:22222:%'",
      )
    ).rows[0]!;
    await writeFile(String(snapshot.raw_path), '{"plan_urls":[]} ');
    expect((await discoverQhp(db, options)).issuers[0]!.status).toBe(
      "cache_error",
    );
    expect(
      (await db.query("SELECT count(*) AS n FROM qhp_index WHERE status='ok'"))
        .rows[0]!.n,
    ).toBe(2);
  });
  it("reads the reproducible real TX cut without retaining contact fields", async () => {
    const bytes = Buffer.from(
      (
        await readFile(
          new URL(
            "../../fixtures/qhp/tx-2026-registry.xlsx.hex",
            import.meta.url,
          ),
          "utf8",
        )
      ).trim(),
      "hex",
    );
    const path = join(directory, "real-cut.xlsx");
    await writeFile(path, bytes);
    const rows = await readRegistry(path, "TX");
    expect(rows).toHaveLength(31);
    expect(rows.find((row) => row.issuer === "76589")?.url).toBe(
      "https://www.cigna.com/sites/json/cms-data-index.json",
    );
    expect(
      rows.every(
        (row) => Object.keys(row).sort().join(",") === "issuer,row,url",
      ),
    ).toBe(true);
    const provenance = JSON.parse(
      await readFile(
        new URL(
          "../../fixtures/qhp/tx-2026-registry.provenance.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      provenance.fixture_sha256,
    );
  });
  it("keeps distinct query shards even when public provenance redacts their values", async () => {
    const input = await registry([
      ["TX", "22222", "https://good.example/index"],
    ]);
    const transport: Transport = async () => ({
      status: 200,
      headers: {},
      body: Readable.from([
        '{"plan_urls":["https://shards.example/plans?part=1","https://shards.example/plans?part=2","https://shards.example/plans?part=1"]}',
      ]),
    });
    const result = await discoverQhp(db, {
      year: 2026,
      state: "TX",
      registry: input,
      dataDir: directory,
      fetchOptions: { lookup, transport },
    });
    expect(result.issuers[0]!.plan_urls).toBe(2);
    const children = (
      await db.query("SELECT url,url_sha256 FROM qhp_child_url")
    ).rows;
    expect(children).toHaveLength(2);
    expect(children[0]!.url).toBe(children[1]!.url);
    expect(children[0]!.url_sha256).not.toBe(children[1]!.url_sha256);
    expect(new URL(String(children[0]!.url)).searchParams.get("part")).toBe(
      "[REDACTED]",
    );
  });
  it("fails before any download if the registry hash is false or manifest unavailable", async () => {
    const input = await registry([
      ["TX", "11111", "https://synthetic.example/index"],
    ]);
    input.metadata.sha256 = "0".repeat(64);
    await expect(
      discoverQhp(db, {
        year: 2026,
        state: "TX",
        registry: input,
        dataDir: directory,
      }),
    ).rejects.toMatchObject({ code: "cache_error" });
    await expect(cachedRegistry(directory, 2026)).rejects.toThrow();
  });
  it("dispatches qhp discover and rejects invalid flags without opening a database", async () => {
    const errors: string[] = [];
    const code = await runWorker(
      ["ingest", "qhp", "discover", "--year", "2026", "--state", "tx"],
      () => {
        throw new Error("must not open");
      },
      { out() {}, error: (message) => errors.push(message) },
    );
    expect(code).toBe(1);
    expect(errors).toEqual([
      "Usage: worker ingest qhp discover --year YYYY --state ST",
    ]);
  });
});
