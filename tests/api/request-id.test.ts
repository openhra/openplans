// Synthetic requests only; the database is in-process PGlite or a stub that always fails.
import type * as NodeFs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/app.js";
import { releaseFactsReader } from "../../src/api/release-facts.js";
import { schemaGate } from "../../src/api/schema-gate.js";
import { loadMigrations, migrate } from "../../src/db/migrate.js";
import type { SqlSession } from "../../src/db/database.js";
import { applicationVersion } from "../../src/mcp/version.js";
import { assertRequestId, mountedRoutes } from "../error-shape.js";
import { importMutant, withMutantFile } from "../mutant-file.js";
import { contract } from "../public-contract.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { replaceSyntax } from "../source-mutation.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

interface ErrorBody {
  error: { code?: string; request_id?: string; data?: unknown };
}

const failing: SqlSession = {
  query: async () => {
    throw new Error("Synthetic outage");
  },
  exec: async () => {},
};
const header = contract.request_id.header;
const accepted = new RegExp(contract.request_id.accepted_pattern);
const generated = new RegExp(contract.request_id.generated_pattern);
afterEach(() => vi.restoreAllMocks());

describe("request ids", () => {
  it("echoes a client id and generates a 16 hex id otherwise, on success and on error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(failing);
    const sent = await app.request("/v1/no-such-route", {
      headers: { [header]: "client-id.42:abc" },
    });
    expect(sent.status).toBe(404);
    expect(sent.headers.get(header)).toBe("client-id.42:abc");
    expect(((await sent.json()) as ErrorBody).error.request_id).toBe(
      "client-id.42:abc",
    );
    const none = await app.request("/healthz");
    expect(none.headers.get(header)).toMatch(generated);
    const again = await app.request("/healthz");
    expect(again.headers.get(header)).not.toBe(none.headers.get(header));
  });

  it.each([
    ["longer than 128 characters", "a".repeat(129)],
    ["with a control character", "abc\u0007def"],
    ["with a space", "has space"],
    ["with non-ASCII text", "café"],
  ])("replaces a client id %s instead of echoing it", async (_why, bad) => {
    const app = createApp(failing);
    const response = await app.request("/v1/no-such-route", {
      headers: { [header]: bad },
    });
    const id = response.headers.get(header)!;
    expect(id).not.toBe(bad);
    expect(id).toMatch(generated);
    expect(((await response.json()) as ErrorBody).error.request_id).toBe(id);
  });

  it("accepts exactly 128 characters", async () => {
    const id = "a".repeat(128);
    const response = await createApp(failing).request("/nope", {
      headers: { [header]: id },
    });
    expect(response.headers.get(header)).toBe(id);
  });

  it("finds the same id in the header, the body and the log for a 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(failing);
    app.get("/synthetic-error", () => {
      throw new TypeError("synthetic");
    });
    const response = await app.request("/synthetic-error", {
      headers: { [header]: "trace-500" },
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as ErrorBody;
    const logged = log.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>,
    );
    expect(response.headers.get(header)).toBe("trace-500");
    expect(body.error).toEqual({
      code: "internal_error",
      request_id: "trace-500",
    });
    expect(logged).toEqual([
      expect.objectContaining({
        event: "api_internal_error",
        request_id: "trace-500",
      }),
    ]);
  });

  it("puts the id on every route family's forced error, MCP and rate limits included", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(failing, { publicCompat: true });
    const families = new Set<string>();
    for (const { method, path } of mountedRoutes(app)) {
      const response = await app.request(path, {
        method,
        ...(method === "POST"
          ? { body: "{", headers: { "content-type": "application/json" } }
          : {}),
      });
      expect(response.headers.get(header), `${method} ${path}`).toMatch(
        accepted,
      );
      if (response.status >= 400 && !path.startsWith("/mcp"))
        assertRequestId(response, await response.json());
      families.add(path.split("/")[1] ?? "");
    }
    expect([...families]).toEqual(expect.arrayContaining(["v1", "compat"]));
    const mcp = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "text/plain", [header]: "mcp-1" },
      body: "x",
    });
    expect(mcp.headers.get(header)).toBe("mcp-1");
  });

  it("keeps Retry-After on a RATE_LIMITED 429 and adds the id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(failing, { publicCompat: true });
    let limited: Response | undefined;
    for (let i = 0; i < 200 && !limited; i++) {
      const response = await app.request("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.status === 429) limited = response;
    }
    expect(limited).toBeDefined();
    expect(limited!.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(limited!.headers.get(header)).toMatch(generated);
    const body = (await limited!.json()) as ErrorBody;
    expect(body.error.data).toMatchObject({
      code: "rate_limited",
      request_id: limited!.headers.get(header),
    });
  });

  it("negative control: a planted route that writes an error without the id fails the check", async () => {
    const app = createApp(failing);
    app.get("/v1/planted", (c) => c.json({ error: { code: "planted" } }, 400));
    const response = await app.request("/v1/planted");
    expect(() =>
      assertRequestId(response, { error: { code: "planted" } }),
    ).toThrow(/request_id/);
  });

  it("negative control: a mutant that echoes any client id is caught", async () => {
    const source = new URL("../../src/api/request-id.ts", import.meta.url);
    const original = await (
      await import("node:fs/promises")
    ).readFile(source, "utf8");
    await withMutantFile(
      source,
      replaceSyntax(
        original,
        "if (sent && sent.length <= MAX_LENGTH && ACCEPTED.test(sent)) return sent;",
        "if (sent) return sent;",
      ),
      async (temporary) => {
        const mutant = await importMutant<{
          requestIdFor: (v: string) => string;
        }>(temporary, "requestIdFor");
        expect(mutant.requestIdFor("a".repeat(129))).toHaveLength(129);
        expect(mutant.requestIdFor("a".repeat(129))).not.toMatch(generated);
      },
    );
    const { requestIdFor } = await import("../../src/api/request-id.js");
    expect(requestIdFor("a".repeat(129))).toMatch(generated);
  });
});

