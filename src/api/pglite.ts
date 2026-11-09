#!/usr/bin/env node
/** Developer-only native API/worker runner; requires dev dependencies, never PostGIS. */
import { PGlite } from "@electric-sql/pglite";
import { serve } from "@hono/node-server";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Database } from "../db/database.js";
import { migrate, migrationsDirectory } from "../db/migrate.js";
import { runWorker } from "../worker/commands.js";
import { createApp } from "./app.js";

const path = process.env.OPENPLANS_PGLITE_DIR;
const port = Number(process.env.PORT ?? "3001");
if (
  !path ||
  !isAbsolute(path) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
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
    const pg = new PGlite(path);
    db = {
      query: (sql, args) => pg.query(sql, args),
      exec: async (sql) => {
        await pg.exec(sql);
      },
      close: () => pg.close(),
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
    } else {
      await migrate(db, directory);
      const app = createApp(db);
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
