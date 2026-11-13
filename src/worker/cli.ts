#!/usr/bin/env node
import { EnvironmentOnlyKeyError, loadConfig } from "../config/index.js";
import type { CoreConfig } from "../config/index.js";
import { openHostDatabase, startHostStorage } from "../plugins/host-storage.js";
import {
  createCoreEvents,
  emitPluginLoaded,
  loadWorkerPlugins,
} from "../plugins/worker.js";
import type { CoreEvents } from "../plugins/worker.js";
import { runWorker } from "./commands.js";

const plugins = await loadWorkerPlugins();
// Under the scheduler, SIGTERM or SIGINT aborts the running command's signal and ends
// `schedule run --loop` after its tick. Other commands keep the default signal handling.
const stop = new AbortController();
if (process.argv[2] === "schedule")
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => stop.abort(new Error(signal)));
// A configuration that does not parse fails inside the command that needs it, as before.
let config: CoreConfig | undefined;
try {
  config = loadConfig();
} catch (error) {
  // A file key that would be ignored stops the worker before any command runs.
  if (error instanceof EnvironmentOnlyKeyError) {
    console.error(error.message);
    process.exit(1);
  }
  config = undefined;
}
if (config) startHostStorage(config);
// Core events need a configured database; without one, commands run as before and emit nothing.
let events: CoreEvents | undefined;
try {
  if (config?.db.connectionString?.reveal()) {
    const configured = config;
    events = createCoreEvents({
      open: () => openHostDatabase(configured),
      subscriptions: plugins.subscriptions,
    });
  }
} catch {
  events = undefined;
}
try {
  // `migrate` may run before the outbox table exists.
  if (process.argv[2] !== "migrate")
    await emitPluginLoaded(events, plugins.plugins);
  // Operator pass-through settings take effect at worker start; `migrate` may run before the
  // record policy tables exist.
  const policyCode =
    process.argv[2] === "migrate" || !plugins.applyPassThroughPolicies
      ? 0
      : await plugins.applyPassThroughPolicies(
          () => openHostDatabase(loadConfig()),
          // stderr: a command's own stdout (backup-args, status) stays parseable.
          {
            out: (message) => console.error(message),
            error: (message) => console.error(message),
          },
        );
  process.exitCode =
    policyCode ||
    (await runWorker(
      process.argv.slice(2),
      (connectionString) => {
        const current = loadConfig();
        return openHostDatabase(
          current,
          connectionString ?? current.db.connectionString?.reveal(),
        );
      },
      {
        out: (message) => console.log(message),
        error: (message) => console.error(message),
      },
      undefined,
      plugins.commands,
      {
        subscriptions: plugins.subscriptions,
        schedules: plugins.schedules,
        run: { signal: stop.signal },
        events,
        migrations: plugins.migrations,
      },
    ));
} finally {
  await events?.close();
  await plugins.teardown();
}