describe("release facts in /readyz", () => {
  async function migrated() {
    const pg = new PGlite();
    const core = await coreMigrations();
    const db = testDatabase(pg);
    await migrate(db, core.directory);
    const files = await loadMigrations(core.directory);
    const app = createApp(
      db,
      {},
      undefined,
      schemaGate(db, { directory: core.directory }),
    );
    return { pg, core, db, app, files };
  }

  it("answers release, generation, pricing, plan_years and schema when ready, the same in /healthz", async () => {
    const { pg, core, app, files } = await migrated();
    try {
      const ready = await app.request("/readyz");
      expect(ready.status).toBe(200);
      const body = (await ready.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(
        ["status", ...Object.keys(contract.readiness.ready_fields)].sort(),
      );
      expect(body.status).toBe("ready");
      expect(body.release).toBe(applicationVersion);
      expect(body.generation).toMatch(/^[0-9a-f]{32}$/);
      expect(body.pricing).toMatch(/^[0-9a-f]{64}$/);
      expect(body.plan_years).toEqual(
        [...(body.plan_years as number[])].sort((a, b) => a - b),
      );
      expect((body.plan_years as number[]).length).toBeGreaterThan(0);
      expect(body.schema).toBe(files.length);
      const health = (await (await app.request("/healthz")).json()) as Record<
        string,
        unknown
      >;
      expect(health).toMatchObject({ ...body, status: "ok", db: "ok" });
      expect(JSON.stringify(body)).not.toMatch(/\/Users|\/Volumes|localhost|@/);
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  it("negative control: a 503 body never carries the fields", async () => {
    const { pg, core, db } = await migrated();
    try {
      const down = createApp(failing);
      const unready = await down.request("/readyz");
      expect(unready.status).toBe(503);
      const text = JSON.stringify(await unready.json());
      for (const key of Object.keys(contract.readiness.ready_fields))
        expect(text).not.toContain(`"${key}"`);
      const pending = createApp(
        db,
        {},
        undefined,
        schemaGate(db, {
          directory: core.directory,
          plugins: [],
          now: () => 0,
        }),
      );
      await db.exec("DELETE FROM schema_migrations");
      const waiting = await pending.request("/readyz");
      expect(waiting.status).toBe(503);
      const waitingText = JSON.stringify(await waiting.json());
      for (const key of Object.keys(contract.readiness.ready_fields))
        expect(waitingText).not.toContain(`"${key}"`);
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  it("negative control: package.json is read once, not per request", async () => {
    const { pg, core, app } = await migrated();
    try {
      const fs = await import("node:fs");
      const reads = vi.mocked(fs.readFileSync);
      reads.mockClear();
      for (let i = 0; i < 3; i++) await app.request("/readyz");
      expect(
        reads.mock.calls.filter(([file]) =>
          String(file).endsWith("package.json"),
        ),
      ).toHaveLength(0);
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  it("negative control: a release string that differs from package.json fails the contract check", async () => {
    const { pg, core, app } = await migrated();
    try {
      const body = (await (await app.request("/readyz")).json()) as {
        release: string;
      };
      const pkg = JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile(new URL("../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(body.release).toBe(pkg.version);
      expect({ ...body, release: "0.0.0-planted" }.release).not.toBe(
        pkg.version,
      );
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  /** The same database, counting the queries that read the facts. */
  function counted(db: SqlSession) {
    const seen = { manifest: 0, generation: 0, total: 0 };
    const wrapped: SqlSession = {
      ...db,
      query: async (...args: Parameters<SqlSession["query"]>) => {
        const text = String(args[0]);
        seen.total++;
        if (text.includes("NOT LIKE 'handy_lowest_%'")) seen.manifest++;
        if (text.includes("AS generation FROM api_data_generation"))
          seen.generation++;
        return db.query(...args);
      },
    } as SqlSession;
    return { seen, wrapped };
  }

  it("reads the facts once while the data generation holds and again after it changes", async () => {
    const { pg, core, db, files } = await migrated();
    try {
      const { seen, wrapped } = counted(db);
      const app = createApp(
        wrapped,
        {},
        undefined,
        schemaGate(wrapped, { directory: core.directory }),
      );
      const first = (await (await app.request("/readyz")).json()) as Record<
        string,
        unknown
      >;
      expect(first.schema).toBe(files.length);
      const afterFirst = { ...seen };
      for (let i = 0; i < 3; i++) {
        const again = (await (await app.request("/readyz")).json()) as unknown;
        expect(again).toEqual(first);
      }
      await app.request("/healthz");
      // A warm answer is the one probe query: no manifest read, no second generation read.
      expect(seen.manifest).toBe(afterFirst.manifest);
      expect(seen.generation - afterFirst.generation).toBe(4);
      // A publication bumps the generation; the very next answer carries the new facts.
      await db.exec(
        "UPDATE api_data_generation SET revision = revision + 1 WHERE table_name = 'plan'",
      );
      const next = (await (await app.request("/readyz")).json()) as Record<
        string,
        unknown
      >;
      expect(next.generation).not.toBe(first.generation);
      expect(next.pricing).not.toBe(first.pricing);
      expect(seen.manifest).toBe(afterFirst.manifest + 1);
      const health = (await (await app.request("/healthz")).json()) as Record<
        string,
        unknown
      >;
      expect(health).toMatchObject({ ...next, status: "ok", db: "ok" });
      expect(seen.manifest).toBe(afterFirst.manifest + 1);
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  it("negative control: a partial read is answered but never kept", async () => {
    const { pg, core, db } = await migrated();
    try {
      let failManifest = true;
      const flaky: SqlSession = {
        ...db,
        query: async (...args: Parameters<SqlSession["query"]>) => {
          if (
            failManifest &&
            String(args[0]).includes("NOT LIKE 'handy_lowest_%'")
          )
            throw new Error("Synthetic read failure");
          return db.query(...args);
        },
      } as SqlSession;
      const app = createApp(
        flaky,
        {},
        undefined,
        schemaGate(flaky, { directory: core.directory }),
      );
      const partial = (await (await app.request("/readyz")).json()) as {
        pricing: unknown;
      };
      expect(partial.pricing).toBeNull();
      failManifest = false;
      const whole = (await (await app.request("/readyz")).json()) as {
        pricing: unknown;
      };
      expect(whole.pricing).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await pg.close();
      await core.cleanup();
    }
  }, 120000);

  it("negative control: a reader that ignores the generation is caught by the refresh check", async () => {
    const source = new URL("../../src/api/release-facts.ts", import.meta.url);
    const original = await (
      await import("node:fs/promises")
    ).readFile(source, "utf8");
    await withMutantFile(
      source,
      replaceSyntax(
        original,
        'const key = `${generation}:${new Date().getUTCFullYear()}:${applied ?? ""}`;',
        "const key = `${new Date().getUTCFullYear()}`;",
      ),
      async (temporary) => {
        const mutant = await importMutant<{
          releaseFactsReader: typeof releaseFactsReader;
        }>(temporary, "releaseFactsReader");
        const { pg, core, db } = await migrated();
        const bump = () =>
          db.exec(
            "UPDATE api_data_generation SET revision = revision + 1 WHERE table_name = 'plan'",
          );
        const run = async (reader: {
          probe(): Promise<{ generation: string | null }>;
          facts(g: string | null, a: number): Promise<{ pricing: unknown }>;
        }) => {
          const one = await reader.facts((await reader.probe()).generation, 1);
          await bump();
          const two = await reader.facts((await reader.probe()).generation, 1);
          return { one, two };
        };
        try {
          // The planted reader serves the old facts after the change; the real one does not.
          const planted = await run(mutant.releaseFactsReader(db));
          expect(planted.two).toEqual(planted.one);
          const real = await run(releaseFactsReader(db));
          expect(real.two.pricing).not.toBe(real.one.pricing);
        } finally {
          await pg.close();
          await core.cleanup();
        }
      },
    );
  }, 120000);
});
