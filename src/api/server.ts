import {
  CalculationWorker,
  installCalculationExecutor,
} from "../services/calculation-executor.js";
import { stopCmsZipPreparation } from "../ingest/geo/cms.js";
import { EnvironmentOnlyKeyError, loadConfig } from "../config/index.js";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { schemaGate } from "./schema-gate.js";
import { emitApiPluginLoaded, loadApiPlugins } from "../plugins/api.js";
import { openHostDatabase, startHostStorage } from "../plugins/host-storage.js";
import { startTelemetry } from "../telemetry/index.js";
import type { StatusHostParts } from "../plugins/status-host.js";
import { servingPolicy, withDataPolicy } from "../services/data-window.js";

let calculationWorker: CalculationWorker | undefined;
try {
  const config = loadConfig();
  if (config.db.provider === "pg" && config.public.quoting) {
    calculationWorker = new CalculationWorker();
    await calculationWorker.start();
    installCalculationExecutor(calculationWorker);
  }
  const { port, host } = config.listen;
  // Plugins load first, so a plugin's database provider or blob store can be selected.
  const statusHost: StatusHostParts = {};
  const plugins = await loadApiPlugins({ statusHost });
  startHostStorage(config);
  const db = openHostDatabase(config);
  // Pool waits for the status host view come from this database.
  statusHost.database = db;
  // Failed warm-ups are evicted; data reads retain their normal validation and refusal.
  if (config.db.provider === "pg")
    await withDataPolicy(config.data, () => servingPolicy(db)).catch(
      () => undefined,
    );
  const telemetry = startTelemetry({
    plugins: plugins.plugins,
    openDatabase: () => openHostDatabase(config),
  });
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
    // The API never migrates. Until `worker migrate` finishes, /readyz and data routes answer 503.
    schemaGate(db, { plugins: plugins.migrations }),
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
    void Promise.resolve(telemetry?.stop())
      .then(() => calculationWorker?.close())
      .then(() => plugins.teardown())
      .then(() => db.close())
      .catch(() => {
        process.exitCode = 1;
      });
    process.exitCode = 1;
  });
  const shutdown = () => {
    stopCmsZipPreparation();
    server.close(() => {
      // Plugins stop first, in reverse load order, then the database closes.
      void Promise.resolve(telemetry?.stop())
        .then(() => calculationWorker?.close())
        .then(() => plugins.teardown())
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
  await calculationWorker?.close();
  if (
    error instanceof EnvironmentOnlyKeyError ||
    (error instanceof Error &&
      error.message === "PORT must be an integer between 1 and 65535")
  ) {
    console.error(error.message);
    process.exit(1);
  }
  console.error(
    "API startup failed; check PORT, DATABASE_URL, OPENPLANS_COMPAT_KEY_HEADER and OPENPLANS_PUBLIC_QUOTING",
  );
  process.exitCode = 1;
}
