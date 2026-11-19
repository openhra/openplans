import pg from "pg";
import { describe, expect, it } from "vitest";

// scripts/postgis-tests.sh sets OPENPLANS_POSTGIS_REQUIRED=1 and one database URL per PostGIS
// suite. Those suites fall back to PGlite, or skip, when their URL is unset, so a run that
// requires PostGIS first proves every URL is set and reaches PostGIS.
const urls = [
  "P3D_POSTGIS_URL",
  "P3I_POSTGIS_URL",
  "P3J_POSTGIS_URL",
  "P6K_POSTGIS_URL",
  "P6K2_POSTGIS_URL",
  "GEOCODE_POSTGIS_URL",
  "GEOCODE_CLEANUP_POSTGIS_URL",
  "GEOCODE_MULTISTATE_POSTGIS_URL",
  "WORKER_CONCURRENCY_POSTGRES_URL",
] as const;
const required = process.env.OPENPLANS_POSTGIS_REQUIRED === "1";

describe.runIf(required)("PostGIS suites when PostGIS is required", () => {
  it.each(urls)("%s names a database with PostGIS available", async (name) => {
    const url = process.env[name];
    expect(url, name).toBeTruthy();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query<{ available: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='postgis') AS available",
      );
      expect(rows[0]?.available, name).toBe(true);
    } finally {
      await client.end();
    }
  });
});
