#!/usr/bin/env node
/** Isolated, network-enabled lane validation. Reuses completed caches; never imports new source bytes into git. */
import { PGlite } from "@electric-sql/pglite";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { migrate, migrationsDirectory } from "../db/migrate.js";
import type { Database } from "../db/database.js";
import { ingestGeocode } from "../ingest/geocode/index.js";
import { dataDirectory } from "../ingest/geocode/census.js";
import { createApp } from "./app.js";
import type { findProviders } from "../services/providers.js";
type ProviderSearchResult = Awaited<ReturnType<typeof findProviders>>;
type ProviderCheckRow = ProviderSearchResult["providers"][number] &
  Record<string, unknown>;
const root = dataDirectory(),
  path = join(root, "provider-pglite-p3d");
const mode = process.argv[2] ?? "check";
if (!["prepare", "geocode", "check"].includes(mode))
  throw new Error("Use prepare, geocode or check");
const temporary = await mkdtemp(join(tmpdir(), "openplans-provider-api-"));
let pg: PGlite | undefined;
try {
  await mkdir(join(root, "reports"), { recursive: true });
  for (const name of await readdir(migrationsDirectory))
    if (name.endsWith(".sql") && name !== "002_postgis.sql") {
      await cp(join(migrationsDirectory, name), join(temporary, name));
    }
  if (mode === "prepare") {
    // Clone first, so earlier lanes' validation databases remain unchanged.
    await cp(join(root, "provider-pglite-p3b"), path, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  pg = new PGlite(path);
  let queryNumber = 0;
  const db: Database = {
    query: async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(
      sql: string,
      args?: unknown[],
    ) => {
      const number = ++queryNumber,
        started = Date.now();
      if (mode === "check")
        console.log(JSON.stringify({ query: number, status: "started" }));
      const result = await pg!.query<Row>(sql, args);
      if (mode === "check")
        console.log(
          JSON.stringify({ query: number, elapsed_ms: Date.now() - started }),
        );
      return result;
    },
    exec: async (sql) => {
      await pg!.exec(sql);
    },
    close: async () => {},
    transaction: (run) =>
      pg!.transaction((tx) =>
        run({
          query: (sql, args) => tx.query(sql, args),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
  };
  await migrate(db, temporary);
  if (mode === "prepare") {
    const geocoded = new PGlite(join(root, "geocode-pglite-p3c"));
    try {
      for (const table of [
        "source",
        "snapshot",
        "zcta_county",
        "zcta_centroid",
        "rating_area",
        "geo_import",
        "npi_provider",
        "npi_address",
        "geocode_attempt",
        "address_point",
      ]) {
        const rows = (await geocoded.query(`SELECT * FROM ${table}`)).rows;
        for (let at = 0; at < rows.length; at += 2000)
          await db.query(
            `INSERT INTO ${table}
          SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb) ON CONFLICT DO NOTHING`,
            [JSON.stringify(rows.slice(at, at + 2000))],
          );
        console.log(JSON.stringify({ copied: table, rows: rows.length }));
      }
    } finally {
      await geocoded.close();
    }
    await db.exec("ANALYZE");
  } else if (mode === "geocode") {
    const report = await ingestGeocode(db, {
      county: "48201",
      source: "qhp_provider_address",
      progress: console.log,
    });
    await writeFile(
      join(root, "reports/p3d-geocode-harris.json"),
      JSON.stringify({ database: path, ...report }, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } else {
    const app = createApp(db, {}),
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No listener");
      const url = `http://127.0.0.1:${address.port}/v1/providers?plan_id=76589TX0010015&year=2026&zip=77030&radius_miles=5&taxonomy=207Q00000X`;
      const response = await fetch(url),
        body = (await response.json()) as ProviderSearchResult;
      if (!response.ok || !body.providers?.length)
        throw new Error(`HTTP check failed: ${response.status}`);
      const result = {
        url,
        status: response.status,
        total: body.total,
        page_size: body.page_size,
        returned: body.providers.length,
        meta: body.meta,
        provider_coverage: body.provider_coverage,
        nearest_5: body.providers
          .slice(0, 5)
          .map((provider: ProviderCheckRow) => ({
            npi: provider.npi,
            record_id: provider.record_id,
            name: provider.name,
            organization_name: provider.organization_name,
            participation: provider.participation,
            scope: provider.participation_scope,
            distance_miles: provider.distance_miles,
            source_updated_at: provider.source_updated_at,
            snapshot_id: provider.snapshot_id,
            network_tier: provider.evidence[0]?.network_tier,
            tier_status: provider.evidence[0]?.tier_status,
            address: provider.addresses[0],
          })),
      };
      await writeFile(
        join(root, "reports/p3d-provider-http.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
} finally {
  await pg?.close();
  await rm(temporary, { recursive: true, force: true });
}
