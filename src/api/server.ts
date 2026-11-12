import { loadConfig } from "../config/index.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { emitApiPluginLoaded, loadApiPlugins } from "../plugins/api.js";
import { openHostDatabase, startHostStorage } from "../plugins/host-storage.js";
import type { StatusHostParts } from "../plugins/status-host.js";

try {
  const config = loadConfig();
  const { port, host } = config.listen;
  // Plugins load first, so a plugin's database provider or blob store can be selected.
  const statusHost: StatusHostParts = {};
  const plugins = await loadApiPlugins({ statusHost });
  startHostStorage(config);
  const db = openHostDatabase(config);
  // Pool waits for the status host view come from this database.
  statusHost.database = db;
  const app = createApp(
    db,
    {
      premiumToken: config.tokens.api?.reveal(),
      publicQuoting: config.public.quoting,
      publicHousehold: config.public.household,
      publicCompat: config.public.compat,
      trustedProxies: [...config.trustProxy],
    },
    plugins.registries
      ? { config, plugins: plugins.registries, store: plugins.cacheStore }
      : { config },
  );
  const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
    console.log(`OpenPlans API listening on port ${port}`);
    // Never awaited by a request, and it cannot throw.
    void emitApiPluginLoaded(
      plugins.plugins,
      () => openHostDatabase(config),
      undefined,
      plugins.subscriptions,
    );
  });
  server.on("error", () => {
    console.error("API listener failed; check PORT availability");
    void db.close().catch(() => {
      process.exitCode = 1;
    });
    process.exitCode = 1;
  });
  const shutdown = () => {
    server.close(() => {
      // Plugins stop first, in reverse load order, then the database closes.
      void plugins
        .teardown()
        .then(() => db.close())
        .catch(() => {
          console.error("API database shutdown failed");
          process.exitCode = 1;
        });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (error) {
  if (
    error instanceof Error &&
    error.message === "PORT must be an integer between 1 and 65535"
  ) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(
    "API startup failed; check PORT, DATABASE_URL, OPENPLANS_COMPAT_KEY_HEADER and OPENPLANS_PUBLIC_QUOTING",
  );
  process.exitCode = 1;
}
