import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "../db/database.js";

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("PORT must be an integer between 1 and 65535");
  process.exit(1);
}

try {
  const db = createDatabase();
  const app = createApp(db);
  const server = serve(
    { fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" },
    () => {
      console.log(`OpenPlans API listening on port ${port}`);
    },
  );
  server.on("error", () => {
    console.error("API listener failed; check PORT availability");
    void db.close().catch(() => {
      process.exitCode = 1;
    });
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => {
      void db.close().catch(() => {
        console.error("API database shutdown failed");
        process.exitCode = 1;
      });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch {
  console.error(
    "API startup failed; check PORT, DATABASE_URL and OPENPLANS_COMPAT_KEY_HEADER",
  );
  process.exitCode = 1;
}
