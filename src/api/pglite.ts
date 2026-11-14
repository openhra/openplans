#!/usr/bin/env node
import { EnvironmentOnlyKeyError, loadConfig } from "../config/index.js";
/** Developer-only native API/worker runner; requires dev dependencies, never PostGIS. */
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DbProviderFactory } from "@openplans/plugin-sdk";
import type { Database } from "../db/database.js";
import { providerTables, selectDatabase } from "../plugins/providers.js";
import { migrationsDirectory } from "../db/migrate.js";
import { unappliedMigrations } from "../db/schema-ready.js";
import { runWorker } from "../worker/commands.js";
import { createApp } from "./app.js";
import { schemaGate } from "./schema-gate.js";

let config: ReturnType<typeof loadConfig> | undefined;
try {
  config = loadConfig(process.env, undefined, { port: 3001 });
} catch (error) {
  console.error(
    error instanceof EnvironmentOnlyKeyError
      ? error.message
      : "Set an absolute OPENPLANS_PGLITE_DIR and a valid PORT (default 3001)",
  );
  process.exitCode = 1;
}
const path = config?.runners.pgliteDir;
const port = config?.listen.port;
if (!config || port === undefined || !path || !isAbsolute(path)) {
  if (config)
    console.error(
      "Set an absolute OPENPLANS_PGLITE_DIR and a valid PORT (default 3001)",
    );
  process.exitCode = 1;
} else {
  const directory = await mkdtemp(join(tmpdir(), "openplans-api-migrations-"));
  let db: Database | undefined;
  try {
    // Production migrations never skip PostGIS. This portable developer copy does.
    for (const name of await readdir(migrationsDirectory)) {
      if (name.endsWith(".sql") && name !== "002_postgis.sql")
        await cp(join(migrationsDirectory, name), join(directory, name));
    }
    // The developer runner registers `pglite` itself and always selects it.
    const pglite: DbProviderFactory = () => {
      const pg = new PGlite(path);
      const local: Database = {
        query: (sql, args) => pg.query(sql, args),
        exec: async (sql) => {
          await pg.exec(sql);
        },
        close: () => pg.close(),
        withSession: (run) => run(local),
        transaction: (run) =>
          pg.transaction((tx) =>
            run({
              query: (sql, args) => tx.query(sql, args),
              exec: async (sql) => {
                await tx.exec(sql);
              },
            }),
          ),
      };
      return local;
    };
    db = selectDatabase(
      config,
      providerTables(undefined, { dbProviders: { pglite } }),
      "pglite",
    );
    if (process.argv.length > 2) {
      process.exitCode = await runWorker(
        process.argv.slice(2),
        () => ({ ...db!, close: async () => {} }),
        {
          out: (message) => console.log(message),
          error: (message) => console.error(message),
        },
        directory,
      );
    } else if ((await unappliedMigrations(db, directory)).length > 0) {
      // Without this check every data route fails with a 500 on a new database.
      console.error(
        "The PGlite database has unapplied migrations; run `npm run api:pglite -- migrate` first",
      );
      process.exitCode = 1;
    } else {
      const app = createApp(
        db,
        {
          premiumToken: config.tokens.api?.reveal(),
          publicQuoting: config.public.quoting,
          publicHousehold: config.public.household,
          publicCompat: config.public.compat,
          trustedProxies: [...config.trustProxy],
        },
        { config },
        schemaGate(db, { directory }),
      );
      await new Promise<void>((resolve, reject) => {
        const server = serve(
          { fetch: app.fetch, hostname: "127.0.0.1", port },
          () =>
            console.log(`OpenPlans PGlite API listening on 127.0.0.1:${port}`),
        );
        const stop = () => {
          server.close();
        };
        server.once("error", reject);
        server.once("close", () => {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
          resolve();
        });
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    }
  } catch {
    console.error(
      "PGlite API/worker failed; check local database, migrations and configuration",
    );
    process.exitCode = 1;
  } finally {
    await db?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
