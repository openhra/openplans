import { PGlite } from "@electric-sql/pglite";
import { expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { createApp } from "../../src/api/app.js";
import type { ApiOptions } from "../../src/api/routes.js";
import { migrate } from "../../src/db/migrate.js";
import { ingestGeo } from "../../src/ingest/geo/index.js";
import { importPufs } from "../../src/ingest/puf/import.js";
import { ingestRatingRules } from "../../src/ingest/rating-rules/index.js";
import { coreMigrations, testDatabase } from "../pglite.js";
import { fixtureFiles as geoFiles } from "../ingest/geo/helpers.js";
import { fixtureFiles } from "./helpers.js";

export const TOKEN = "synthetic-api-test-token",
  PLAN = "87226TX0100013";
/** README example: 87226TX0100013, Harris County, age 35, Rating Area 10. */
export const README_CENTS = 52928;

/** Real CMS fixture cuts for TX 2026; no provider or formulary feeds are loaded. */
export async function quoteFixture() {
  const db = testDatabase(new PGlite());
  const directory = await mkdtemp(join(tmpdir(), "openplans-quotes-"));
  const core = await coreMigrations();
  await migrate(db, core.directory);
  await ingestGeo(db, { files: await geoFiles() });
  const report = await importPufs(db, {
    year: 2026,
    state: "TX",
    files: await fixtureFiles(directory),
    dataDir: directory,
  });
  expect(report.status, JSON.stringify(report)).toBe("ACTIVE");
  await ingestRatingRules(db);
  return {
    db,
    async close() {
      await db.close();
      await core.cleanup();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function postJson(
  app: ReturnType<typeof createApp>,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}
export const quoteBody = (extra: Record<string, unknown> = {}) => ({
  year: 2026,
  zip: "77002",
  county: "48201",
  members: [{ age: 35 }],
  plan_ids: [PLAN],
  ...extra,
});
export type { ApiOptions };
