import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syntheticZip } from "../../fixtures/fetch/generate.mjs";
import { coreMigrations, testDatabase } from "../../pglite.js";
import { runWorker } from "../../../src/worker/commands.js";
import {
  cachedImportFiles,
  IMPORT_KINDS,
  importRows,
} from "../../../src/ingest/puf/import-source.js";

const fixtureDirectory = fileURLToPath(
  new URL("../../fixtures/puf/import/", import.meta.url),
);

describe("PUF acquired-manifest adapter and worker", () => {
  it("streams ZIP members from the newest manifest through the successful CLI path, offline", async () => {
    const directory = await mkdtemp(join(tmpdir(), "openplans-import-cli-"));
    const cache = join(directory, "raw", "cms-exchange-puf");
    const pg = new PGlite(),
      db = testDatabase(pg),
      core = await coreMigrations();
    try {
      await mkdir(cache, { recursive: true });
      const files = [];
      for (const kind of IMPORT_KINDS) {
        const payload = syntheticZip([
          {
            name: `${kind}.csv`,
            body: await readFile(join(fixtureDirectory, `${kind}.csv`), "utf8"),
          },
        ]);
        const sha256 = createHash("sha256").update(payload).digest("hex");
        await mkdir(join(cache, sha256));
        await writeFile(join(cache, sha256, "payload"), payload);
        const url = `https://download.cms.gov/marketplace-puf/2026/${kind}-puf.zip`;
        // Synthetic archive metadata, wrapping unmodified real-cut CSV rows.
        await writeFile(
          join(cache, `${sha256}.meta.json`),
          JSON.stringify({
            sha256,
            url,
            bytes: payload.length,
            fetched_at: "2026-11-07T00:00:00Z",
          }),
        );
        files.push({
          kind,
          year: 2026,
          status: "ok",
          snapshot_id: sha256,
          sha256,
          bytes: payload.length,
          url,
        });
      }
      const manifest = { schema_version: 1, dry_run: false, files };
      await writeFile(
        join(cache, "manifest-2026-01-01.json"),
        JSON.stringify(manifest),
      );
      await writeFile(
        join(cache, "manifest-2026-02-01.json"),
        JSON.stringify(manifest),
      );
      const selected = await cachedImportFiles(directory, 2026);
      expect(selected.manifestPath).toContain("manifest-2026-02-01.json");
      const rows = [];
      for await (const row of importRows(selected.files[0]!)) rows.push(row);
      expect(rows).toHaveLength(4);
      vi.stubEnv("OPENPLANS_DATA_DIR", directory);
      const out: string[] = [],
        errors: string[] = [];
      expect(
        await runWorker(
          ["ingest", "puf", "import", "--year", "2026", "--state", "TX"],
          () => ({ ...db, close: async () => {} }),
          {
            out: (message) => out.push(message),
            error: (message) => errors.push(message),
          },
          core.directory,
        ),
      ).toBe(0);
      expect(JSON.parse(out[0]!).status).toBe("ACTIVE");
      expect(errors).toEqual([]);
      const batchOut: string[] = [];
      expect(
        await runWorker(
          ["ingest", "puf", "import", "--year", "2026", "--all-states"],
          () => ({ ...db, close: async () => {} }),
          {
            out: (message) => batchOut.push(message),
            error: (message) => errors.push(message),
          },
          core.directory,
        ),
      ).toBe(0);
      expect(batchOut.map((message) => JSON.parse(message))).toEqual([
        expect.objectContaining({ state: "TX", status: "ACTIVE" }),
        expect.objectContaining({
          year: 2026,
          passed: true,
          results: [expect.objectContaining({ state: "TX", status: "ACTIVE" })],
        }),
      ]);

      // Negative control: never silently fall back to an older complete publication.
      await writeFile(
        join(cache, "manifest-2026-03-01.json"),
        JSON.stringify({
          ...manifest,
          files: files.filter((file) => file.kind !== "rate"),
        }),
      );
      await expect(cachedImportFiles(directory, 2026)).rejects.toThrow(
        "Incomplete",
      );
      // Negative control: changed archive structure fails closed rather than selecting a shard.
      const multi = syntheticZip([
        { name: "one.csv", body: "header\nvalue\n" },
        { name: "two.csv", body: "header\nvalue\n" },
      ]);
      await writeFile(selected.files[0]!.path, multi);
      await expect(
        (async () => {
          for await (const _row of importRows(selected.files[0]!)) {
            /* consume */
          }
        })(),
      ).rejects.toThrow("single CSV");
    } finally {
      vi.unstubAllEnvs();
      await db.close();
      await core.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
